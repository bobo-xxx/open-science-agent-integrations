import { parseArgs } from 'node:util'
import { loadConfiguration } from './connection.mjs'
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
    start: { type: 'boolean' }, 'no-start': { type: 'boolean' }, help: { type: 'boolean' }
  } })
  if (values.help) {
    envelope = { ok: true, usage: 'node runner.mjs [--config <absolute-path>] [--instance <id>] [--no-start] < request.json' }
  } else {
    if (values.start && values['no-start']) throw inputError('Choose either --start or --no-start.')
    request = await readRequest()
    const configuration = await loadConfiguration(values.config)
    const reply = await operate(configuration, request, {
      instanceId: values.instance, start: !values['no-start'], signal
    })
    envelope = { ok: true, ...reply }
  }
} catch (error) {
  envelope = {
    ok: false,
    error: {
      code: signal.aborted ? 'aborted' : (error.code ?? 'integration_error'),
      message: error.message,
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(request?.requestId ? { requestId: request.requestId } : {}),
      ...(request?.runId ? { runId: request.runId } : {})
    }
  }
  process.exitCode = 1
}
process.stdout.write(`${JSON.stringify(envelope)}\n`)
