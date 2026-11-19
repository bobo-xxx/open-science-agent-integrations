import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { connect, loadConfiguration, selectInstance } from '../packages/core/connection.mjs'

async function fixture(t, settings = {}) {
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'open-science CLI #'))
  t.after(async () => {
    const owned = await realpath(root)
    assert.equal(dirname(owned), temporaryRoot)
    await rm(owned, { recursive: true, force: true })
  })

  const cliPath = join(root, 'fake cli.mjs')
  const configPath = join(root, 'config.json')
  const commandsPath = join(root, 'calls.jsonl')
  const configRoot = join(root, 'official profile')
  const otherRoot = join(root, 'offline profile')
  const config = { configRoot, cli: { command: process.execPath, args: [cliPath] } }
  const saveConfig = configValue => writeFile(configPath, JSON.stringify(configValue))
  await Promise.all([
    mkdir(configRoot),
    mkdir(otherRoot),
    saveConfig({
      defaultInstance: 'installed',
      instances: { installed: config, other: { ...config, configRoot: otherRoot } }
    }),
    writeFile(cliPath, `
      import { appendFile } from 'node:fs/promises'
      import { setTimeout } from 'node:timers/promises'
      const settings = ${JSON.stringify(settings)}
      const args = process.argv.slice(2)
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      const stdin = Buffer.concat(chunks).toString('utf8')
      await appendFile(${JSON.stringify(commandsPath)}, JSON.stringify({ args, stdin }) + '\\n')
      if (args[0] === '--version') {
        console.log(settings.cliVersion ?? '1.3.0')
      } else if (args[0] === 'status') {
        const configRoot = args[args.indexOf('--config-root') + 1]
        if (configRoot.includes('offline profile')) {
          console.log(JSON.stringify({ running: false }))
          process.exitCode = 3
        } else if (settings.unreachable) {
          console.log(JSON.stringify({ running: null, status: 'unreachable', configRoot }))
          process.exitCode = 1
        } else {
          console.log(JSON.stringify({
            running: true,
            configRoot: settings.reportedRoot ?? configRoot,
            appVersion: settings.appVersion ?? '1.3.0'
          }))
        }
      } else if (args[0] === 'structured-error') {
        console.error('Non-JSON warning')
        console.error(JSON.stringify({
          error: { code: 'submission_not_found', message: 'Submission missing', requestId: 'saved-id', completionStatus: 'unconfirmed' },
          exitCode: 1
        }))
        process.exitCode = 1
      } else if (args[0] === 'failed-run') {
        console.log(JSON.stringify({ id: 'run-id', status: 'failed', error: 'Provider failed' }))
        process.exitCode = 1
      } else if (args[0] === 'slow') {
        await setTimeout(5000)
      } else {
        console.log(JSON.stringify({ args, stdin }))
      }
    `)
  ])
  const calls = async () => (await readFile(commandsPath, 'utf8')).trim().split('\n').map(JSON.parse)
  return { root, config, configPath, configRoot, otherRoot, saveConfig, calls }
}

test('invokes the selected official CLI with explicit profile, argv and UTF-8 stdin', async t => {
  const { configPath, configRoot, calls } = await fixture(t)
  const { client, instanceId } = await connect({ configPath })
  const prompt = '结果 (draft) & review'
  assert.equal(instanceId, 'installed')
  assert.equal(client.version, '1.3.0')
  assert.equal(client.status.configRoot, configRoot)
  assert.deepEqual(await client(['run', '--project', 'Project & review'], { stdin: prompt }), {
    args: ['run', '--project', 'Project & review', '--config-root', configRoot, '--json'],
    stdin: prompt
  })
  assert.deepEqual((await calls()).map(call => call.args[0]), ['--version', 'status', 'run'])
})

test('an offline target uses only its scoped status command and asks for desktop startup', async t => {
  const { configPath, otherRoot, calls } = await fixture(t)
  await assert.rejects(connect({ configPath, instanceId: 'other' }), { code: 'daemon_unavailable' })
  await assert.rejects(connect({ configPath, instanceId: 'typo' }), { code: 'instance_not_found' })
  assert.deepEqual(await calls(), [
    { args: ['--version'], stdin: '' },
    { args: ['status', '--config-root', otherRoot, '--json'], stdin: '' }
  ])
})

test('distinguishes a live but unresponsive service from an offline instance', async t => {
  const { configPath, configRoot, calls } = await fixture(t, { unreachable: true })
  await assert.rejects(connect({ configPath }), { code: 'daemon_unreachable' })
  assert.deepEqual((await calls()).map(call => call.args), [
    ['--version'], ['status', '--config-root', configRoot, '--json']
  ])
})

test('rejects stale CLI commands and service version mismatches', async t => {
  const stale = await fixture(t, { cliVersion: '0.1.0' })
  await assert.rejects(connect({ configPath: stale.configPath }), { code: 'incompatible_cli' })
  assert.deepEqual((await stale.calls()).map(call => call.args[0]), ['--version'])

  const mismatch = await fixture(t, { appVersion: '1.3.1' })
  await assert.rejects(connect({ configPath: mismatch.configPath }), { code: 'cli_version_mismatch' })
})

test('rejects a CLI status that resolves to another profile', async t => {
  const { configPath } = await fixture(t, { reportedRoot: await realpath(tmpdir()) })
  await assert.rejects(connect({ configPath }), { code: 'cli_target_mismatch' })
})

test('keeps a physical profile binding through an alias and detects a rebind', async t => {
  const { root, config, configPath, otherRoot, saveConfig } = await fixture(t)
  const link = join(root, 'profile link')
  await symlink(config.configRoot, link, 'junction')
  const selected = selectInstance(await loadConfiguration(configPath))
  await saveConfig({
    defaultInstance: 'installed',
    instances: { installed: { ...config, configRoot: link } }
  })
  const configuration = await loadConfiguration(configPath)
  assert.equal((await connect({ configuration })).binding, selected.binding)
  await unlink(link)
  await symlink(otherRoot, link, 'junction')
  await assert.rejects(connect({ configuration, expectedBinding: selected.binding }), {
    code: 'instance_binding_changed'
  })
})

test('preserves structured CLI errors and opt-in terminal Run results', async t => {
  const { configPath } = await fixture(t)
  const { client } = await connect({ configPath })
  await assert.rejects(client(['structured-error']), {
    code: 'submission_not_found',
    exitCode: 1,
    requestId: 'saved-id',
    completionStatus: 'unconfirmed'
  })
  await assert.rejects(client(['failed-run']), { code: 'cli_failed' })
  assert.deepEqual(await client(['failed-run'], { allowRunResult: true }), {
    id: 'run-id', status: 'failed', error: 'Provider failed'
  })
})

test('bounds the local child command and honors cancellation before launching', async t => {
  const { configPath } = await fixture(t)
  const controller = new AbortController()
  const reason = new Error('cancelled by caller')
  controller.abort(reason)
  await assert.rejects(connect({ configPath, signal: controller.signal }), reason)
  const { client } = await connect({ configPath })
  await assert.rejects(client(['slow'], { timeoutMs: 100 }), { code: 'cli_timeout' })
})
