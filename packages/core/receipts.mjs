import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const requestIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const requestFilePattern = /^([a-f0-9]{64})\.request\.json$/

function receiptError(code, message) {
  return Object.assign(new Error(message), { code })
}

function validateRequestId(requestId) {
  if (typeof requestId !== 'string' || !requestIdPattern.test(requestId)) {
    throw receiptError('invalid_input', 'requestId must contain 1 to 128 letters, digits, underscores, or hyphens.')
  }
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length <= 1024 && value.trim().length > 0 && !value.includes('\0')
}

function hash(requestId) {
  return createHash('sha256').update(requestId).digest('hex')
}

function paths(directory, key) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw receiptError('invalid_config', 'The receipt directory must be an absolute path.')
  }
  return {
    reservation: join(directory, `${key}.request.json`),
    run: join(directory, `${key}.run.json`)
  }
}

function corrupt() {
  return receiptError('receipt_corrupt', 'A local task receipt is invalid. Check the receipt store before submitting again.')
}

async function readRecord(path) {
  let body
  try {
    body = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const record = JSON.parse(body)
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw corrupt()
    return record
  } catch {
    throw corrupt()
  }
}

async function readReceipt(directory, key) {
  const location = paths(directory, key)
  const reservation = await readRecord(location.reservation)
  if (!reservation) return null
  const { instanceId, binding, projectId, sessionId, requestId, createdAt } = reservation
  if (typeof requestId !== 'string' || !requestIdPattern.test(requestId) || hash(requestId) !== key ||
      ![instanceId, binding, projectId].every(isIdentifier) ||
      (sessionId !== undefined && !isIdentifier(sessionId)) ||
      !Number.isSafeInteger(createdAt) || createdAt < 0) throw corrupt()

  const receipt = { requestId, instanceId, binding, projectId, createdAt }
  if (sessionId !== undefined) receipt.sessionId = sessionId
  const savedRun = await readRecord(location.run)
  if (savedRun) {
    const { runId, runRecordedAt } = savedRun
    if (savedRun.requestId !== requestId || !isIdentifier(runId) ||
        !Number.isSafeInteger(runRecordedAt) || runRecordedAt < 0) throw corrupt()
    receipt.runId = runId
    receipt.runRecordedAt = runRecordedAt
  }
  return receipt
}

async function publishRecord(path, record) {
  // Sync a complete file before adding the public name. The link fails if a competing process won.
  const staging = `${path}.${randomUUID()}.tmp`
  const file = await open(staging, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(staging, path)
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    }
  } finally {
    // A process interruption can leave an unpublished staging file. Readers ignore those files.
    await unlink(staging).catch(() => {})
  }
}

export async function reserveReceipt(directory, { requestId, instanceId, binding, projectId, sessionId }) {
  validateRequestId(requestId)
  if (![instanceId, binding, projectId].every(isIdentifier) ||
      (sessionId !== undefined && !isIdentifier(sessionId))) {
    throw receiptError('invalid_input', 'A task receipt needs a target instance, profile binding, and project ID.')
  }
  const key = hash(requestId)
  const { reservation } = paths(directory, key)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const identity = { requestId, instanceId, binding, projectId }
  if (sessionId !== undefined) identity.sessionId = sessionId
  const candidate = { ...identity, createdAt: Date.now() }
  if (await publishRecord(reservation, candidate)) return { created: true, receipt: candidate }

  const existing = await readReceipt(directory, key)
  if (!existing) throw corrupt()
  if (Object.entries(identity).some(([field, value]) => existing[field] !== value) ||
      existing.sessionId !== sessionId) {
    throw receiptError('receipt_conflict', 'This request ID is already linked to a different task or instance.')
  }
  return { created: false, receipt: existing }
}

export async function getReceipt(directory, requestId) {
  validateRequestId(requestId)
  const receipt = await readReceipt(directory, hash(requestId))
  if (receipt && receipt.requestId !== requestId) throw corrupt()
  return receipt
}

export async function recordRunId(directory, requestId, runId) {
  if (!isIdentifier(runId)) throw receiptError('invalid_input', 'runId must be a nonempty identifier.')
  let receipt = await getReceipt(directory, requestId)
  if (!receipt) throw receiptError('receipt_not_found', 'The local task receipt does not exist.')
  if (receipt.runId === undefined) {
    const { run } = paths(directory, hash(requestId))
    const entry = { requestId, runId, runRecordedAt: Date.now() }
    if (await publishRecord(run, entry)) return { ...receipt, runId, runRecordedAt: entry.runRecordedAt }
    receipt = await getReceipt(directory, requestId)
    if (!receipt) throw corrupt()
  }
  if (receipt.runId !== runId) {
    throw receiptError('receipt_conflict', 'This request ID already has a different Run ID.')
  }
  return receipt
}

export async function listReceipts(directory, { instanceId, projectId, sessionId, runId, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw receiptError('invalid_input', 'Receipt limit must be an integer from 1 to 1000.')
  }
  paths(directory, 'validation')
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const filters = Object.entries({ instanceId, projectId, sessionId, runId }).filter(([, value]) => value !== undefined)
  const receipts = []
  for (const file of entries) {
    const key = requestFilePattern.exec(file)?.[1]
    if (!key) continue
    const receipt = await readReceipt(directory, key)
    if (receipt && filters.every(([field, value]) => receipt[field] === value)) receipts.push(receipt)
  }
  return receipts.sort((a, b) => b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId)).slice(0, limit)
}
