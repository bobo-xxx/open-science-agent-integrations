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

function absolutePath(value, field) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw configError(`${field} must be an absolute path.`)
  }
  if (process.platform === 'win32' && /^[\\/]$/.test(parse(value).root)) {
    throw configError(`${field} must include a drive or UNC share.`)
  }
  return normalize(value)
}

function normalizeLaunch(value, field) {
  if (!isObject(value)) throw configError(`${field} must be a JSON object.`)
  const command = absolutePath(value.command, `${field}.command`)
  if (process.platform === 'win32' && extname(command).toLowerCase() !== '.exe') {
    throw configError(`${field}.command must point to an .exe on Windows, such as node.exe.`)
  }
  const args = value.args === undefined ? [] : value.args
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
    throw configError(`${field}.args must be an array of strings.`)
  }
  if (value.preservesFocus !== undefined && typeof value.preservesFocus !== 'boolean') {
    throw configError(`${field}.preservesFocus must be a boolean.`)
  }
  const cwd = value.cwd === undefined ? undefined : absolutePath(value.cwd, `${field}.cwd`)
  return { command, args, preservesFocus: value.preservesFocus === true, ...(cwd && { cwd }) }
}

function normalizeInstance(value, prefix = '') {
  if (!isObject(value)) throw configError(`${prefix.slice(0, -1)} must be a JSON object.`)
  const config = {
    sdkPath: absolutePath(value.sdkPath, `${prefix}sdkPath`),
    configRoot: absolutePath(value.configRoot, `${prefix}configRoot`)
  }
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) {
      throw configError(`${prefix}name must be a nonempty string of at most 120 characters.`)
    }
    config.name = value.name.trim()
  }
  if (value.launch !== undefined) config.launch = normalizeLaunch(value.launch, `${prefix}launch`)
  return config
}

export async function loadConfiguration(configPath) {
  const path = resolve(
    configPath ?? process.env.OPEN_SCIENCE_INTEGRATIONS_CONFIG ??
    join(homedir(), '.open-science-agent-integrations', 'config.json')
  )
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw integrationError('config_not_found', `Open Science integration config is missing: ${path}`)
    }
    throw configError(`Could not read the Open Science integration config: ${path}`)
  }
  let parsed
  try {
    parsed = JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch {
    throw configError('Open Science integration config must be valid JSON.')
  }
  if (!isObject(parsed)) throw configError('Open Science integration config must be a JSON object.')

  const stateDirectory = parsed.stateDirectory === undefined
    ? join(dirname(path), 'receipts')
    : absolutePath(parsed.stateDirectory, 'stateDirectory')
  if (!Object.hasOwn(parsed, 'instances')) {
    return { defaultInstance: 'default', instances: { default: normalizeInstance(parsed) }, stateDirectory }
  }
  if (!isObject(parsed.instances) || Object.keys(parsed.instances).length === 0) {
    throw configError('instances must be a nonempty JSON object.')
  }
  if (Object.hasOwn(parsed, 'sdkPath') || Object.hasOwn(parsed, 'configRoot') || Object.hasOwn(parsed, 'launch')) {
    throw configError('Put sdkPath, configRoot, and launch inside each named instance.')
  }
  const instances = Object.create(null)
  for (const [id, instance] of Object.entries(parsed.instances)) {
    if (!isInstanceId(id)) {
      throw configError('Instance IDs must be 1–64 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.')
    }
    instances[id] = normalizeInstance(instance, `instances.${id}.`)
  }
  if (!isInstanceId(parsed.defaultInstance) || !Object.hasOwn(instances, parsed.defaultInstance)) {
    throw configError('defaultInstance must name one of the configured instances.')
  }
  return { defaultInstance: parsed.defaultInstance, instances, stateDirectory }
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
    throw integrationError('instance_not_found', 'The requested Open Science instance is not configured. List the configured instances and select its ID.')
  }
  const configured = configuration.instances[id]
  const configRoot = canonicalProfileRoot(configured.configRoot)
  const key = process.platform === 'win32' ? configRoot.toLowerCase() : configRoot
  const binding = createHash('sha256').update(key).digest('hex')
  return { instanceId: id, config: { ...configured, configRoot }, binding }
}
