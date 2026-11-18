import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { getReceipt, listReceipts, recordRunId, reserveReceipt } from '../packages/core/receipts.mjs'

const identity = { requestId: 'request_1', instanceId: 'dev', binding: 'profile-hash', projectId: 'proj' }

async function createStore(t) {
  const parent = await realpath(tmpdir())
  const directory = await mkdtemp(join(parent, 'open-science-receipts-'))
  t.after(async () => {
    const canonical = await realpath(directory)
    assert.equal(dirname(canonical), parent)
    assert.equal(canonical, directory)
    await rm(canonical, { recursive: true })
  })
  return directory
}

function childCall(directory, operation, ...values) {
  const source = `
    import * as receipts from ${JSON.stringify(new URL('../packages/core/receipts.mjs', import.meta.url).href)};
    try {
      const value = await receipts[${JSON.stringify(operation)}](...${JSON.stringify([directory, ...values])});
      process.stdout.write(JSON.stringify({ value }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true })
    const output = []
    const errors = []
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString()))
      resolve(JSON.parse(Buffer.concat(output).toString()))
    })
  })
}

test('one process reserves the request and all hosts recover the same receipt', async t => {
  const directory = await createStore(t)
  const reservations = await Promise.all(Array.from({ length: 3 }, () =>
    childCall(directory, 'reserveReceipt', { ...identity, sessionId: 'session-1' })))
  const values = reservations.map(result => result.value)
  assert.equal(values.filter(value => value.created).length, 1)
  assert.deepEqual(values.map(value => value.receipt), Array(3).fill(values[0].receipt))
  const saved = await childCall(directory, 'recordRunId', identity.requestId, 'run-1')
  assert.equal(saved.value.runId, 'run-1')
  const recovered = await childCall(directory, 'listReceipts', { instanceId: 'dev', sessionId: 'session-1', runId: 'run-1' })
  assert.deepEqual(recovered.value, [saved.value])
})

test('concurrent incompatible Run IDs cannot replace the winning receipt', async t => {
  const directory = await createStore(t)
  await reserveReceipt(directory, identity)
  const results = await Promise.all(['run-1', 'run-2', 'run-3'].map(runId =>
    childCall(directory, 'recordRunId', identity.requestId, runId)))
  const saved = results.filter(result => result.value)
  assert.equal(saved.length, 1)
  assert.equal(results.filter(result => result.code === 'receipt_conflict').length, 2)
  assert.deepEqual(await getReceipt(directory, identity.requestId), saved[0].value)
  await assert.rejects(reserveReceipt(directory, { ...identity, binding: 'different-profile' }), { code: 'receipt_conflict' })
  await assert.rejects(reserveReceipt(directory, { ...identity, sessionId: 'unexpected-session' }), { code: 'receipt_conflict' })
})

test('keeps only receipt metadata and leaves uncertain or partial data safe', async t => {
  const directory = await createStore(t)
  const fingerprint = createHash('sha256').update(identity.requestId).digest('hex')
  await writeFile(join(directory, `${fingerprint}.request.json.crashed.tmp`), '{')
  assert.equal(await getReceipt(directory, identity.requestId), null)
  assert.deepEqual(await listReceipts(directory), [])
  const reserved = await reserveReceipt(directory, { ...identity, prompt: 'private text', output: 'private result' })
  assert.deepEqual(Object.keys(reserved.receipt).sort(), [...Object.keys(identity), 'createdAt'].sort())
  const reservation = (await readdir(directory)).find(path => path.endsWith('.request.json'))
  const content = await readFile(join(directory, reservation), 'utf8')
  assert.doesNotMatch(content, /private/)
  assert.equal((await reserveReceipt(directory, identity)).created, false)

  await writeFile(join(directory, `1${'0'.repeat(63)}.request.json`), '{')
  await assert.rejects(listReceipts(directory), { code: 'receipt_corrupt' })
  assert.equal((await getReceipt(directory, identity.requestId)).runId, undefined)
})
