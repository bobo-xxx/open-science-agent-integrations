import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { loadConfiguration, selectInstance } from '../packages/core/config.mjs'
import { recordRunId, reserveReceipt } from '../packages/core/receipts.mjs'

const configure = fileURLToPath(new URL('../scripts/configure.mjs', import.meta.url))
const exec = promisify(execFile)

async function fixture(t) {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(temporaryDirectory, 'open-science configuration ')))
  t.after(async () => {
    assert.equal(dirname(root), temporaryDirectory)
    await rm(root, { recursive: true, force: true })
  })

  const stateDirectory = join(root, 'shared receipts')
  const profile = join(root, 'desktop profile')
  const otherProfile = join(root, 'other profile')
  await Promise.all([mkdir(profile), mkdir(otherProfile)])
  const log = join(root, 'cli-status.log')
  const cliScript = join(root, 'fake CLI.mjs')
  await writeFile(cliScript, `
    import { appendFile, readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--version') {
      console.log('1.3.0')
    } else if (args[0] === 'status' && args.includes('--json') && args.includes('--config-root')) {
      const configRoot = args[args.indexOf('--config-root') + 1]
      await appendFile(${JSON.stringify(log)}, JSON.stringify(configRoot) + '\\n')
      const override = await readFile(join(configRoot, 'status.json'), 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error
        return '{}'
      })
      const status = { running: true, appVersion: '1.3.0', configRoot, ...JSON.parse(override) }
      console.log(JSON.stringify(status))
      if (!status.running) process.exitCode = 3
    } else {
      throw new Error('Unexpected CLI command')
    }
  `)

  return {
    root,
    target: join(root, 'config.json'),
    preparedPath: join(root, 'prepared.json'),
    stateDirectory,
    profile,
    otherProfile,
    log,
    cli: { command: process.execPath, args: [cliScript] }
  }
}

const configDocument = value => JSON.stringify(value, null, 2) + '\n'
const backupEntries = async root => (await readdir(root)).filter(name => name.endsWith('.bak'))

test('migrates in place after validating each profile and preserves the existing receipt and backup', async t => {
  const f = await fixture(t)
  const legacyInstance = (configRoot, name) => ({
    configRoot, name, sdkPath: join(f.root, 'old SDK.mjs'),
    launch: { command: process.execPath, preservesFocus: true }
  })
  const original = {
    defaultInstance: 'desktop',
    instances: {
      desktop: legacyInstance(f.profile, 'My desktop'),
      other: legacyInstance(f.otherProfile, 'Other desktop')
    },
    stateDirectory: f.stateDirectory
  }
  const prepared = {
    defaultInstance: 'desktop',
    instances: {
      desktop: { configRoot: f.profile, cli: f.cli },
      other: { configRoot: f.otherProfile, cli: f.cli }
    },
    stateDirectory: f.stateDirectory
  }
  const originalBytes = Buffer.from('\ufeff' + configDocument(original))
  await writeFile(f.target, originalBytes)
  await writeFile(f.preparedPath, configDocument(prepared))
  const binding = selectInstance(await loadConfiguration(f.preparedPath), 'other').binding
  const requestId = 'old-submit'
  await reserveReceipt(f.stateDirectory, { requestId, instanceId: 'other', binding, projectId: 'p1' })
  await recordRunId(f.stateDirectory, requestId, 'old-run')
  const receiptNames = await readdir(f.stateDirectory)
  const before = await Promise.all(receiptNames.map(name => readFile(join(f.stateDirectory, name))))

  const result = await exec(process.execPath, [configure, '--migrate', f.preparedPath, f.target])
  const backups = await backupEntries(f.root)
  assert.equal(backups.length, 1)
  assert.ok(result.stdout.includes(backups[0]))
  assert.deepEqual(await readFile(join(f.root, backups[0])), originalBytes)
  const configuration = await loadConfiguration(f.target)
  assert.equal(configuration.defaultInstance, 'desktop')
  assert.equal(configuration.instances.desktop.name, 'My desktop')
  assert.deepEqual(configuration.instances.desktop.cli, f.cli)
  assert.equal(selectInstance(configuration, 'other').binding, binding)
  assert.equal(configuration.stateDirectory, f.stateDirectory)
  const migrated = JSON.parse(await readFile(f.target, 'utf8'))
  assert.equal(migrated.instances.desktop.sdkPath, undefined)
  assert.equal(migrated.instances.desktop.launch, undefined)
  assert.deepEqual(await readdir(f.stateDirectory), receiptNames)
  assert.deepEqual(await Promise.all(receiptNames.map(name => readFile(join(f.stateDirectory, name)))), before)
  const profiles = (await readFile(f.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(profiles, [await realpath(f.profile), await realpath(f.otherProfile)])
})

test('keeps a legacy configuration when its matching CLI reports the service offline', async t => {
  const f = await fixture(t)
  const original = configDocument({ configRoot: f.profile, sdkPath: join(f.root, 'old.mjs') })
  await writeFile(f.target, original)
  await writeFile(f.preparedPath, configDocument({ configRoot: f.profile, cli: f.cli }))
  await writeFile(join(f.profile, 'status.json'), '{"running":false}')

  await assert.rejects(exec(process.execPath, [configure, '--migrate', f.preparedPath, f.target]), {
    stderr: /Could not validate the CLI for instance default/
  })
  assert.equal(await readFile(f.target, 'utf8'), original)
  assert.deepEqual(await backupEntries(f.root), [])
})

test('rejects changing the legacy profile, instance ID, or receipt directory during migration', async t => {
  const f = await fixture(t)
  const original = configDocument({ configRoot: f.profile, sdkPath: join(f.root, 'old.mjs') })
  await writeFile(f.target, original)
  for (const [prepared, reason] of [
    [{ configRoot: f.otherProfile, cli: f.cli }, /keep the original profile/],
    [{
      defaultInstance: 'new',
      instances: { new: { configRoot: f.profile, cli: f.cli } }
    }, /keep all existing instance IDs/],
    [{
      configRoot: f.profile, cli: f.cli, stateDirectory: f.stateDirectory
    }, /keep the existing receipt directory/]
  ]) {
    await writeFile(f.preparedPath, configDocument(prepared))
    await assert.rejects(exec(process.execPath, [configure, '--migrate', f.preparedPath, f.target]), {
      stderr: reason
    })
  }
  assert.equal(await readFile(f.target, 'utf8'), original)
  assert.deepEqual(await backupEntries(f.root), [])
  await assert.rejects(readFile(f.log), { code: 'ENOENT' })
})

test('migrates a legacy single profile under the original default ID', async t => {
  const f = await fixture(t)
  const original = configDocument({ configRoot: f.profile, sdkPath: join(f.root, 'old.mjs') })
  await writeFile(f.target, original)
  const preparedDirectory = join(f.root, 'config drafts')
  await mkdir(preparedDirectory)
  const preparedPath = join(preparedDirectory, 'config.json')
  await writeFile(preparedPath, configDocument({ configRoot: f.profile, cli: f.cli }))
  await exec(process.execPath, [configure, '--migrate', preparedPath, f.target])
  const configuration = await loadConfiguration(f.target)
  assert.equal(configuration.defaultInstance, 'default')
  assert.deepEqual(Object.keys(configuration.instances), ['default'])
  assert.equal(configuration.stateDirectory, join(f.root, 'receipts'))
})

test('rejects CLI arguments that can override the selected instance', async t => {
  const f = await fixture(t)
  const cli = { command: f.cli.command, args: [...f.cli.args, '--config-root', f.otherProfile] }
  await writeFile(f.target, configDocument({ configRoot: f.profile, cli }))
  await assert.rejects(loadConfiguration(f.target), {
    code: 'invalid_config',
    message: /args must be empty or contain only the absolute CLI entry path/
  })
})

test('fresh configuration keeps receipt storage relative to the destination and refuses replacement', async t => {
  const f = await fixture(t)
  const destination = join(f.root, 'config directory', 'config.json')
  const prepared = configDocument({ configRoot: f.profile, cli: f.cli })
  await writeFile(f.preparedPath, prepared)
  await exec(process.execPath, [configure, f.preparedPath, destination])
  const configuration = await loadConfiguration(destination)
  assert.equal(configuration.stateDirectory, join(dirname(destination), 'receipts'))
  await assert.rejects(exec(process.execPath, [configure, f.preparedPath, destination]), {
    stderr: /destination already exists/
  })
  assert.equal(await readFile(destination, 'utf8'), prepared)
})
