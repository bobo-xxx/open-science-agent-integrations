import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadConfiguration } from '../packages/core/connection.mjs'

try {
  const [source, destination, ...extra] = process.argv.slice(2)
  if (!source || extra.length) {
    throw new Error('Usage: npm run configure -- <prepared-config.json> [destination.json]')
  }
  const defaultPath = join(homedir(), '.open-science-agent-integrations', 'config.json')
  const target = resolve(destination ?? process.env.OPEN_SCIENCE_INTEGRATIONS_CONFIG ?? defaultPath)
  const { defaultInstance } = await loadConfiguration(resolve(source))
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve(source), target, constants.COPYFILE_EXCL)
  console.log(`Created ${target} with default instance ${defaultInstance}.`)
} catch (error) {
  console.error(error.code === 'EEXIST'
    ? 'The destination already exists. Edit the existing configuration to update its instances.'
    : error.message)
  process.exitCode = 1
}
