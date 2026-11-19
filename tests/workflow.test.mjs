import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const runner = fileURLToPath(new URL('../packages/core/runner.mjs', import.meta.url))

const sdkFixture = loss => `
  import { appendFile, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  export async function connectToOpenScience({configRoot}) {
    await appendFile(join(configRoot, 'connections.log'), 'connected\\n')
    return {
      health: async () => ({taskCapabilities: ['durable-submissions']}),
      async listRuntimes() { return ['claude-code', 'codex', 'pi'].map(framework => ({framework,status:'ready'})) },
      async getAgentRouting() {
        const framework = await readFile(join(configRoot,'routing.txt'),'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error
          return 'claude-code'
        })
        return {configured:{framework}}
      },
      async updateAgentRouting({framework}) {
        await appendFile(join(configRoot,'routing-writes.log'), framework + '\\n')
        await new Promise(resolve => setTimeout(resolve, 300))
        await writeFile(join(configRoot,'routing.txt'),framework)
      },
      async submitRun(requestId, run) {
        const stateDir = join(configRoot, '..', 'receipts')
        if (!(await readdir(stateDir)).length) throw Error('No reservation was saved before submitting')
        const drop = await unlink(join(configRoot, 'drop-before-send')).then(() => true, error => {
          if (error.code !== 'ENOENT') throw error
          return false
        })
        if (drop) throw Object.assign(Error('Request lost before reaching the service'), {code:'connection_lost'})
        await appendFile(join(configRoot, 'submissions.log'), requestId + '\\n')
        if (run.prompt !== '总结本次结果') throw Error('Wrong prompt encoding')
        const result = {requestId, runId:'run-a', status:'accepted'}
        await writeFile(join(configRoot, 'remote-receipt.json'), JSON.stringify(result))
        if (${JSON.stringify(loss)} === 'after') throw Object.assign(Error('Response lost'), {code:'connection_lost'})
        return result
      },
      async getSubmission() {
        const failure = await readFile(join(configRoot, 'lookup-error.json'), 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
        if (failure) throw Object.assign(Error('Submission lookup failed'), JSON.parse(failure))
        try {
          return JSON.parse(await readFile(join(configRoot, 'remote-receipt.json'), 'utf8'))
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          throw Object.assign(Error('Submission not found'), {code:'submission_not_found', status:404})
        }
      },
      async getRun(runId) {
        return {id:runId, status:'completed', sessionId:'session-a', output:'完成'}
      }
    }
  }
`

async function fixture(t, loss = 'after') {
  const tmp = await realpath(tmpdir())
  const root = await mkdtemp(join(tmp, 'open-science-workflow-test-'))
  t.after(async () => {
    const verified = await realpath(root)
    if (verified === root && dirname(verified) === tmp) await rm(verified, { recursive: true, force: true })
  })
  const cfg = join(root, 'config.json')
  const sdkPath = join(root, 'sdk.mjs')
  const first = join(root, 'first-profile')
  const second = join(root, 'second-profile')
  await Promise.all([mkdir(first), mkdir(second), writeFile(sdkPath, sdkFixture(loss))])
  const config = {
    defaultInstance: 'first',
    instances: {
      first: { sdkPath, configRoot: first, name: 'First' },
      second: { sdkPath, configRoot: second }
    }
  }
  const save = () => writeFile(cfg, JSON.stringify(config), 'utf8')
  await save()
  async function call(request, instance) {
    const child = spawn(process.execPath, [runner, '--config', cfg, '--no-start',
      ...(instance ? ['--instance', instance] : [])], {
      stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true
    })
    const closed = once(child, 'close')
    const deadline = setTimeout(() => child.kill(), 10000)
    child.stdin.end(JSON.stringify(request))
    try {
      const chunks = []
      for await (const chunk of child.stdout) chunks.push(chunk)
      const [status] = await closed
      const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(status, reply.ok ? 0 : 1)
      return reply
    } finally {
      clearTimeout(deadline)
    }
  }
  return { config, first, second, save, call }
}

test('recover in a new process on the original instance after a lost response and default change', async t => {
  const { call, config, first, second, save } = await fixture(t)
  const requestId = 'request-a'
  const request = { action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } }
  const failed = await call(request)
  assert.equal(failed.error.code, 'connection_lost')
  assert.equal(failed.error.requestId, requestId)

  config.defaultInstance = 'second'
  await save()
  const listed = await call({ action: 'receipts' })
  assert.deepEqual(listed.result.map(x => [x.requestId, x.instanceId, x.projectId]), [[requestId, 'first', 'project-a']])
  assert.equal(Object.hasOwn(listed.result[0], 'binding'), false)
  assert.equal(Object.hasOwn(listed.result[0], 'prompt'), false)
  assert.equal((await call({ action: 'submission', requestId }, 'second')).error.code, 'receipt_instance_mismatch')
  const recovered = await call({ action: 'submission', requestId })
  assert.equal(recovered.instanceId, 'first')
  assert.equal(recovered.result.runId, 'run-a')
  assert.equal((await call({ action: 'run', runId: 'run-a' })).result.output, '完成')
  assert.equal((await call(request)).result.runId, 'run-a')
  assert.equal((await call({ ...request, retryIfMissing: true })).result.runId, 'run-a')
  assert.equal(await readFile(join(first, 'submissions.log'), 'utf8'), `${requestId}\n`)
  await assert.rejects(readFile(join(second, 'connections.log')), { code: 'ENOENT' })
})

test('refuses to send a saved receipt to a different profile under the original name', async t => {
  const { call, config, second, save } = await fixture(t)
  const requestId = 'request-a'
  await call({ action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } })
  config.instances.first.configRoot = second
  delete config.instances.second
  await save()
  assert.equal((await call({ action: 'submission', requestId })).error.code, 'receipt_target_changed')
  await assert.rejects(readFile(join(second, 'connections.log')), { code: 'ENOENT' })
})

test('explicit retry resends an unadmitted request only on its original instance', async t => {
  const { call, config, first, second, save } = await fixture(t, 'none')
  const requestId = 'request-a'
  const request = { action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } }
  await writeFile(join(first, 'drop-before-send'), '')
  assert.equal((await call(request)).error.code, 'connection_lost')

  config.defaultInstance = 'second'
  await save()
  assert.equal((await call({ action: 'submission', requestId })).error.code, 'submission_not_found')
  assert.equal((await call(request)).error.code, 'submission_not_found')
  await assert.rejects(readFile(join(first, 'submissions.log')), { code: 'ENOENT' })

  const retry = { ...request, retryIfMissing: true }
  assert.equal((await call(retry, 'second')).error.code, 'receipt_instance_mismatch')
  const wrongSession = { ...retry, run: { ...retry.run, sessionId: 'another-session' } }
  assert.equal((await call(wrongSession)).error.code, 'receipt_conflict')
  const response = await call(retry)
  assert.equal(response.ok, true)
  assert.equal(response.instanceId, 'first')
  assert.equal(response.result.runId, 'run-a')
  assert.equal((await call(retry)).result.runId, 'run-a')
  assert.equal((await call({ action: 'receipts' })).result[0].runId, 'run-a')
  assert.equal(await readFile(join(first, 'submissions.log'), 'utf8'), `${requestId}\n`)
  await assert.rejects(readFile(join(second, 'connections.log')), { code: 'ENOENT' })
})

test('explicit retry requires a local receipt and a boolean flag', async t => {
  const { call, first } = await fixture(t)
  const request = { action: 'submit', requestId: 'new-request', run: { project: 'project-a', prompt: '总结本次结果' } }
  assert.equal((await call({ ...request, retryIfMissing: 'true' })).error.code, 'invalid_input')
  assert.equal((await call({ ...request, retryIfMissing: true })).error.code, 'receipt_not_found')
  assert.deepEqual((await call({ action: 'receipts' })).result, [])
  await assert.rejects(readFile(join(first, 'connections.log')), { code: 'ENOENT' })
})

test('explicit retry leaves the request alone after uncertain lookups or existing submissions', async t => {
  const { call, first } = await fixture(t, 'none')
  const requestId = 'request-a'
  const request = { action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } }
  const retry = { ...request, retryIfMissing: true }
  await writeFile(join(first, 'drop-before-send'), '')
  assert.equal((await call(request)).error.code, 'connection_lost')

  const lookupError = join(first, 'lookup-error.json')
  for (const failure of [
    { code: 'connection_lost' },
    { code: 'route_not_found', status: 404 },
    { code: 'submission_not_found', status: 503 }
  ]) {
    await writeFile(lookupError, JSON.stringify(failure))
    const reply = await call(retry)
    assert.equal(reply.error.code, failure.code)
    assert.equal(reply.error.status, failure.status)
  }
  await unlink(lookupError)
  for (const status of ['pending', 'failed', 'interrupted']) {
    await writeFile(join(first, 'remote-receipt.json'), JSON.stringify({ requestId, status }))
    assert.equal((await call(retry)).result.status, status)
  }
  await assert.rejects(readFile(join(first, 'submissions.log')), { code: 'ENOENT' })
})

test('explicit retry cannot resend a locally known Run whose remote submission is missing', async t => {
  const { call, first } = await fixture(t, 'none')
  const requestId = 'request-a'
  const request = { action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } }
  assert.equal((await call(request)).result.runId, 'run-a')
  await unlink(join(first, 'remote-receipt.json'))

  const response = await call({ ...request, retryIfMissing: true })
  assert.equal(response.error.code, 'submission_not_found')
  assert.equal((await call({ action: 'receipts' })).result[0].runId, 'run-a')
  assert.equal(await readFile(join(first, 'submissions.log'), 'utf8'), `${requestId}\n`)
})

test('listing targets is a local operation and an unknown selection does not connect', async t => {
  const { call, first } = await fixture(t)
  const response = await call({ action: 'instances' })
  assert.deepEqual(response.result, {
    defaultInstance: 'first',
    instances: [{ id: 'first', name: 'First', autoStart: false }, { id: 'second', name: 'second', autoStart: false }]
  })
  assert.equal((await call({ action: 'health' }, 'unknown')).error.code, 'instance_not_found')
  assert.equal((await call({ action: 'cancel', runId: 'unindexed' })).error.code, 'run_target_required')
  await assert.rejects(readFile(join(first, 'connections.log')), { code: 'ENOENT' })
})

test('concurrent host switches cannot both use the same previous framework', async t => {
  const { call, first } = await fixture(t)
  const results = await Promise.all(['codex', 'pi'].map(framework => call({
    action: 'switch-agent', framework, expectedFramework: 'claude-code'
  })))
  const winner = results.find(reply => reply.ok)
  const loser = results.find(reply => !reply.ok)
  assert.ok(winner)
  assert.ok(['routing_busy', 'routing_changed'].includes(loser?.error.code))
  assert.equal(await readFile(join(first, 'routing-writes.log'), 'utf8'), `${winner.result.framework}\n`)
})
