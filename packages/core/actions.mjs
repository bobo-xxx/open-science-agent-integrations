import { chmod, link, mkdtemp, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'

const downloadTimeoutMs = 310_000

export function inputError(message) {
  return Object.assign(new Error(message), { code: 'invalid_input' })
}

function unsupportedOperation(message) {
  return Object.assign(new Error(message), { code: 'unsupported_operation' })
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw inputError(`${label} must be an object.`)
  }
  return value
}

function string(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw inputError(`${label} must be a nonempty string.`)
  }
  return value
}

function positional(value, label) {
  if (value.startsWith('-')) {
    throw inputError(`${label} cannot begin with a dash for this CLI command.`)
  }
}

function keys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw inputError(`Unknown ${label} field: ${key}.`)
  }
}

function absolute(value, label) {
  const path = string(value, label)
  if (path.includes('\0') || !isAbsolute(path) ||
      (process.platform === 'win32' && /^[\\/]$/.test(parse(path).root))) {
    throw inputError(`${label} must be an absolute path.`)
  }
  return path
}

const runFields = [
  'project', 'prompt', 'sessionId', 'cwd', 'permissionProfile', 'permissionPrompts',
  'turnIntent', 'skillIds', 'specialist', 'autoReviewEnabled', 'memoryEnabled',
  'delegationPolicy', 'agentConfiguration', 'computeHostIds', 'enabledComputeHostIds'
]

const frameworkIds = [
  'open-science-agent', 'claude-code', 'opencode', 'codex', 'codebuddy', 'pi'
]

const runChoices = {
  permissionProfile: ['ask', 'auto', 'full'],
  permissionPrompts: ['none'],
  turnIntent: ['plan-first'],
  delegationPolicy: ['allow', 'deny']
}

const reasoningEfforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max']

function validateRun(run) {
  object(run, 'run')
  keys(run, runFields, 'run')
  string(run.project, 'run.project')
  string(run.prompt, 'run.prompt')
  if (run.cwd !== undefined) absolute(run.cwd, 'run.cwd')
  if (run.sessionId !== undefined) string(run.sessionId, 'run.sessionId')
  if (run.specialist !== undefined) string(run.specialist, 'run.specialist')
  for (const [field, choices] of Object.entries(runChoices)) {
    if (run[field] !== undefined && !choices.includes(run[field])) {
      throw inputError(`run.${field} must be one of: ${choices.join(', ')}.`)
    }
  }
  for (const field of ['autoReviewEnabled', 'memoryEnabled']) {
    if (run[field] !== undefined && typeof run[field] !== 'boolean') {
      throw inputError(`run.${field} must be a boolean.`)
    }
  }
  for (const field of ['skillIds', 'enabledComputeHostIds', 'computeHostIds']) {
    if (run[field] === undefined) continue
    if (!Array.isArray(run[field])) throw inputError(`run.${field} must be an array of IDs.`)
    for (const id of run[field]) string(id, `run.${field} entry`)
  }
  if (run.permissionPrompts === 'none' && run.turnIntent === 'plan-first') {
    throw inputError('Plan First requires an interactive run.')
  }
  if (run.sessionId !== undefined && run.enabledComputeHostIds !== undefined) {
    throw unsupportedOperation('The CLI requires a separate configuration update to change the available Compute Hosts of an existing Session. Use the Session settings in Open Science.')
  }
  const hasEmptyEnabled = run.enabledComputeHostIds?.length === 0
  const hasEmptySelected = run.computeHostIds?.length === 0
  if (hasEmptyEnabled !== hasEmptySelected) {
    throw unsupportedOperation('The CLI can clear both Compute Host lists for a new Session. Use the Compute Host settings in Open Science to clear just one list.')
  }
  if (run.agentConfiguration === undefined) return
  const settings = object(run.agentConfiguration, 'run.agentConfiguration')
  keys(settings, ['providerId', 'model', 'reasoningEffort'], 'run.agentConfiguration')
  if (Object.keys(settings).length === 0) {
    throw inputError('Omit run.agentConfiguration to keep the existing Agent settings.')
  }
  if (settings.providerId !== undefined) {
    string(settings.providerId, 'run.agentConfiguration.providerId')
    if (settings.model === undefined) {
      throw inputError('An explicit provider requires a model or a null model to use the provider default.')
    }
  }
  if (settings.model !== undefined && settings.model !== null) {
    string(settings.model, 'run.agentConfiguration.model')
  }
  if (settings.reasoningEffort !== undefined && !reasoningEfforts.includes(settings.reasoningEffort)) {
    throw inputError(`run.agentConfiguration.reasoningEffort must be one of: ${reasoningEfforts.join(', ')}.`)
  }
}

const actions = {
  instances: [],
  receipts: ['instanceId', 'projectId', 'sessionId', 'runId', 'limit'],
  health: [],
  doctor: [],
  runtimes: [],
  projects: [],
  'create-project': ['name', 'description'],
  sessions: ['projectId'],
  session: ['sessionId'],
  'session-config': ['sessionId'],
  'agent-routing': [],
  'switch-agent': ['framework', 'expectedFramework'],
  'project-defaults': ['projectId'],
  submit: ['requestId', 'run', 'retryIfMissing'],
  submission: ['requestId'],
  run: ['runId'],
  wait: ['runId', 'timeoutMs'],
  cancel: ['runId'],
  plan: ['sessionId'],
  'respond-plan': ['sessionId', 'response'],
  artifacts: ['sessionId'],
  download: ['artifactId', 'destination']
}

export function validateRequest(request) {
  object(request, 'Request')
  const action = string(request.action, 'action')
  if (!Object.hasOwn(actions, action)) throw inputError(`Unknown action: ${action}.`)
  keys(request, ['action', ...actions[action]], 'request')
  if (action === 'sessions') {
    throw unsupportedOperation('Use a task receipt or supply a Session ID from Open Science. The CLI supports Session lookup by ID.')
  }
  for (const field of actions[action].filter((field) => field.endsWith('Id'))) {
    if (action === 'receipts' && request[field] === undefined) continue
    const value = string(request[field], field)
    if (field !== 'requestId' && action !== 'receipts') positional(value, field)
  }
  if (action === 'create-project') {
    positional(string(request.name, 'name'), 'name')
    if (request.description !== undefined && typeof request.description !== 'string') {
      throw inputError('description must be a string.')
    }
  }
  if (action === 'submit') {
    if (request.retryIfMissing !== undefined && typeof request.retryIfMissing !== 'boolean') {
      throw inputError('retryIfMissing must be a boolean.')
    }
    validateRun(request.run)
  }
  if (action === 'wait' && request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 25000)) {
    throw inputError('timeoutMs must be an integer from 1 to 25000.')
  }
  if (action === 'receipts' && request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) {
    throw inputError('limit must be an integer from 1 to 100.')
  }
  if (action === 'switch-agent' &&
      (!frameworkIds.includes(request.framework) || !frameworkIds.includes(request.expectedFramework))) {
    throw inputError(`framework and expectedFramework must be one of: ${frameworkIds.join(', ')}.`)
  }
  if (action === 'download') absolute(request.destination, 'destination')
  if (action === 'respond-plan') {
    const response = object(request.response, 'response')
    if (Object.hasOwn(response, 'feedback')) {
      keys(response, ['feedback'], 'response')
      string(response.feedback, 'response.feedback')
    } else {
      keys(response, ['decision', 'artifactVersionId', 'expectedRevision'], 'response')
      if (!['approved', 'rejected'].includes(response.decision)) {
        throw inputError('response.decision must be approved or rejected.')
      }
      string(response.artifactVersionId, 'response.artifactVersionId')
      if (!Number.isSafeInteger(response.expectedRevision) || response.expectedRevision < 0) {
        throw inputError('response.expectedRevision must be a nonnegative integer.')
      }
    }
  }
  return request
}

async function download(client, { artifactId, destination }, options) {
  // Publish only a complete file and leave an existing destination intact.
  const staging = await mkdtemp(join(dirname(destination), '.open-science-download-'))
  const temporary = join(staging, 'artifact')
  try {
    await client(['artifacts', 'download', artifactId, '--output', temporary], {
      ...options, timeoutMs: downloadTimeoutMs
    })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await link(temporary, destination)
    return { artifactId, destination }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function switchAgent(client, { framework, expectedFramework }, options) {
  const runtimes = await client(['runtime', 'list'], options)
  const runtime = runtimes.find(entry => entry.framework === framework)
  const show = ['settings', 'agent-routing', 'show']
  const previous = await client(show, options)
  const current = previous.configured.framework
  if (current !== expectedFramework) {
    throw Object.assign(new Error(`The selected instance now uses ${current}. Read its routing before retrying.`), {
      code: 'routing_changed'
    })
  }
  if (current !== framework) {
    await client(['settings', 'agent-routing', 'update', '--framework', framework], options)
  }
  const routing = await client(show, options)
  if (routing.configured.framework !== framework) {
    throw Object.assign(new Error('The selected instance does not report the requested framework. Read its routing before retrying.'), {
      code: 'routing_changed'
    })
  }
  return { previousFramework: current, framework, changed: current !== framework, runtime, routing }
}

function submissionArguments({ requestId, run }) {
  const args = ['run', '--project', run.project, '--request-id', requestId]
  for (const [option, value] of [
    ['--session', run.sessionId],
    ['--cwd', run.cwd],
    ['--approval-profile', run.permissionProfile],
    ['--permission-prompts', run.permissionPrompts]
  ]) {
    if (value !== undefined) args.push(option, value)
  }
  if (run.turnIntent === 'plan-first') args.push('--plan-first')
  if (run.autoReviewEnabled !== undefined) {
    args.push(run.autoReviewEnabled ? '--auto-review' : '--no-auto-review')
  }
  if (run.memoryEnabled !== undefined) args.push(run.memoryEnabled ? '--memory' : '--no-memory')
  if (run.specialist !== undefined) args.push('--specialist', run.specialist)
  if (run.delegationPolicy !== undefined) args.push('--delegation', run.delegationPolicy)
  for (const skill of run.skillIds ?? []) args.push('--skill', skill)
  if (run.computeHostIds?.length === 0) {
    // Both lists were cleared explicitly. The CLI only exposes a combined clear.
    args.push('--clear-compute-hosts')
  } else {
    for (const host of run.enabledComputeHostIds ?? []) args.push('--enable-compute-host', host)
    for (const host of run.computeHostIds ?? []) args.push('--compute-host', host)
  }
  if (run.agentConfiguration !== undefined) {
    const { providerId, model, reasoningEffort } = run.agentConfiguration
    if (providerId !== undefined) args.push('--provider', providerId)
    if (model === null) args.push('--provider-default-model')
    else if (model !== undefined) args.push('--model', model)
    if (reasoningEffort !== undefined) args.push('--reasoning-effort', reasoningEffort)
  }
  return args
}

export async function execute(client, request, { signal } = {}) {
  const options = { signal }
  const { action, projectId, sessionId, requestId, runId } = request
  switch (action) {
    case 'health': return { connected: true, version: client.status.appVersion, cliVersion: client.version }
    case 'doctor': return client(['doctor'], options)
    case 'runtimes': return client(['runtime', 'list'], options)
    case 'projects': return client(['project', 'list'], options)
    case 'create-project': return client([
      'project', 'create', request.name, ...(request.description ? ['--description', request.description] : [])
    ], options)
    case 'session': return client(['session', 'status', sessionId], options)
    case 'session-config': return client(['session', 'config', 'show', sessionId], options)
    case 'agent-routing': return client(['settings', 'agent-routing', 'show'], options)
    case 'switch-agent': return switchAgent(client, request, options)
    case 'project-defaults': return client(['project', 'session-defaults', 'show', projectId], options)
    case 'submit': return client(submissionArguments(request), {
      ...options, stdin: request.run.prompt, allowRunResult: true
    })
    case 'submission': return client(['run', 'status', '--request-id', requestId], options)
    case 'run': return client(['run', 'status', runId], options)
    case 'wait': {
      const timeoutMs = request.timeoutMs ?? 10000
      return client(['run', 'wait', runId, '--timeout-ms', String(timeoutMs), '--return-on-attention'], {
        ...options, timeoutMs: timeoutMs + 30_000, allowRunResult: true
      })
    }
    case 'cancel': return client(['run', 'cancel', runId], options)
    case 'plan': return client(['plan', 'show', sessionId], options)
    case 'respond-plan': {
      const { feedback, decision, artifactVersionId, expectedRevision } = request.response
      if (feedback !== undefined) return client(['plan', 'revise', sessionId, '--feedback', feedback], options)
      return client([
        'plan', decision === 'approved' ? 'approve' : 'reject', sessionId,
        '--artifact-version', artifactVersionId, '--revision', String(expectedRevision)
      ], options)
    }
    case 'artifacts': return client(['artifacts', 'list', sessionId], options)
    case 'download': return download(client, request, options)
    default: throw inputError(`Unknown action: ${action}.`)
  }
}
