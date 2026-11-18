import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { integrationError, loadConfiguration, selectInstance } from './config.mjs'
import { claimInstanceOperation } from './locks.mjs'

export { loadConfiguration, selectInstance } from './config.mjs'

const STARTUP_TIMEOUT_MS = 60_000
const PROBE_INTERVAL_MS = 250

async function loadSdk(sdkPath) {
  let sdk
  try {
    sdk = await import(pathToFileURL(sdkPath).href)
  } catch {
    throw integrationError(
      'sdk_load_failed',
      'Could not load sdkPath. Select the index.mjs shipped with the target Open Science installation.'
    )
  }
  if (typeof sdk.connectToOpenScience !== 'function') {
    throw integrationError('incompatible_sdk', 'The selected SDK lacks connectToOpenScience.')
  }
  return sdk
}

function isOffline(error) {
  // Current SDKs may also use daemon_unavailable for an HTTP error.
  return error?.code === 'daemon_unavailable' && error.status == null
}

function connectionError(error) {
  if (isOffline(error)) {
    return integrationError(
      'daemon_unavailable',
      'The selected Open Science instance is offline. Start that instance, then try again.'
    )
  }
  const status = error?.status
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(error.code)
    ? error.code
    : 'connection_failed'
  const message = status === 401 || status === 403
    ? 'The selected Open Science instance rejected authentication. Check configRoot and the paired SDK.'
    : 'Could not connect to the selected Open Science instance. Check configRoot and SDK compatibility.'
  return integrationError(code, message, status)
}

async function launchApplication({ launch, configRoot }, signal) {
  signal.throwIfAborted()
  let failure
  try {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OPEN_SCIENCE_CONFIG_ROOT: configRoot,
        OPEN_SCIENCE_STORAGE_ROOT: configRoot
      }
    })
    child.on('error', () => {
      failure = integrationError('launch_failed', 'Could not start the configured Open Science launcher.')
    })
    child.once('exit', (code, exitSignal) => {
      if (code !== 0) {
        const reason = exitSignal ?? `exit code ${code}`
        failure = integrationError('launch_failed', `The configured Open Science launcher stopped (${reason}).`)
      }
    })
    child.unref()
    await once(child, 'spawn', { signal })
  } catch {
    signal.throwIfAborted()
    throw integrationError('launch_failed', 'Could not start the configured Open Science launcher.')
  }

  return () => {
    if (failure) throw failure
  }
}

async function claimStartup(binding) {
  try {
    return await claimInstanceOperation(binding, 'start')
  } catch {
    throw integrationError('startup_lock_failed', 'Could not reserve startup for the selected instance. Start that instance manually.')
  }
}

export async function connect({ configPath, instanceId, expectedBinding, start = false, signal, configuration } = {}) {
  signal?.throwIfAborted()
  const instance = selectInstance(configuration ?? await loadConfiguration(configPath), instanceId)
  const { config, binding } = instance
  if (expectedBinding !== undefined && binding !== expectedBinding) {
    throw integrationError('instance_binding_changed', 'The selected instance profile changed. Review the instance configuration before retrying.')
  }
  const sdk = await loadSdk(config.sdkPath)
  const timeout = AbortSignal.timeout(STARTUP_TIMEOUT_MS)
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const probe = async () => {
    probeSignal.throwIfAborted()
    try {
      // The public SDK already performs an authenticated health check during discovery.
      const client = await sdk.connectToOpenScience({ configRoot: config.configRoot, signal: probeSignal })
      probeSignal.throwIfAborted()
      return { client, ...instance }
    } catch (error) {
      probeSignal.throwIfAborted()
      throw connectionError(error)
    }
  }

  try {
    let releaseStartup
    // Waiting callers re-probe rather than guessing whether the instance already started.
    while (true) {
      try {
        return await probe()
      } catch (error) {
        if (!start || !isOffline(error)) throw error
      }
      if (config.launch?.preservesFocus !== true) {
        throw integrationError('manual_start_required', 'Automatic startup needs a focus-verified launcher for this instance. Start the selected instance manually.')
      }
      if (process.platform !== 'win32' && process.platform !== 'linux') {
        throw integrationError('manual_start_required', 'Automatic startup is unavailable on this platform. Start the selected instance manually.')
      }
      releaseStartup = await claimStartup(binding)
      if (releaseStartup) break
      await sleep(PROBE_INTERVAL_MS, undefined, { signal: probeSignal })
    }

    try {
      try {
        return await probe()
      } catch (error) {
        if (!isOffline(error)) throw error
      }
      const checkLauncher = await launchApplication(config, probeSignal)
      while (true) {
        checkLauncher()
        try {
          return await probe()
        } catch (error) {
          if (!isOffline(error)) throw error
        }
        await sleep(PROBE_INTERVAL_MS, undefined, { signal: probeSignal })
      }
    } finally {
      releaseStartup()
    }
  } catch (error) {
    signal?.throwIfAborted()
    if (timeout.aborted) {
      throw integrationError(
        'startup_timeout',
        'The selected Open Science instance was not reachable within 60 seconds. Check the configured launcher and profile.'
      )
    }
    throw error
  }
}
