import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path'

export function integrationError(code, message, status) {
  const error = new Error(message)
  error.name = 'OpenScienceIntegrationError'
  error.code = code
  if (Number.isInteger(status)) error.status = status
  return error
}

function configError(message) {
  return integrationError('invalid_config', message)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInstanceId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
}

export function absolutePath(value, field) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw configError(`${field} must be an absolute path.`)
  }
  if (process.platform === 'win32' && /^[\\/]$/.test(parse(value).root)) {
    throw configError(`${field} must include a drive or UNC share.`)
  }
  return normalize(value)
}

function onlyFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw configError(`Unknown ${label} field: ${field}.`)
  }
}

function normalizeCli(value, field) {
  if (!isObject(value)) throw configError(`${field} must be a JSON object.`)
  onlyFields(value, ['command', 'args'], field)
  const command = absolutePath(value.command, `${field}.command`)
  if (process.platform === 'win32' && extname(command).toLowerCase() !== '.exe') {
    throw configError(`${field}.command must point to an .exe on Windows, such as node.exe.`)
  }
  const args = value.args === undefined ? [] : value.args
  if (!Array.isArray(args) || args.length > 1) {
    throw configError(`${field}.args must be empty or contain only the absolute CLI entry path.`)
  }
  if (args.length === 0) return { command, args: [] }
  const entry = absolutePath(args[0], `${field}.args[0]`)
  if (extname(entry).toLowerCase() !== '.mjs') {
    throw configError(`${field}.args[0] must point to the CLI's .mjs entry file.`)
  }
  return { command, args: [entry] }
}

export function normalizeInstanceIdentity(value, prefix) {
  const config = { configRoot: absolutePath(value.configRoot, `${prefix}configRoot`) }
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) {
      throw configError(`${prefix}name must be a nonempty string of at most 120 characters.`)
    }
    config.name = value.name.trim()
  }
  return config
}

function normalizeInstance(value, prefix) {
  if (!Object.hasOwn(value, 'cli')) {
    throw configError(`${prefix}cli is required. Migrate an existing configuration with npm run configure -- --migrate <prepared-config.json>.`)
  }
  onlyFields(value, ['name', 'configRoot', 'cli'], 'instance')
  return { ...normalizeInstanceIdentity(value, prefix), cli: normalizeCli(value.cli, `${prefix}cli`) }
}

export function resolveConfigPath(configPath) {
  return resolve(
    configPath ?? process.env.OPEN_SCIENCE_INTEGRATIONS_CONFIG ??
    join(homedir(), '.open-science-agent-integrations', 'config.json')
  )
}

export function parseConfiguration(source, path, readInstance = normalizeInstance) {
  let parsed
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch {
    throw configError('Open-Science integration config must be valid JSON.')
  }
  if (!isObject(parsed)) throw configError('Open-Science integration config must be a JSON object.')

  const stateDirectory = parsed.stateDirectory === undefined
    ? join(dirname(path), 'receipts')
    : absolutePath(parsed.stateDirectory, 'stateDirectory')
  if (!Object.hasOwn(parsed, 'instances')) {
    const { stateDirectory: _, ...instance } = parsed
    return { defaultInstance: 'default', instances: { default: readInstance(instance, '') }, stateDirectory }
  }
  if (!isObject(parsed.instances) || Object.keys(parsed.instances).length === 0) {
    throw configError('instances must be a nonempty JSON object.')
  }
  onlyFields(parsed, ['defaultInstance', 'instances', 'stateDirectory'], 'configuration')
  const instances = Object.create(null)
  for (const [id, instance] of Object.entries(parsed.instances)) {
    if (!isInstanceId(id)) {
      throw configError('Instance IDs must be 1–64 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.')
    }
    if (!isObject(instance)) throw configError(`instances.${id} must be a JSON object.`)
    instances[id] = readInstance(instance, `instances.${id}.`)
  }
  if (!isInstanceId(parsed.defaultInstance) || !Object.hasOwn(instances, parsed.defaultInstance)) {
    throw configError('defaultInstance must name one of the configured instances.')
  }
  return { defaultInstance: parsed.defaultInstance, instances, stateDirectory }
}

export async function readConfigurationSource(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw integrationError('config_not_found', `Open-Science integration config is missing: ${path}`)
    }
    throw configError(`Could not read the Open-Science integration config: ${path}`)
  }
}

export async function loadConfiguration(configPath) {
  const path = resolveConfigPath(configPath)
  return parseConfiguration(await readConfigurationSource(path), path)
}

function physicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch (error) {
    const parent = dirname(path)
    if ((error.code !== 'ENOENT' && error.code !== 'ENOTDIR') || parent === path) {
      // No safe physical identity is available. A lexical fallback could reuse a receipt
      // after a mounted volume or an inaccessible junction is exchanged.
      throw integrationError('instance_binding_unavailable', 'Could not resolve the selected instance profile path.')
    }
    // An existing link with no physical destination must never become a lexical binding.
    let entry
    try {
      entry = lstatSync(path, { throwIfNoEntry: false })
    } catch (entryError) {
      if (entryError.code !== 'ENOENT' && entryError.code !== 'ENOTDIR') {
        throw integrationError('instance_binding_unavailable', 'Could not inspect the selected instance profile path.')
      }
    }
    if (entry) {
      throw integrationError('instance_binding_unavailable', 'The selected instance profile path has no available destination.')
    }
    return join(physicalPath(parent), basename(path))
  }
}

function canonicalProfileRoot(configRoot) {
  const physical = normalize(physicalPath(configRoot))
  return physical !== parse(physical).root && physical.endsWith(sep)
    ? physical.slice(0, -1)
    : physical
}

export function selectInstance(configuration, id = configuration.defaultInstance) {
  if (!isInstanceId(id) || !Object.hasOwn(configuration.instances, id)) {
    throw integrationError('instance_not_found', 'The requested Open-Science instance is not configured. List the configured instances and select its ID.')
  }
  const configured = configuration.instances[id]
  const configRoot = canonicalProfileRoot(configured.configRoot)
  const key = process.platform === 'win32' ? configRoot.toLowerCase() : configRoot
  const binding = createHash('sha256').update(key).digest('hex')
  return { instanceId: id, config: { ...configured, configRoot }, binding }
}
