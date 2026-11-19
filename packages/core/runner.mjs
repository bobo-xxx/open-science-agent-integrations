import { parseArgs } from 'node:util'
import { loadConfiguration } from './config.mjs'
import { inputError, validateRequest } from './actions.mjs'
import { operate } from './workflow.mjs'

async function readRequest() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 1024 * 1024) throw inputError('Request input exceeds 1 MiB.')
    chunks.push(chunk)
  }
  try {
    return validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw inputError('Send one UTF-8 JSON request on stdin.')
  }
}

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
const { signal } = controller
let request
let envelope
try {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, instance: { type: 'string' },
    'no-start': { type: 'boolean' }, help: { type: 'boolean' }
  } })
  if (values.help) {
    envelope = { ok: true, usage: 'node runner.mjs [--config <absolute-path>] [--instance <id>] < request.json' }
  } else {
    request = await readRequest()
    const configuration = await loadConfiguration(values.config)
    const reply = await operate(configuration, request, {
      instanceId: values.instance, signal
    })
    envelope = { ok: true, ...reply }
  }
} catch (error) {
  const requestId = request?.requestId ?? error.requestId
  const runId = request?.runId ?? error.runId
  envelope = {
    ok: false,
    ...(error.instanceId ? { instanceId: error.instanceId } : {}),
    error: {
      code: signal.aborted ? 'aborted' : (error.code ?? 'integration_error'),
      message: error.message,
      ...(Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
      ...(error.completionStatus ? { completionStatus: error.completionStatus } : {}),
      ...(requestId ? { requestId } : {}),
      ...(runId ? { runId } : {})
    }
  }
  process.exitCode = 1
}
process.stdout.write(`${JSON.stringify(envelope)}\n`)
