import assert from 'node:assert/strict'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildPackages } from '../scripts/build.mjs'

const exec = promisify(execFile)

async function fixture(t) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'open-science-packaging-'))
  t.after(async () => {
    const resolved = await realpath(root)
    assert.equal(dirname(resolved), parent)
    assert.equal(basename(resolved), basename(root))
    await rm(resolved, { recursive: true })
  })

  await cp(new URL('../adapters', import.meta.url), join(root, 'adapters'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.8.0' }))
  const skill = join(root, 'skills', 'open-science')
  await mkdir(join(skill, 'references'), { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\r\nname: open-science\r\ndescription: Run research tasks.\r\n---\r\nShared instructions\r\n')
  await writeFile(join(skill, 'references', 'runner.md'), 'Use the bundled runner.')
  await mkdir(join(root, 'packages', 'core'), { recursive: true })
  await writeFile(join(root, 'packages', 'core', 'runner.mjs'), "import './implementation.mjs'\n")
  await writeFile(join(root, 'packages', 'core', 'implementation.mjs'), "console.log('bundled runner works')\n")
  return root
}

async function manifest(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('marketplace entries resolve to runnable self-contained plugins', async (t) => {
  const root = await fixture(t)
  const destination = await buildPackages(root)
  for (const [host, marketplaceDir, pluginManifestDir] of [
    ['codex', '.agents/plugins', '.codex-plugin'],
    ['claude-code', '.claude-plugin', '.claude-plugin']
  ]) {
    const marketplaceRoot = join(destination, host)
    const catalog = await manifest(join(marketplaceRoot, marketplaceDir, 'marketplace.json'))
    const { source } = catalog.plugins[0]
    const plugin = join(marketplaceRoot, typeof source === 'string' ? source : source.path)
    const metadata = await manifest(join(plugin, pluginManifestDir, 'plugin.json'))
    assert.equal(metadata.version, '1.8.0')
    assert.equal(metadata.name, 'open-science')
    const skill = join(plugin, 'skills', 'open-science')
    assert.match(await readFile(join(skill, 'SKILL.md'), 'utf8'), /Shared instructions/)
    assert.equal(await readFile(join(skill, 'references', 'runner.md'), 'utf8'), 'Use the bundled runner.')
    const { stdout } = await exec(process.execPath, [join(skill, 'scripts', 'runner.mjs')])
    assert.equal(stdout.trim(), 'bundled runner works')
  }
})

test('build publishes WorkBuddy Skill metadata and includes its runner in the archive', async (t) => {
  const root = await fixture(t)
  const destination = await buildPackages(root)
  const skill = join(destination, 'workbuddy', 'open-science')
  const contents = await readFile(join(skill, 'SKILL.md'), 'utf8')
  for (const field of ['name', 'display_name', 'display_name_en', 'description', 'description_zh', 'description_en', 'version', 'author']) {
    assert.match(contents, new RegExp(`^${field}: .+`, 'm'))
  }
  assert.match(contents, /^version: "1\.8\.0"$/m)
  assert.match(contents, /Shared instructions/)
  const zip = await readFile(join(destination, 'workbuddy', 'open-science.zip'))
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.ok(zip.includes(Buffer.from('open-science/SKILL.md')))
  assert.ok(zip.includes(Buffer.from('open-science/scripts/runner.mjs')))
})

test('rebuild removes obsolete modules and preserves the previous build after a failure', async (t) => {
  const root = await fixture(t)
  const core = join(root, 'packages', 'core')
  const obsolete = join(core, 'obsolete.mjs')
  await writeFile(obsolete, 'export {}\n')
  const destination = await buildPackages(root)
  const scripts = join(destination, 'workbuddy', 'open-science', 'scripts')
  await access(join(scripts, 'obsolete.mjs'))
  await rm(obsolete)
  await buildPackages(root)
  await assert.rejects(access(join(scripts, 'obsolete.mjs')), { code: 'ENOENT' })

  await rm(join(core, 'runner.mjs'))
  await assert.rejects(buildPackages(root), /Missing shared Open Science CLI runner/)
  await access(join(scripts, 'runner.mjs'))
  assert.ok((await readdir(root)).every((entry) => !entry.startsWith('.open-science-build-')))
})

test('build does not replace an unrelated dist folder', async (t) => {
  const root = await fixture(t)
  const dist = join(root, 'dist')
  await mkdir(dist)
  const marker = join(dist, 'other-output.txt')
  await writeFile(marker, 'keep this')
  await assert.rejects(buildPackages(root), /unmanaged directory/)
  assert.equal(await readFile(marker, 'utf8'), 'keep this')
})
