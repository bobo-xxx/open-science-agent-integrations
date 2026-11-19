import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { connect } from '../packages/core/connection.mjs'
import {
  absolutePath,
  normalizeInstanceIdentity,
  parseConfiguration,
  resolveConfigPath,
  selectInstance
} from '../packages/core/config.mjs'
import { claimInstanceOperation } from '../packages/core/locks.mjs'

function legacyInstance(instance, prefix) {
  if (Object.hasOwn(instance, 'cli')) throw new Error('The existing configuration already has a CLI entry.')
  absolutePath(instance.sdkPath, `${prefix}sdkPath`)
  return normalizeInstanceIdentity(instance, prefix)
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function prepareMigration(original, replacement, target) {
  const previous = parseConfiguration(original, target, legacyInstance)
  const prepared = parseConfiguration(replacement, target)
  const previousIds = Object.keys(previous.instances)
  if (previousIds.length !== Object.keys(prepared.instances).length ||
      previousIds.some(id => !Object.hasOwn(prepared.instances, id))) {
    throw new Error('Migration must keep all existing instance IDs.')
  }
  if (previous.defaultInstance !== prepared.defaultInstance) {
    throw new Error('Migration must keep the existing default instance.')
  }
  if (pathKey(previous.stateDirectory) !== pathKey(prepared.stateDirectory)) {
    throw new Error('Migration must keep the existing receipt directory.')
  }

  const instances = Object.create(null)
  const targets = []
  for (const id of previousIds) {
    const existing = selectInstance(previous, id)
    const candidate = selectInstance(prepared, id)
    if (existing.binding !== candidate.binding) {
      throw new Error(`Migration must keep the original profile for ${id}.`)
    }
    instances[id] = { ...previous.instances[id], cli: candidate.config.cli }
    targets.push({ instanceId: id, binding: existing.binding })
  }
  const document = {
    defaultInstance: previous.defaultInstance,
    stateDirectory: previous.stateDirectory,
    instances
  }
  return { document, targets }
}

async function writeMigrationFile(path, content) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function migrateConfiguration(replacement, target) {
  const destination = await realpath(target)
  const lockId = createHash('sha256').update(pathKey(destination)).digest('hex')
  const release = await claimInstanceOperation(lockId, 'configuration')
  if (!release) throw new Error('Another process is migrating this configuration.')

  try {
    const original = await readFile(destination)
    const { document: next, targets } = prepareMigration(original.toString('utf8'), replacement, target)
    const document = JSON.stringify(next, null, 2) + '\n'
    const configuration = parseConfiguration(document, target)
    for (const { instanceId, binding } of targets) {
      try {
        await connect({ configuration, instanceId, expectedBinding: binding })
      } catch (error) {
        throw new Error(`Could not validate the CLI for instance ${instanceId}: ${error.message}`)
      }
    }
    const transactionId = randomUUID()
    const temporary = `${destination}.${transactionId}.tmp`
    const backup = `${destination}.pre-cli-${transactionId}.bak`
    try {
      await writeMigrationFile(temporary, document)
      if (pathKey(await realpath(target)) !== pathKey(destination) ||
          !(await readFile(destination)).equals(original)) {
        throw new Error('The existing configuration changed during validation. Retry the migration.')
      }
      for (const { instanceId, binding } of targets) {
        if (selectInstance(configuration, instanceId).binding !== binding) {
          throw new Error(`Profile for instance ${instanceId} changed during validation.`)
        }
      }
      await writeMigrationFile(backup, original)
      await rename(temporary, destination)
    } finally {
      await unlink(temporary).catch(() => {})
    }
    return { backup, defaultInstance: next.defaultInstance }
  } finally {
    release()
  }
}

try {
  const args = process.argv.slice(2)
  const migrate = args[0] === '--migrate'
  const [source, destination, ...extra] = migrate ? args.slice(1) : args
  if (!source || extra.length) {
    throw new Error('Usage: npm run configure -- [--migrate] <prepared-config.json> [destination.json]')
  }
  const target = resolveConfigPath(destination)
  const replacement = await readFile(resolve(source), 'utf8')
  if (migrate) {
    const { backup, defaultInstance } = await migrateConfiguration(replacement, target)
    console.log(`Migrated ${target} with default instance ${defaultInstance}. Backup: ${backup}`)
  } else {
    const { defaultInstance } = parseConfiguration(replacement, target)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, replacement, { flag: 'wx', mode: 0o600 })
    console.log(`Created ${target} with default instance ${defaultInstance}.`)
  }
} catch (error) {
  console.error(error.code === 'EEXIST'
    ? 'The destination already exists. Edit the existing configuration to update its instances.'
    : error.message)
  process.exitCode = 1
}
