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
  const client = {
    async getAgentRouting() { return { configured: { framework: current, reviewer, subagent } } },
    async listRuntimes() { return [{ framework: 'pi', status: 'ready' }] },
    async updateAgentRouting(request) {
      assert.deepEqual(request, { framework: 'pi' })
      writes++
      current = request.framework
    },
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
  const client = {
    async waitForRun(id, options) {
      assert.equal(id, run.id)
      assert.equal(options.returnOnAttention, true)
      assert.equal(options.timeoutMs, 500)
      return run
    }
  }
  assert.deepEqual(await execute(client, validateRequest({ action: 'wait', runId: run.id, timeoutMs: 500 })), run)
})

test('publishes complete downloads and preserves existing destinations and failed transfers', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-science-download-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const destination = join(directory, 'report.txt')
  const client = { downloadArtifact: async () => new Response('完整报告') }
  const request = validateRequest({ action: 'download', artifactId: 'artifact-1', destination })
  await writeFile(destination, 'existing')
  await assert.rejects(execute(client, request), { code: 'EEXIST' })
  assert.equal(await readFile(destination, 'utf8'), 'existing')
  const newDestination = join(directory, 'new.txt')
  await execute(client, { ...request, destination: newDestination })
  assert.equal(await readFile(newDestination, 'utf8'), '完整报告')
  const brokenClient = {
    downloadArtifact: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('partial')); controller.error(new Error('broken')) }
    }))
  }
  await assert.rejects(execute(brokenClient, { ...request, destination: join(directory, 'partial.txt') }), /broken/)
  assert.deepEqual((await readdir(directory)).sort(), ['new.txt', 'report.txt'])
})
