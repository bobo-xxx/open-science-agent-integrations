import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const runner = fileURLToPath(new URL('../packages/core/runner.mjs', import.meta.url))

const cliFixture = mode => `
  import { appendFile, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  const args = process.argv.slice(2)
  const mode = ${JSON.stringify(mode)}
  if (args.length === 1 && args[0] === '--version') {
    console.log('1.3.0')
    process.exit(0)
  }
  const option = name => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const configRoot = option('--config-root')
  if (!configRoot || !args.includes('--json')) throw Error('CLI invocation was not scoped and structured')
  const path = name => join(configRoot, name)
  const readOptional = name => readFile(path(name), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const result = value => console.log(JSON.stringify(value))
  const fail = (code, message, details = {}, exitCode = 1) => {
    console.error(JSON.stringify({error: {code, message, ...details}, exitCode}))
    process.exitCode = exitCode
  }
  await appendFile(path('connections.log'), JSON.stringify(args) + '\\n')
  const [command, subcommand, operation] = args
  if (command === 'status') {
    result({running:true, appVersion:'1.3.0', configRoot})
  } else if (command === 'runtime' && subcommand === 'list') {
    result(['claude-code', 'codex', 'pi'].map(framework => ({framework, status:'ready'})))
  } else if (command === 'settings' && subcommand === 'agent-routing' && operation === 'show') {
    result({configured:{framework:(await readOptional('routing.txt')) ?? 'claude-code'}})
  } else if (command === 'settings' && subcommand === 'agent-routing' && operation === 'update') {
    const framework = option('--framework')
    await appendFile(path('routing-writes.log'), framework + '\\n')
    await new Promise(resolve => setTimeout(resolve, 300))
    await writeFile(path('routing.txt'), framework)
    result({configured:{framework}})
  } else if (command === 'run' && subcommand === 'status') {
    const requestId = option('--request-id')
    if (requestId) {
      const failure = await readOptional('lookup-error.json')
      const saved = await readOptional('remote-receipt.json')
      if (failure) {
        const {code, exitCode} = JSON.parse(failure)
        fail(code, 'Submission lookup failed', {}, exitCode)
      } else if (saved) {
        result(JSON.parse(saved))
      } else {
        fail('submission_not_found', 'Submission not found')
      }
    } else {
      result({id:operation, status:'completed', sessionId:'session-a', output:'完成'})
    }
  } else if (command === 'run') {
    const requestId = option('--request-id')
    const stateDir = join(configRoot, '..', 'receipts')
    if (!(await readdir(stateDir)).length) throw Error('No reservation was saved before submitting')
    const drop = await unlink(path('drop-before-send')).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error
      return false
    })
    if (drop) {
      fail('timeout', 'Request lost before reaching the service', {requestId, completionStatus:'submission-unconfirmed'})
    } else {
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      if (Buffer.concat(chunks).toString('utf8') !== '总结本次结果') throw Error('Wrong prompt encoding')
      if (option('--project') !== 'project-a') throw Error('Wrong target project')
      await appendFile(path('submissions.log'), requestId + '\\n')
      await writeFile(path('remote-receipt.json'), JSON.stringify({requestId, runId:'run-a', status:'accepted'}))
      if (mode === 'after') {
        fail('daemon_unavailable', 'Response lost', {requestId, completionStatus:'submission-unconfirmed'}, 3)
      } else {
        result({id:'run-a', requestId, status:mode === 'terminal' ? 'failed' : 'running', sessionId:'session-a'})
        if (mode === 'terminal') process.exitCode = 1
      }
    }
  } else {
    throw Error('Unexpected CLI invocation: ' + args.join(' '))
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
  const cliPath = join(root, 'cli.mjs')
  const first = join(root, 'first-profile')
  const second = join(root, 'second-profile')
  await Promise.all([mkdir(first), mkdir(second), writeFile(cliPath, cliFixture(loss))])
  const cli = { command: process.execPath, args: [cliPath] }
  const config = {
    defaultInstance: 'first',
    instances: {
      first: { cli, configRoot: first, name: 'First' },
      second: { cli, configRoot: second }
    }
  }
  const save = () => writeFile(cfg, JSON.stringify(config), 'utf8')
  await save()
  async function call(request, instance) {
    const child = spawn(process.execPath, [runner, '--config', cfg,
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
  return { config, first, second, root, save, call }
}

test('recover in a new process on the original instance after a lost response and default change', async t => {
  const { call, config, first, second, save } = await fixture(t)
  const requestId = 'request-a'
  const request = { action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } }
  const unavailable = join(first, 'lookup-error.json')
  await writeFile(unavailable, JSON.stringify({ code: 'daemon_unavailable', exitCode: 3 }))
  const failed = await call(request)
  assert.equal(failed.error.code, 'daemon_unavailable')
  assert.equal(failed.error.completionStatus, 'submission-unconfirmed')
  assert.equal(failed.error.exitCode, 3)
  assert.equal(failed.error.requestId, requestId)
  assert.equal(failed.instanceId, 'first')
  await unlink(unavailable)

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

test('recovers once without resubmitting when submission admission was unconfirmed', async t => {
  const { call, first } = await fixture(t)
  const requestId = 'request-a'
  const reply = await call({ action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } })
  assert.deepEqual(reply.result, { requestId, runId: 'run-a', status: 'accepted' })
  assert.equal((await call({ action: 'receipts' })).result[0].runId, 'run-a')
  assert.equal(await readFile(join(first, 'submissions.log'), 'utf8'), `${requestId}\n`)
})

test('records the admitted Run ID even when the CLI exits with a failed Run', async t => {
  const { call } = await fixture(t, 'terminal')
  const requestId = 'request-a'
  const reply = await call({ action: 'submit', requestId, run: { project: 'project-a', prompt: '总结本次结果' } })
  assert.deepEqual(reply.result, {
    requestId, status: 'accepted', runId: 'run-a', runStatus: 'failed', sessionId: 'session-a'
  })
  assert.equal((await call({ action: 'receipts' })).result[0].runId, 'run-a')
})

test('recovers a legacy receipt through the CLI on its original profile', async t => {
  const { call, config, first, second, root, save } = await fixture(t, 'none')
  const requestId = 'legacy-request'
  const bindingKey = process.platform === 'win32' ? first.toLowerCase() : first
  const hash = value => createHash('sha256').update(value).digest('hex')
  const receipts = join(root, 'receipts')
  await mkdir(receipts)
  const filename = join(receipts, `${hash(requestId)}.request.json`)
  const legacy = JSON.stringify({
    requestId, instanceId: 'first', binding: hash(bindingKey), projectId: 'project-a', createdAt: 1700000000000
  })
  await writeFile(filename, legacy)
  await writeFile(join(first, 'remote-receipt.json'), JSON.stringify({ requestId, status: 'accepted', runId: 'run-a' }))
  config.defaultInstance = 'second'
  await save()

  const reply = await call({ action: 'submission', requestId })
  assert.equal(reply.instanceId, 'first')
  assert.equal(reply.result.runId, 'run-a')
  assert.equal(await readFile(filename, 'utf8'), legacy)
  assert.equal((await call({ action: 'receipts' })).result[0].runId, 'run-a')
  await assert.rejects(readFile(join(second, 'connections.log')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(first, 'submissions.log')), { code: 'ENOENT' })
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
  assert.equal((await call(request)).error.code, 'timeout')

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
  assert.equal((await call(request)).error.code, 'timeout')

  const lookupError = join(first, 'lookup-error.json')
  for (const failure of [
    { code: 'daemon_unavailable', exitCode: 3 },
    { code: 'run_not_found', exitCode: 4 },
    { code: 'command_failed', exitCode: 1 }
  ]) {
    await writeFile(lookupError, JSON.stringify(failure))
    const reply = await call(retry)
    assert.equal(reply.error.code, failure.code)
    assert.equal(reply.error.exitCode, failure.exitCode)
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
    instances: [{ id: 'first', name: 'First' }, { id: 'second', name: 'second' }]
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
