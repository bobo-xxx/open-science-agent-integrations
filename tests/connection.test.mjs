import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { connect, loadConfiguration, selectInstance } from '../packages/core/connection.mjs'

const execFileAsync = promisify(execFile)

async function fixture(t, sdkSource, configValue = {}) {
  const root = await mkdtemp(join(tmpdir(), 'open-science integration #'))
  t.after(async () => {
    const owned = await realpath(root)
    assert.equal(dirname(owned), await realpath(tmpdir()))
    await rm(owned, { force: true, recursive: true })
  })
  const configPath = join(root, 'config.json')
  const sdkPath = join(root, 'sdk.mjs')
  const configRoot = join(root, 'isolated profile')
  const config = { sdkPath, configRoot, ...configValue }
  await writeFile(sdkPath, sdkSource)
  await writeFile(configPath, JSON.stringify(config))
  return { root, config, configPath }
}

test('connects only to the explicitly configured profile using the selected SDK file', async t => {
  const { configPath, config } = await fixture(t, `
    export function connectToOpenScience(options) {
      return { connectedRoot: options.configRoot, signalPresent: !!options.signal };
    }
  `)
  const result = await connect({ configPath })
  assert.deepEqual(result.config, config)
  assert.equal(result.instanceId, 'default')
  assert.match(result.binding, /^[a-f0-9]{64}$/)
  assert.deepEqual(result.client, { connectedRoot: config.configRoot, signalPresent: true })
})

test('selects named instances explicitly and never retries an offline instance against the default', async t => {
  const { root, config, configPath } = await fixture(t, `
    export function connectToOpenScience({ configRoot }) {
      if (configRoot.endsWith('offline')) {
        throw Object.assign(new Error('offline'), { code: 'daemon_unavailable' });
      }
      return { configRoot };
    }
  `)
  const second = { sdkPath: config.sdkPath, configRoot: join(root, 'offline'), name: 'Other instance' }
  await writeFile(configPath, JSON.stringify({
    defaultInstance: 'dev', instances: { dev: config, other: second }
  }))
  const configuration = await loadConfiguration(configPath)
  assert.equal(configuration.stateDirectory, join(root, 'receipts'))
  assert.equal(selectInstance(configuration).instanceId, 'dev')
  const offline = selectInstance(configuration, 'other')
  assert.equal(offline.config.name, 'Other instance')
  assert.notEqual(offline.binding, selectInstance(configuration, 'dev').binding)
  assert.deepEqual((await connect({ configuration })).client, { configRoot: config.configRoot })
  await assert.rejects(connect({ configuration, instanceId: 'other' }), { code: 'daemon_unavailable' })
  await assert.rejects(connect({ configuration, instanceId: 'typo' }), { code: 'instance_not_found' })
})

test('retains the binding across a profile alias and SDK upgrade but detects a profile rebind', async t => {
  const { root, config, configPath } = await fixture(t, '')
  const linkedRoot = join(root, 'profile link')
  const nextRoot = join(root, 'different profile')
  await mkdir(config.configRoot)
  await mkdir(nextRoot)
  await symlink(config.configRoot, linkedRoot, 'junction')
  const selected = selectInstance(await loadConfiguration(configPath))
  await writeFile(configPath, JSON.stringify({
    ...config, configRoot: linkedRoot, sdkPath: join(root, 'new-sdk.mjs')
  }))
  const configuration = await loadConfiguration(configPath)
  const viaLink = selectInstance(configuration)
  assert.equal(viaLink.binding, selected.binding)
  assert.equal(viaLink.config.configRoot, await realpath(config.configRoot))

  await unlink(linkedRoot)
  await symlink(nextRoot, linkedRoot, 'junction')
  assert.notEqual(selectInstance(configuration).binding, selected.binding)
  // The SDK path is intentionally missing, so the mismatch must be reported before SDK loading.
  await assert.rejects(connect({ configuration, expectedBinding: selected.binding }), {
    code: 'instance_binding_changed'
  })
})

test('rejects relative SDK and profile paths before loading any SDK', async t => {
  for (const field of ['sdkPath', 'configRoot']) {
    const { configPath } = await fixture(t, 'throw new Error("SDK must not be loaded")', {
      [field]: 'relative/path'
    })
    await assert.rejects(connect({ configPath }), {
      code: 'invalid_config',
      message: `${field} must be an absolute path.`
    })
  }
})

test('does not launch on HTTP authentication failure reported as daemon_unavailable', async t => {
  const { configPath } = await fixture(t, `
    export function connectToOpenScience() {
      throw Object.assign(new Error('sensitive local secret'), {
        code: 'daemon_unavailable', status: 401
      });
    }
  `, { launch: { command: join(tmpdir(), 'must-not-start.exe'), preservesFocus: true } })
  await assert.rejects(connect({ configPath, start: true }), error => {
    assert.equal(error.code, 'daemon_unavailable')
    assert.equal(error.status, 401)
    assert.match(error.message, /rejected authentication/i)
    assert.doesNotMatch(String(error), /sensitive local secret/)
    return true
  })
})

test('a configured launcher is opt-in and skips launch when the instance is reachable', async t => {
  const { configPath } = await fixture(t, `
    export function connectToOpenScience() {
      if (process.env.OPEN_SCIENCE_TEST_REACHABLE === 'yes') return { connected: true };
      throw Object.assign(new Error('offline'), { code: 'daemon_unavailable' });
    }
  `, { launch: { command: join(tmpdir(), 'must-not-start.exe') } })
  await assert.rejects(connect({ configPath }), { code: 'daemon_unavailable' })
  await assert.rejects(connect({ configPath, start: true }), { code: 'manual_start_required' })
  const original = process.env.OPEN_SCIENCE_TEST_REACHABLE
  t.after(() => {
    if (original === undefined) delete process.env.OPEN_SCIENCE_TEST_REACHABLE
    else process.env.OPEN_SCIENCE_TEST_REACHABLE = original
  })
  process.env.OPEN_SCIENCE_TEST_REACHABLE = 'yes'
  assert.deepEqual((await connect({ configPath, start: true })).client, { connected: true })
})

test('two processes share one focus-certified startup attempt for the selected profile', {
  skip: process.platform !== 'win32' && process.platform !== 'linux'
}, async t => {
  const { root, config, configPath } = await fixture(t, `
    import { readFile } from 'node:fs/promises';
    export async function connectToOpenScience({ configRoot }) {
      try {
        const launchedRoot = await readFile(new URL('ready.txt', import.meta.url), 'utf8');
        return { configRoot, launchedRoot };
      } catch {
        throw Object.assign(new Error('offline'), { code: 'daemon_unavailable' });
      }
    }
  `)
  const launcher = join(root, 'launch.mjs')
  const launchesFile = join(root, 'launches.txt')
  const readyFile = join(root, 'ready.txt')
  await writeFile(launcher, `
    import { appendFile, rename, writeFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    await appendFile(process.argv[2], 'launch\\n');
    await setTimeout(600);
    const temporary = process.argv[3] + '.tmp';
    await writeFile(temporary, process.env.OPEN_SCIENCE_CONFIG_ROOT);
    await rename(temporary, process.argv[3]);
  `)
  await writeFile(configPath, JSON.stringify({
    ...config,
    launch: { command: process.execPath, args: [launcher, launchesFile, readyFile], cwd: root, preservesFocus: true }
  }))

  const check = join(root, 'check.mjs')
  await writeFile(check, `
    import { connect } from ${JSON.stringify(new URL('../packages/core/connection.mjs', import.meta.url).href)};
    const result = await connect({ configPath: process.argv[2], start: true });
    console.log(JSON.stringify(result.client));
  `)
  const results = await Promise.all(Array.from({ length: 2 }, () =>
    execFileAsync(process.execPath, [check, configPath], { windowsHide: true, timeout: 10000 })
  ))
  for (const { stdout } of results) {
    assert.deepEqual(JSON.parse(stdout), { configRoot: config.configRoot, launchedRoot: config.configRoot })
  }
  assert.equal(await readFile(launchesFile, 'utf8'), 'launch\n')
})

test('surfaces launcher errors without waiting for a startup timeout', {
  skip: process.platform !== 'win32' && process.platform !== 'linux'
}, async t => {
  const { root, config, configPath } = await fixture(t, `
    export function connectToOpenScience() {
      throw Object.assign(new Error('offline'), { code: 'daemon_unavailable' });
    }
  `)
  await writeFile(configPath, JSON.stringify({
    ...config,
    launch: { command: join(root, 'no-such-launcher.exe'), preservesFocus: true }
  }))
  await assert.rejects(connect({ configPath, start: true }), { code: 'launch_failed' })
})

test('a cancelled request never starts an application', async t => {
  const { configPath } = await fixture(t, `
    export function connectToOpenScience() {
      throw Object.assign(new Error('offline'), { code: 'daemon_unavailable' });
    }
  `, { launch: { command: join(tmpdir(), 'must-not-start.exe') } })
  const controller = new AbortController()
  const reason = new Error('cancelled by caller')
  controller.abort(reason)
  await assert.rejects(connect({ configPath, start: true, signal: controller.signal }), reason)
})
