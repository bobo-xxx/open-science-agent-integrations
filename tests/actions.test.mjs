import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { execute, validateRequest } from '../packages/core/actions.mjs'

test('switches only the requested framework, verifies the saved setting, and returns readiness', async () => {
  let current = 'claude-code'
  const reviewer = { mode: 'inherit' }
  const subagent = { mode: 'fixed', providerId: 'configured', model: 'configured', reasoningEffort: 'medium' }
  let writes = 0
  const client = async args => {
    if (args[0] === 'runtime') {
      assert.deepEqual(args, ['runtime', 'list'])
      return [{ framework: 'pi', status: 'ready' }]
    }
    if (args[2] === 'show') {
      assert.deepEqual(args, ['settings', 'agent-routing', 'show'])
      return { configured: { framework: current, reviewer, subagent } }
    }
    assert.deepEqual(args, ['settings', 'agent-routing', 'update', '--framework', 'pi'])
    writes++
    current = args.at(-1)
  }
  const request = validateRequest({ action: 'switch-agent', framework: 'pi', expectedFramework: 'claude-code' })
  const result = await execute(client, request)
  assert.equal(result.runtime.status, 'ready')
  assert.equal(result.previousFramework, 'claude-code')
  assert.deepEqual(result.routing.configured, { framework: 'pi', reviewer, subagent })
  await assert.rejects(execute(client, request), { code: 'routing_changed' })
  const unchanged = await execute(client, { ...request, expectedFramework: 'pi' })
  assert.equal(unchanged.changed, false)
  assert.equal(writes, 1)
})

test('rejects unattended Plan First before submitting a task', () => {
  const request = {
    action: 'submit', requestId: 'receipt-2',
    run: { project: 'research-id', prompt: 'Plan', permissionPrompts: 'none' }
  }
  assert.throws(() => validateRequest({ ...request, run: { ...request.run, turnIntent: 'plan-first' } }),
    { code: 'invalid_input' })
})

test('bounded waiting returns Plan attention and never cancels the run', async () => {
  const run = { id: 'run-1', status: 'running', attention: { kind: 'plan-approval' } }
  const client = async (args, options) => {
    assert.deepEqual(args, ['run', 'wait', run.id, '--timeout-ms', '500', '--return-on-attention'])
    assert.equal(options.allowRunResult, true)
    return run
  }
  assert.deepEqual(await execute(client, validateRequest({ action: 'wait', runId: run.id, timeoutMs: 500 })), run)
})

test('a bounded wait can be followed by Run and Session lookups for ordinary human attention', async () => {
  const run = { id: 'run-1', sessionId: 'session-1', status: 'running' }
  for (const status of ['waiting-permission', 'waiting-for-user']) {
    const session = { id: run.sessionId, status }
    const calls = []
    const client = async args => {
      calls.push(args)
      if (args[1] === 'wait') throw Object.assign(new Error('Wait timed out.'), { code: 'timeout' })
      return args[0] === 'run' ? run : session
    }
    await assert.rejects(execute(client, { action: 'wait', runId: run.id, timeoutMs: 500 }), { code: 'timeout' })
    const active = await execute(client, { action: 'run', runId: run.id })
    assert.deepEqual(active, run)
    assert.deepEqual(await execute(client, { action: 'session', sessionId: active.sessionId }), session)
    assert.deepEqual(calls, [
      ['run', 'wait', run.id, '--timeout-ms', '500', '--return-on-attention'],
      ['run', 'status', run.id], ['session', 'status', run.sessionId]
    ])
  }
})

test('publishes complete downloads and preserves existing destinations and failed transfers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-download-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const destination = join(directory, 'report.txt')
  const client = async args => {
    assert.deepEqual(args.slice(0, 4), ['artifacts', 'download', 'artifact-1', '--output'])
    await writeFile(args[4], 'Example report', { mode: 0o644 })
    return { artifactId: 'artifact-1', output: args[4] }
  }
  const request = validateRequest({ action: 'download', artifactId: 'artifact-1', destination })
  await writeFile(destination, 'existing')
  await assert.rejects(execute(client, request), { code: 'EEXIST' })
  assert.equal(await readFile(destination, 'utf8'), 'existing')
  const newDestination = join(directory, 'new.txt')
  await execute(client, { ...request, destination: newDestination })
  assert.equal(await readFile(newDestination, 'utf8'), 'Example report')
  if (process.platform !== 'win32') assert.equal((await stat(newDestination)).mode & 0o777, 0o600)
  const brokenClient = async args => {
    await writeFile(args[4], 'partial')
    throw new Error('broken')
  }
  await assert.rejects(execute(brokenClient, { ...request, destination: join(directory, 'partial.txt') }), /broken/)
  assert.deepEqual((await readdir(directory)).sort(), ['new.txt', 'report.txt'])
})

test('passes Film scope and opt-in flags while returning the service state unchanged', async () => {
  const scope = { projectId: 'project-id', sessionId: 'session-id', mode: 'research-explanation' }
  const scopedArgs = ['session-id', '--project', 'project-id', '--mode', 'research-explanation']
  const state = {
    branchId: 'branch-id', progress: { phase: 'writing' }, result: { id: 'existing-published-film' }
  }

  for (const [fields, expected] of [
    [{ action: 'film-start', installNarration: false, resume: false, advisoryNarrationReview: false },
      ['film', 'start', ...scopedArgs]],
    [{ action: 'film-start', installNarration: true, resume: true, advisoryNarrationReview: true },
      ['film', 'start', ...scopedArgs, '--install-narration', '--resume', '--advisory-narration-review']],
    [{ action: 'film-status', branchId: 'branch-id' },
      ['film', 'status', ...scopedArgs, '--branch', 'branch-id']],
    [{ action: 'film-cancel', branchId: 'branch-id', mode: 'operation-replay' },
      ['film', 'cancel', 'session-id', '--project', 'project-id', '--mode', 'operation-replay',
        '--branch', 'branch-id']]
  ]) {
    const client = async args => {
      assert.deepEqual(args, expected)
      return state
    }
    assert.equal(await execute(client, validateRequest({ ...scope, ...fields })), state)
  }
})

test('passes Film revision feedback in a private UTF-8 file and removes it even on failure', async () => {
  const feedback = '--改进图表\nSimplify the labels and spacing.'
  const request = validateRequest({
    action: 'film-revise', projectId: 'project-id', sessionId: 'session-id', branchId: 'branch-id',
    mode: 'research-explanation', attemptId: 'attempt-id', feedback, advisoryNarrationReview: true
  })
  const state = { branchId: 'branch-id', progress: { phase: 'writing' } }
  const conflict = Object.assign(new Error('Review attempt changed.'), { code: 'film_review_conflict' })
  for (const failure of [undefined, conflict]) {
    let file
    const client = async args => {
      assert.deepEqual(args.slice(0, -1), [
        'film', 'revise', 'session-id', '--project', 'project-id', '--mode', 'research-explanation',
        '--branch', 'branch-id', '--advisory-narration-review', '--attempt-id', 'attempt-id', '--feedback-file'
      ])
      file = args.at(-1)
      assert.equal(await readFile(file, 'utf8'), feedback)
      if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
      if (failure) throw failure
      return state
    }
    if (failure) await assert.rejects(execute(client, request), failure)
    else assert.equal(await execute(client, request), state)
    assert.ok(file)
    await assert.rejects(stat(dirname(file)), { code: 'ENOENT' })
  }
})

test('publishes a complete Film HTML download without overwriting an existing destination', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-film-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const destination = join(directory, '研究影片.HTML')
  const content = Buffer.from('<!doctype html><title>研究影片</title>')
  let downloadBytes = content
  const request = validateRequest({
    action: 'film-download', projectId: 'project-id', sessionId: 'session-id', branchId: 'branch-id',
    mode: 'operation-replay', filmId: 'film-id', destination
  })
  const client = async (args, options) => {
    assert.deepEqual(args.slice(0, -1), [
      'film', 'download', 'session-id', '--project', 'project-id', '--mode', 'operation-replay',
      '--branch', 'branch-id', '--film-id', 'film-id', '--output'
    ])
    assert.equal(options.timeoutMs, 310_000)
    const file = args.at(-1)
    assert.equal(basename(file), 'film.html')
    assert.notEqual(file, destination)
    await writeFile(file, downloadBytes, { mode: 0o644 })
  }
  assert.deepEqual(await execute(client, request), { filmId: 'film-id', destination })
  assert.deepEqual(await readFile(destination), content)
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600)

  downloadBytes = Buffer.from('<!doctype html><title>Replacement</title>')
  await assert.rejects(execute(client, request), { code: 'EEXIST' })
  assert.deepEqual(await readFile(destination), content)
  await assert.rejects(execute(async args => {
    await writeFile(args.at(-1), 'partial')
    throw Object.assign(new Error('Film missing.'), { code: 'film_not_found' })
  }, { ...request, destination: join(directory, 'partial.html') }), { code: 'film_not_found' })
  assert.deepEqual(await readdir(directory), [basename(destination)])
})

test('validates the Film action-specific parameters before dispatch', () => {
  const scope = { projectId: 'project-id', sessionId: 'session-id', mode: 'research-explanation' }
  for (const request of [
    { action: 'film-status', projectId: undefined },
    { action: 'film-status', sessionId: '-flag' },
    { action: 'film-status', branchId: '' },
    { action: 'film-status', mode: 'invalid' },
    { action: 'film-status', installNarration: true },
    { action: 'film-start', installNarration: 'true' },
    { action: 'film-start', resume: null },
    { action: 'film-start', advisoryNarrationReview: true, mode: 'operation-replay' },
    { action: 'film-revise', attemptId: 'attempt-id', feedback: ' \n' },
    { action: 'film-revise', feedback: 'Feedback' },
    { action: 'film-download', filmId: 'film-id', destination: 'relative.html' },
    { action: 'film-download', filmId: 'film-id', destination: join(tmpdir(), 'unsupported.mp4') },
    { action: 'film-download', destination: join(tmpdir(), 'missing-id.html') }
  ]) {
    assert.throws(() => validateRequest({ ...scope, ...request }), { code: 'invalid_input' })
  }
})

test('passes explicit run options to the CLI and sends Unicode prompts on stdin', async () => {
  const result = { id: 'run-1', status: 'running', sessionId: 'session-1' }
  const prompt = '整理报告\nInclude a summary and --wait.'
  const client = async (args, options) => {
    assert.deepEqual(args, [
      'run', '--project', 'research-id', '--request-id', 'request-1',
      '--approval-profile', 'full', '--plan-first', '--no-auto-review', '--memory',
      '--specialist', 'reviewer', '--delegation', 'deny',
      '--skill', 'review', '--skill', 'citations', '--enable-compute-host', 'ssh:available',
      '--compute-host', 'ssh:selected', '--provider', 'provider-1', '--provider-default-model',
      '--reasoning-effort', 'high'
    ])
    assert.equal(options.stdin, prompt)
    assert.equal(options.allowRunResult, true)
    return result
  }
  const request = validateRequest({
    action: 'submit', requestId: 'request-1', run: {
      project: 'research-id', prompt,
      permissionProfile: 'full', turnIntent: 'plan-first', autoReviewEnabled: false,
      memoryEnabled: true, specialist: 'reviewer', delegationPolicy: 'deny', skillIds: ['review', 'citations'],
      enabledComputeHostIds: ['ssh:available'], computeHostIds: ['ssh:selected'],
      agentConfiguration: { providerId: 'provider-1', model: null, reasoningEffort: 'high' }
    }
  })
  assert.deepEqual(await execute(client, request), result)
})

test('does not add CLI overrides when continuing a session with current settings', async () => {
  const request = validateRequest({
    action: 'submit', requestId: 'request-1',
    run: { project: 'research-id', prompt: 'Continue', sessionId: 'session-1' }
  })
  const client = async args => {
    assert.deepEqual(args, ['run', '--project', 'research-id', '--request-id', 'request-1', '--session', 'session-1'])
    return { id: 'continued-run', sessionId: 'session-1' }
  }
  assert.equal((await execute(client, request)).sessionId, 'session-1')
})

test('rejects unsupported Compute Host edits and session enumeration before a CLI call', () => {
  const request = { action: 'submit', requestId: 'request-1', run: { project: 'research-id', prompt: 'Review' } }
  for (const override of [
    { computeHostIds: [] },
    { computeHostIds: [], enabledComputeHostIds: ['ssh:one'] },
    { enabledComputeHostIds: [] },
    { computeHostIds: [], enabledComputeHostIds: [], sessionId: 'session-1' },
    { enabledComputeHostIds: ['ssh:one'], sessionId: 'session-1' }
  ]) {
    assert.throws(() => validateRequest({ ...request, run: { ...request.run, ...override } }),
      { code: 'unsupported_operation' })
  }
  assert.throws(() => validateRequest({ action: 'sessions' }), { code: 'unsupported_operation' })
})

test('clears both Compute Host pools only when both were explicitly cleared for a new session', async () => {
  const request = validateRequest({
    action: 'submit', requestId: 'request-1',
    run: { project: 'research-id', prompt: 'Review', enabledComputeHostIds: [], computeHostIds: [] }
  })
  const client = async args => {
    assert.deepEqual(args, ['run', '--project', 'research-id', '--request-id', 'request-1', '--clear-compute-hosts'])
    return { id: 'run-1' }
  }
  assert.equal((await execute(client, request)).id, 'run-1')
})

test('uses scoped CLI lookups and Plan commands with their documented positions', async () => {
  for (const [request, expected] of [
    [{ action: 'projects' }, ['project', 'list']],
    [{ action: 'create-project', name: 'First project', description: 'Review' },
      ['project', 'create', 'First project', '--description', 'Review']],
    [{ action: 'project-defaults', projectId: 'p-1' }, ['project', 'session-defaults', 'show', 'p-1']],
    [{ action: 'submission', requestId: 'request-1' }, ['run', 'status', '--request-id', 'request-1']],
    [{ action: 'run', runId: 'run-1' }, ['run', 'status', 'run-1']],
    [{ action: 'cancel', runId: 'run-1' }, ['run', 'cancel', 'run-1']],
    [{ action: 'session', sessionId: 's-1' }, ['session', 'status', 's-1']],
    [{ action: 'session-config', sessionId: 's-1' }, ['session', 'config', 'show', 's-1']],
    [{ action: 'artifacts', sessionId: 's-1' }, ['artifacts', 'list', 's-1']],
    [{ action: 'plan', sessionId: 's-1' }, ['plan', 'show', 's-1']],
    [{ action: 'respond-plan', sessionId: 's-1', response: {
      decision: 'approved', artifactVersionId: 'v-1', expectedRevision: 3
    } }, ['plan', 'approve', 's-1', '--artifact-version', 'v-1', '--revision', '3']],
    [{ action: 'respond-plan', sessionId: 's-1', response: { feedback: 'Explain this' } },
      ['plan', 'revise', 's-1', '--feedback', 'Explain this']]
  ]) {
    const output = { captured: true }
    const client = async args => {
      assert.deepEqual(args, expected)
      return output
    }
    assert.equal(await execute(client, validateRequest(request)), output)
  }
})

test('reports versions verified by the CLI connection', async () => {
  const client = Object.assign(() => assert.fail('Command should not run twice'), {
    status: { running: true, appVersion: '1.3.0' }, version: '1.3.0'
  })
  assert.deepEqual(await execute(client, validateRequest({ action: 'health' })), {
    connected: true, version: '1.3.0', cliVersion: '1.3.0'
  })
})
