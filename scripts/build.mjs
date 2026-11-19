import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'

const projectDirectory = fileURLToPath(new URL('../', import.meta.url))
const ownerMarker = 'open-science-agent-integrations-build\n'
const skillName = 'open-science'
const workBuddyZipLimit = 3_000_000

async function filesUnder(directory, prefix = '') {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...await filesUnder(directory, relative))
    } else if (entry.isFile()) {
      files.push(relative)
    } else {
      throw new Error(`Cannot package a link or special file: ${join(directory, relative)}`)
    }
  }
  return files
}

async function write(destination, content) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content)
}

async function copyFiles(source, destination, files) {
  for (const path of files) {
    const target = join(destination, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(source, path), target)
  }
}

async function compileSkill(root, destination) {
  const source = join(root, 'skills', skillName)
  const skillFiles = await filesUnder(source)
  if (!skillFiles.includes('SKILL.md')) throw new Error('Missing shared Open Science SKILL.md')
  await copyFiles(source, destination, skillFiles)

  const core = join(root, 'packages', 'core')
  const runtimeFiles = (await filesUnder(core)).filter((path) => path.endsWith('.mjs'))
  if (!runtimeFiles.includes('runner.mjs')) throw new Error('Missing shared Open Science CLI runner.mjs')
  await copyFiles(core, join(destination, 'scripts'), runtimeFiles)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await write(path, JSON.stringify(value, null, 2) + '\n')
}

async function compilePlugin(root, destination, host, manifestDirectory, marketplaceDirectory, version) {
  const adapter = join(root, 'adapters', host)
  const plugin = join(destination, 'plugins', skillName)
  const manifest = await readJson(join(adapter, 'plugin.json'))
  const marketplace = await readJson(join(adapter, 'marketplace.json'))
  await writeJson(join(plugin, manifestDirectory, 'plugin.json'), { ...manifest, version })
  await writeJson(join(destination, marketplaceDirectory, 'marketplace.json'), marketplace)
  await compileSkill(root, join(plugin, 'skills', skillName))
}

async function compileWorkBuddy(root, destination, version) {
  const skill = join(destination, skillName)
  await compileSkill(root, skill)
  const path = join(skill, 'SKILL.md')
  const contents = await readFile(path, 'utf8')
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/)
  if (!frontmatter) throw new Error('Missing shared skill frontmatter for WorkBuddy')

  const metadata = await readJson(join(root, 'adapters', 'workbuddy', 'skill-metadata.json'))
  const fields = Object.entries({ ...metadata, version })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n')
  await write(path, `---\n${frontmatter[1]}\n${fields}\n---${contents.slice(frontmatter[0].length)}`)
  await createSkillZip(skill, join(destination, `${skillName}.zip`))
}

// WorkBuddy's import expects a ZIP rooted at the skill name.
async function createSkillZip(directory, destination) {
  const localParts = []
  const centralParts = []
  let localLength = 0
  let centralLength = 0
  for (const file of await filesUnder(directory)) {
    const name = Buffer.from(`${skillName}/${file.split(sep).join('/')}`)
    const body = await readFile(join(directory, file))
    const checksum = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 filename
    local.writeUInt16LE(0x21, 12) // ZIP epoch date, 1980-01-01
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    local.copy(central, 6, 4, 28)
    central.writeUInt32LE(localLength, 42)

    localParts.push(local, name, body)
    centralParts.push(central, name)
    localLength += local.length + name.length + body.length
    centralLength += central.length + name.length
    if (localLength + centralLength + 22 > workBuddyZipLimit) {
      throw new Error('WorkBuddy skill archive exceeds the 3 MB upload limit')
    }
  }

  const end = Buffer.alloc(22)
  const entries = centralParts.length / 2
  if (entries > 0xffff) throw new Error('WorkBuddy skill archive contains too many files')
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries, 8)
  end.writeUInt16LE(entries, 10)
  end.writeUInt32LE(centralLength, 12)
  end.writeUInt32LE(localLength, 16)
  await write(destination, Buffer.concat([...localParts, ...centralParts, end]))
}

async function assertChildDirectory(parent, candidate) {
  const attributes = await lstat(candidate)
  const canonical = await realpath(candidate)
  if (!attributes.isDirectory() || attributes.isSymbolicLink() ||
      dirname(canonical) !== parent || basename(canonical) !== basename(candidate)) {
    throw new Error(`Expected a real directory directly under ${parent}: ${candidate}`)
  }
  return canonical
}

async function existingBuild(root, destination) {
  try {
    await lstat(destination)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  await assertChildDirectory(root, destination)
  const markerPath = join(destination, '.build-owner')
  const attributes = await lstat(markerPath).catch(() => undefined)
  const marker = attributes?.isFile() ? await readFile(markerPath, 'utf8') : undefined
  if (marker !== ownerMarker) {
    throw new Error(`Refusing to replace an unmanaged directory: ${destination}`)
  }
  return true
}

export async function buildPackages(projectRoot = projectDirectory) {
  const root = await realpath(projectRoot)
  const { version } = await readJson(join(root, 'package.json'))
  if (typeof version !== 'string' || !version) throw new Error('Missing package version')

  const scratch = await mkdtemp(join(root, '.open-science-build-'))
  const stage = join(scratch, 'dist')
  const previous = join(scratch, 'previous')
  const destination = join(root, 'dist')
  let hasPrevious = false
  let published = false
  try {
    await compilePlugin(root, join(stage, 'codex'), 'codex', '.codex-plugin', '.agents/plugins', version)
    await compilePlugin(root, join(stage, 'claude-code'), 'claude-code', '.claude-plugin', '.claude-plugin', version)
    await compileWorkBuddy(root, join(stage, 'workbuddy'), version)
    await write(join(stage, '.build-owner'), ownerMarker)

    const canonicalScratch = await assertChildDirectory(root, scratch)
    await assertChildDirectory(canonicalScratch, stage)
    if (await existingBuild(root, destination)) {
      await rename(destination, previous)
      hasPrevious = true
    }
    await rename(stage, destination)
    published = true
    return destination
  } catch (error) {
    if (hasPrevious) {
      await rename(previous, destination)
      hasPrevious = false
    }
    throw error
  } finally {
    if (!hasPrevious || published) {
      const canonicalScratch = await assertChildDirectory(root, scratch)
      await rm(canonicalScratch, { recursive: true })
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const destination = await buildPackages()
    console.log(`Built Codex, Claude Code, and WorkBuddy packages in ${destination}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
