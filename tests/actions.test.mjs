import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('publishes complete downloads and preserves existing destinations and failed transfers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-download-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const destination = join(directory, 'report.txt')
  const client = async args => {
    assert.deepEqual(args.slice(0, 4), ['artifacts', 'download', 'artifact-1', '--output'])
    await writeFile(args[4], 'Example report')
    return { artifactId: 'artifact-1', output: args[4] }
  }
  const request = validateRequest({ action: 'download', artifactId: 'artifact-1', destination })
  await writeFile(destination, 'existing')
  await assert.rejects(execute(client, request), { code: 'EEXIST' })
  assert.equal(await readFile(destination, 'utf8'), 'existing')
  const newDestination = join(directory, 'new.txt')
  await execute(client, { ...request, destination: newDestination })
  assert.equal(await readFile(newDestination, 'utf8'), 'Example report')
  const brokenClient = async args => {
    await writeFile(args[4], 'partial')
    throw new Error('broken')
  }
  await assert.rejects(execute(brokenClient, { ...request, destination: join(directory, 'partial.txt') }), /broken/)
  assert.deepEqual((await readdir(directory)).sort(), ['new.txt', 'report.txt'])
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
