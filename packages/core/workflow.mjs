import { execute, inputError } from './actions.mjs'
import { connect, selectInstance } from './connection.mjs'
import { claimInstanceOperation } from './locks.mjs'
import { getReceipt, listReceipts, recordRunId, reserveReceipt } from './receipts.mjs'

const runActions = new Set(['run', 'wait', 'cancel'])

function fail(code, message) {
  throw Object.assign(new Error(message), { code })
}

function selectReceiptTarget(configuration, receipt, explicitInstance) {
  if (explicitInstance !== undefined && explicitInstance !== receipt.instanceId) {
    fail('receipt_instance_mismatch', `The receipt belongs to ${receipt.instanceId}. Select that instance to continue.`)
  }
  if (!Object.hasOwn(configuration.instances, receipt.instanceId)) {
    fail('receipt_target_unavailable', `Restore the configuration for ${receipt.instanceId} before recovering this task.`)
  }
  const target = selectInstance(configuration, receipt.instanceId)
  if (target.binding !== receipt.binding) {
    fail('receipt_target_changed', `The profile bound to ${receipt.instanceId} changed. Restore the original binding to recover this task.`)
  }
  return target
}

async function findRunReceipt(configuration, runId, explicitInstance) {
  const matches = await listReceipts(configuration.stateDirectory, { runId, limit: 100 })
  if (!matches.length) return null
  const candidates = explicitInstance === undefined
    ? matches
    : matches.filter(receipt => receipt.instanceId === explicitInstance)
  if (!candidates.length) {
    fail('receipt_instance_mismatch', 'This Run is indexed under a different instance. Inspect its receipts and choose that instance.')
  }
  const targets = new Set(candidates.map(receipt => `${receipt.instanceId}:${receipt.binding}`))
  if (targets.size !== 1) {
    fail('ambiguous_run', 'This Run ID matches several targets. Use the request ID to look up the original submission.')
  }
  return candidates[0]
}

function checkSubmitIdentity(prior, { run }) {
  if (prior.projectId !== run.project || prior.sessionId !== run.sessionId) {
    fail('receipt_conflict', 'This request ID belongs to another project or session. Consult the existing receipt.')
  }
}

async function submission(client, requestId, options, stateDirectory) {
  const result = await execute(client, { action: 'submission', requestId }, options)
  if (result.requestId !== requestId) fail('invalid_response', 'The service returned a different request ID.')
  if (stateDirectory && result.runId) await recordRunId(stateDirectory, requestId, result.runId)
  return result
}

async function submit(client, request, { configuration, target, options, receipt }) {
  const { requestId, run, retryIfMissing } = request
  const { stateDirectory } = configuration
  if (receipt) {
    try {
      return await submission(client, requestId, options, stateDirectory)
    } catch (error) {
      if (!retryIfMissing || receipt.runId !== undefined ||
          error?.code !== 'submission_not_found' || error.status !== 404) throw error
    }
  }

  const health = await client.health(options)
  if (!health.taskCapabilities?.includes('durable-submissions')) {
    fail('unsupported_capability', 'The selected instance does not support durable submissions.')
  }
  if (run.permissionPrompts === 'none' && !health.taskCapabilities?.includes('permission-prompts-none')) {
    fail('unsupported_capability', 'The selected instance does not support unattended runs.')
  }
  if (receipt) {
    // Another host may have recorded a Run while this request was checking the service.
    const latest = await getReceipt(stateDirectory, requestId)
    if (!latest) fail('receipt_not_found', 'No local receipt matches this request ID for retry.')
    checkSubmitIdentity(latest, request)
    selectReceiptTarget(configuration, latest, target.instanceId)
    if (latest.runId !== undefined) return submission(client, requestId, options, stateDirectory)
  } else {
    const { created } = await reserveReceipt(stateDirectory, {
      requestId,
      instanceId: target.instanceId,
      binding: target.binding,
      projectId: run.project,
      ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId })
    })
    if (!created) return submission(client, requestId, options, stateDirectory)
  }

  const result = await client.submitRun(requestId, run, options)
  if (result.requestId !== requestId) fail('invalid_response', 'The service returned a different request ID.')
  if (result.runId) await recordRunId(stateDirectory, requestId, result.runId)
  return result
}

async function switchAgent(client, request, target, options) {
  let release
  try {
    release = await claimInstanceOperation(target.binding, 'routing')
  } catch {
    fail('routing_lock_failed', 'Could not reserve a routing change for the selected instance.')
  }
  if (!release) fail('routing_busy', 'Another host is changing the framework for this instance. Read the routing before retrying.')
  try {
    return await execute(client, request, options)
  } finally {
    release()
  }
}

export async function operate(configuration, request, { instanceId, start = true, signal } = {}) {
  if (request.action === 'instances') {
    const instances = Object.entries(configuration.instances).map(([id, config]) => ({
      id,
      name: config.name ?? id,
      autoStart: config.launch?.preservesFocus === true
    }))
    return { result: { defaultInstance: configuration.defaultInstance, instances } }
  }
  if (request.action === 'receipts') {
    const { action: _, instanceId: filterInstance, ...filters } = request
    if (filterInstance !== undefined && instanceId !== undefined && filterInstance !== instanceId) {
      throw inputError('Choose the same instance in --instance and the receipt filter.')
    }
    const receipts = await listReceipts(configuration.stateDirectory, {
      ...filters, instanceId: filterInstance ?? instanceId
    })
    const result = receipts.map(({ binding: _, ...receipt }) => receipt)
    return { result }
  }

  let receipt
  if (['submit', 'submission'].includes(request.action)) {
    receipt = await getReceipt(configuration.stateDirectory, request.requestId)
    if (request.action === 'submit' && receipt) checkSubmitIdentity(receipt, request)
    if (request.action === 'submit' && request.retryIfMissing && !receipt) {
      fail('receipt_not_found', 'No local receipt matches this request ID for retry.')
    }
    if (request.action === 'submission' && !receipt && instanceId === undefined) {
      fail('receipt_not_found', 'No local receipt matches this request ID. Select an instance explicitly to query a known remote request.')
    }
  } else if (runActions.has(request.action)) {
    receipt = await findRunReceipt(configuration, request.runId, instanceId)
    if (!receipt && instanceId === undefined) {
      fail('run_target_required', 'This Run has no local receipt. Select its instance explicitly before continuing.')
    }
  }
  const target = receipt
    ? selectReceiptTarget(configuration, receipt, instanceId)
    : selectInstance(configuration, instanceId)
  const { client } = await connect({
    configuration, instanceId: target.instanceId, expectedBinding: target.binding, start, signal
  })
  const options = { signal }
  let result
  if (request.action === 'submission') {
    result = await submission(client, request.requestId, options, receipt && configuration.stateDirectory)
  } else if (request.action === 'submit') {
    result = await submit(client, request, { configuration, target, options, receipt })
  } else if (request.action === 'switch-agent') {
    result = await switchAgent(client, request, target, options)
  } else {
    result = await execute(client, request, options)
  }
  return { instanceId: target.instanceId, result }
}
