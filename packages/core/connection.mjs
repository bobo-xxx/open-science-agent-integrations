import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { integrationError, loadConfiguration, selectInstance } from './config.mjs'

export { loadConfiguration, selectInstance } from './config.mjs'

const probeTimeoutMs = 15_000
const commandTimeoutMs = 45_000
const maxOutputBytes = 16 * 1024 * 1024

function readJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function cliError(value, exitCode) {
  const detail = value?.error
  if (!detail || typeof detail.code !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/i.test(detail.code) ||
      typeof detail.message !== 'string') return undefined
  const error = integrationError(detail.code, detail.message)
  if (Number.isInteger(exitCode)) error.exitCode = exitCode
  for (const field of ['completionStatus', 'requestId', 'runId']) {
    if (typeof detail[field] === 'string') error[field] = detail[field]
  }
  return error
}

function runCli({ command, args = [] }, argv, { stdin, signal, timeoutMs = commandTimeoutMs } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args, ...argv], {
      encoding: 'utf8',
      maxBuffer: maxOutputBytes,
      shell: false,
      signal,
      timeout: timeoutMs,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(signal.reason)
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        return reject(integrationError('cli_launch_failed', 'Could not run the configured Open Science CLI. Verify its installed executable.'))
      }
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return reject(integrationError('cli_output_too_large', 'Open Science CLI output exceeded the runner limit.'))
      }
      if (error?.killed) {
        return reject(integrationError('cli_timeout', 'The Open Science CLI exceeded the local command deadline. Verify the task status before retrying.'))
      }
      if (error && !Number.isInteger(error.code)) {
        return reject(integrationError('cli_failed', 'Could not complete the Open Science CLI command.'))
      }
      resolve({ stdout, stderr, exitCode: error?.code ?? 0 })
    })
    // The CLI may exit with a structured error before consuming stdin.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin, 'utf8')
  })
}

function parseCliResult({ stdout, stderr, exitCode }, { allowRunResult, allowOfflineStatus }) {
  const result = readJson(stdout)
  if (exitCode !== 0) {
    for (const line of stderr.split(/\r?\n/).reverse()) {
      const error = cliError(readJson(line), exitCode)
      if (error) throw error
    }
    const error = cliError(result, exitCode)
    if (error) throw error
    if (allowOfflineStatus && result?.running === false) return result
    if (allowRunResult && typeof result?.id === 'string' &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status)) return result
    throw Object.assign(integrationError('cli_failed', 'Open Science CLI returned an unsuccessful exit without a structured result.'), { exitCode })
  }
  const error = cliError(result)
  if (error) throw error
  if (result === undefined) {
    throw integrationError('invalid_cli_response', 'Open Science CLI did not return valid JSON.')
  }
  return result
}

export async function connect({ configPath, instanceId, expectedBinding, signal, configuration } = {}) {
  signal?.throwIfAborted()
  const loaded = configuration ?? await loadConfiguration(configPath)
  const instance = selectInstance(loaded, instanceId)
  const { config, binding } = instance
  if (expectedBinding !== undefined && binding !== expectedBinding) {
    throw integrationError('instance_binding_changed', 'The selected instance profile changed. Review the instance configuration before retrying.')
  }

  const versionReply = await runCli(config.cli, ['--version'], { signal, timeoutMs: probeTimeoutMs })
  const version = versionReply.stdout.trim()
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version)
  if (versionReply.exitCode !== 0 || !match || +match[1] < 1 || (+match[1] === 1 && +match[2] < 3)) {
    throw integrationError('incompatible_cli', 'Select the official Open Science CLI from version 1.3.0 or later.')
  }

  const client = async (args, options = {}) => parseCliResult(
    await runCli(config.cli, [...args, '--config-root', config.configRoot, '--json'], { signal, ...options }),
    options
  )
  const status = await client(['status'], { timeoutMs: probeTimeoutMs, allowOfflineStatus: true })
  if (status?.running === false) {
    throw integrationError('daemon_unavailable', 'The selected Open Science instance is offline. Open that desktop instance normally, then try again.')
  }
  if (status?.running !== true || typeof status.configRoot !== 'string' ||
      !isAbsolute(status.configRoot) || typeof status.appVersion !== 'string') {
    throw integrationError('invalid_cli_response', 'Open Science CLI status did not identify the running instance.')
  }
  const reported = selectInstance({
    instances: { [instance.instanceId]: { ...config, configRoot: status.configRoot } }
  }, instance.instanceId)
  if (reported.binding !== binding) {
    throw integrationError('cli_target_mismatch', 'Open Science CLI status reported a different instance profile.')
  }
  if (status.appVersion !== version) {
    throw integrationError('cli_version_mismatch', 'The Open Science CLI version differs from the selected running service. Use the CLI from that desktop installation.')
  }
  client.version = version
  client.status = status
  return { client, ...instance }
}
