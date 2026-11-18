import { link, mkdtemp, open, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { pipeline } from 'node:stream/promises'

export function inputError(message) {
  return Object.assign(new Error(message), { code: 'invalid_input' })
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
  submit: ['requestId', 'run'],
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
  for (const field of actions[action].filter((field) => field.endsWith('Id'))) {
    if (['sessions', 'receipts'].includes(action) && request[field] === undefined) continue
    string(request[field], field)
  }
  if (action === 'create-project') {
    string(request.name, 'name')
    if (request.description !== undefined && typeof request.description !== 'string') {
      throw inputError('description must be a string.')
    }
  }
  if (action === 'submit') {
    const run = object(request.run, 'run')
    keys(run, runFields, 'run')
    string(run.project, 'run.project')
    string(run.prompt, 'run.prompt')
    if (run.cwd !== undefined) absolute(run.cwd, 'run.cwd')
    if (run.sessionId !== undefined) string(run.sessionId, 'run.sessionId')
    if (run.permissionPrompts === 'none' && run.turnIntent === 'plan-first') {
      throw inputError('Plan First requires an interactive run.')
    }
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
    const response = await client.downloadArtifact(artifactId, options)
    if (!response.body) throw new Error('The service returned an empty download stream.')
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await pipeline(response.body, handle.createWriteStream(), options)
    } finally {
      await handle.close()
    }
    await link(temporary, destination)
    return { artifactId, destination }
  } finally {
    await unlink(temporary).catch(() => {})
    await rmdir(staging).catch(() => {})
  }
}

async function switchAgent(client, { framework, expectedFramework }, options) {
  const runtimes = await client.listRuntimes(options)
  const runtime = runtimes.find(entry => entry.framework === framework)
  const previous = await client.getAgentRouting(options)
  const current = previous.configured.framework
  if (current !== expectedFramework) {
    throw Object.assign(new Error(`The selected instance now uses ${current}. Read its routing before retrying.`), {
      code: 'routing_changed'
    })
  }
  if (current !== framework) await client.updateAgentRouting({ framework }, options)
  const routing = await client.getAgentRouting(options)
  if (routing.configured.framework !== framework) {
    throw Object.assign(new Error('The selected instance does not report the requested framework. Read its routing before retrying.'), {
      code: 'routing_changed'
    })
  }
  return { previousFramework: current, framework, changed: current !== framework, runtime, routing }
}

export async function execute(client, request, { signal } = {}) {
  const options = { signal }
  const { action, projectId, sessionId, requestId, runId } = request
  switch (action) {
    case 'health': {
      const health = await client.health(options)
      return {
        connected: true,
        version: health.version ?? health.appVersion,
        taskCapabilities: health.taskCapabilities ?? []
      }
    }
    case 'doctor': return client.doctor(options)
    case 'runtimes': return client.listRuntimes(options)
    case 'projects': return client.listProjects(options)
    case 'create-project': return client.createProject({
      name: request.name, description: request.description
    }, options)
    case 'sessions': return client.listSessions(projectId, options)
    case 'session': return client.getSession(sessionId, options)
    case 'session-config': return client.getSessionConfiguration(sessionId, options)
    case 'agent-routing': return client.getAgentRouting(options)
    case 'switch-agent': return switchAgent(client, request, options)
    case 'project-defaults': return client.getProjectSessionDefaults(projectId, options)
    case 'submission': return client.getSubmission(requestId, options)
    case 'run': return client.getRun(runId, options)
    case 'wait': return client.waitForRun(runId, {
      ...options,
      returnOnAttention: true,
      timeoutMs: request.timeoutMs ?? 10000
    })
    case 'cancel': return client.cancelRun(runId, options)
    case 'plan': return client.getSessionPlan(sessionId, options)
    case 'respond-plan': return client.respondSessionPlan(sessionId, request.response, options)
    case 'artifacts': return client.listArtifacts(sessionId, options)
    case 'download': return download(client, request, options)
    default: throw inputError(`Unknown action: ${action}.`)
  }
}
