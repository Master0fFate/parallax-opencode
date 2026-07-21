/** Schema-v2 verification receipt ledger shared by manual and automatic checks. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "fs"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "path"
import type { FrictionState, VerificationLedger, VerificationReceipt } from "./types.js"
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  runVerification,
  type RunVerificationOptions,
} from "./detect.js"
export {
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_OUTPUT_CHARS,
  detectProject,
  discoverVerification,
  getVerifyCommand,
  runVerification,
  type RunVerificationOptions,
} from "./detect.js"
import { addVerificationReceipt, getTrace } from "./trace.js"

const LEDGER_RELATIVE_PATH = join(".parallax", "verification-ledger.jsonl")
const PENDING_CHANGES_FILE = "verification-pending.jsonl"
const CLAIM_PREFIX = "verification-claim-"
const STALE_CLAIM_MS = DEFAULT_VERIFY_TIMEOUT_MS * 2

export interface VerificationChangeClaim {
  path: string
  changedFiles: string[]
}

function safeSessionId(sessionId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) && sessionId !== "." && sessionId !== "..") {
    return sessionId
  }
  return `session-${createHash("sha256").update(sessionId).digest("hex")}`
}

function verificationQueueDir(root: string, sessionId: string): string {
  return join(resolve(root), ".parallax", "sessions", safeSessionId(sessionId))
}

function pendingChangesPath(root: string, sessionId: string): string {
  return join(verificationQueueDir(root, sessionId), PENDING_CHANGES_FILE)
}

function readChangedFiles(path: string): string[] {
  try {
    return [...new Set(readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return []
        try {
          const entry: unknown = JSON.parse(line)
          return typeof entry === "string" && entry.length > 0 ? [entry] : []
        } catch {
          return []
        }
      }))].sort()
  } catch {
    return []
  }
}

/**
 * Append changed-file attribution before scheduling verification. The queue is
 * disk-backed because OpenCode may load tools and hooks in separate contexts.
 */
export function queueVerificationChanges(
  root: string,
  sessionId: string,
  changedFiles: Iterable<string>,
): void {
  const files = [...new Set([...changedFiles].filter((file) => typeof file === "string" && file.length > 0))]
  if (files.length === 0) return
  const path = pendingChangesPath(root, sessionId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, files.map((file) => JSON.stringify(file)).join("\n") + "\n", "utf8")
}

function recoverStaleClaims(root: string, sessionId: string, now = Date.now()): void {
  const dir = verificationQueueDir(root, sessionId)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(CLAIM_PREFIX) || !name.endsWith(".jsonl")) continue
    const claimPath = join(dir, name)
    try {
      if (now - statSync(claimPath).mtimeMs < STALE_CLAIM_MS) continue
      const contents = readFileSync(claimPath, "utf8")
      if (contents) appendFileSync(pendingChangesPath(root, sessionId), contents, "utf8")
      unlinkSync(claimPath)
    } catch {
      // A live verifier may have completed or restored the claim concurrently.
    }
  }
}

/** Atomically claim the current batch; new writes go to a fresh pending file. */
export function claimVerificationChanges(
  root: string,
  sessionId: string,
): VerificationChangeClaim | null {
  try {
    recoverStaleClaims(root, sessionId)
    const pending = pendingChangesPath(root, sessionId)
    const claimPath = join(dirname(pending), `${CLAIM_PREFIX}${randomUUID()}.jsonl`)
    renameSync(pending, claimPath)
    // rename preserves the pending file's old mtime. Refresh the lease so a
    // long-idle batch cannot be mistaken for an abandoned live claim.
    const claimedAt = new Date()
    utimesSync(claimPath, claimedAt, claimedAt)
    const changedFiles = readChangedFiles(claimPath)
    if (changedFiles.length === 0) {
      try { unlinkSync(claimPath) } catch {}
      return null
    }
    return { path: claimPath, changedFiles }
  } catch {
    // Missing pending files and races with another verifier both mean no batch.
    return null
  }
}

export function completeVerificationClaim(claim: VerificationChangeClaim): void {
  try { unlinkSync(claim.path) } catch {}
}

/** Put an unrecorded claim back so a later manual or automatic check can retry it. */
export function restoreVerificationClaim(
  root: string,
  sessionId: string,
  claim: VerificationChangeClaim,
): void {
  try {
    const contents = readFileSync(claim.path, "utf8")
    if (contents) {
      const pending = pendingChangesPath(root, sessionId)
      mkdirSync(dirname(pending), { recursive: true })
      appendFileSync(pending, contents, "utf8")
    }
    unlinkSync(claim.path)
  } catch {
    // A stale-claim recovery can still reclaim an intact claim after interruption.
  }
}

export function verificationLedgerPath(root: string = process.cwd()): string {
  return join(resolve(root), LEDGER_RELATIVE_PATH)
}

function isVerificationReceipt(value: unknown): value is VerificationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  const verdicts = ["pass", "fail", "skipped", "unknown"]
  const coherentVerdict =
    (receipt.verdict === "pass" && receipt.command !== null && receipt.exitCode === 0 && receipt.timedOut === false && receipt.skipReason === null) ||
    (receipt.verdict === "fail" && receipt.command !== null && typeof receipt.exitCode === "number" && receipt.exitCode !== 0 && receipt.timedOut === false && receipt.skipReason === null) ||
    (receipt.verdict === "skipped" && receipt.command === null && receipt.exitCode === null && receipt.timedOut === false && typeof receipt.skipReason === "string" && receipt.skipReason.length > 0) ||
    (receipt.verdict === "unknown" && receipt.command !== null && typeof receipt.skipReason === "string" && receipt.skipReason.length > 0)
  return coherentVerdict && receipt.schemaVersion === 2 &&
    typeof receipt.id === "string" && receipt.id.length > 0 &&
    typeof receipt.sessionId === "string" &&
    (receipt.source === "manual" || receipt.source === "automatic") &&
    typeof receipt.startedAt === "string" &&
    (receipt.command === null || typeof receipt.command === "string") &&
    Array.isArray(receipt.args) && receipt.args.every((arg) => typeof arg === "string") &&
    typeof receipt.cwd === "string" &&
    typeof receipt.timeoutMs === "number" && Number.isFinite(receipt.timeoutMs) && receipt.timeoutMs > 0 &&
    typeof receipt.durationMs === "number" && Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0 &&
    (receipt.exitCode === null || (typeof receipt.exitCode === "number" && Number.isInteger(receipt.exitCode))) &&
    verdicts.includes(String(receipt.verdict)) &&
    Array.isArray(receipt.changedFiles) && receipt.changedFiles.every((file) => typeof file === "string") &&
    typeof receipt.stdout === "string" &&
    typeof receipt.stderr === "string" &&
    typeof receipt.combined === "string" &&
    typeof receipt.outputTruncated === "boolean" &&
    typeof receipt.timedOut === "boolean" &&
    (receipt.skipReason === null || typeof receipt.skipReason === "string")
}

/** Append one complete JSON record. A torn final line is ignored when reading. */
export function appendVerificationReceipt(
  receipt: VerificationReceipt,
  root: string = receipt.cwd,
): void {
  if (!isVerificationReceipt(receipt)) {
    throw new TypeError("Invalid or internally inconsistent schema-v2 verification receipt")
  }
  const path = verificationLedgerPath(root)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, "utf8")
}

export function readVerificationLedger(root: string = process.cwd()): VerificationLedger {
  const path = verificationLedgerPath(root)
  if (!existsSync(path)) return { schemaVersion: 2, receipts: [] }
  try {
    const receipts = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line)
          return isVerificationReceipt(value) ? [value] : []
        } catch {
          return []
        }
      })
    return { schemaVersion: 2, receipts }
  } catch {
    return { schemaVersion: 2, receipts: [] }
  }
}

/** Merge durable evidence into this OpenCode execution context without duplicates. */
export function syncVerificationLedger(
  sessionId: string,
  root: string = process.cwd(),
): VerificationLedger {
  const trace = getTrace(sessionId)
  if (!trace.verificationLedger) trace.verificationLedger = { schemaVersion: 2, receipts: [] }
  const known = new Set(trace.verificationLedger.receipts.map((receipt) => receipt.id))
  for (const receipt of readVerificationLedger(root).receipts) {
    if (receipt.sessionId !== sessionId || known.has(receipt.id)) continue
    trace.verificationLedger.receipts.push(receipt)
    known.add(receipt.id)
  }
  return trace.verificationLedger
}

/** Run and record through the one canonical path used by every trigger. */
export function verifyAndRecord(options: RunVerificationOptions): VerificationReceipt {
  const receipt = runVerification(options)
  // Hydrate evidence from other OpenCode contexts before adding this run.
  syncVerificationLedger(options.sessionId, options.directory)
  addVerificationReceipt(options.sessionId, receipt)
  // Let persistence errors reach the batch state machine. It will retain the
  // changed-file claim for retry rather than silently losing durable evidence.
  appendVerificationReceipt(receipt, options.directory)
  return receipt
}

/**
 * Advance friction health from evidence. Skips/unknowns do not claim success or
 * consume repair budget; a pass always restores health after prior failures.
 */
export function applyVerificationReceipt(
  state: FrictionState,
  receipt: VerificationReceipt,
  maxRetries: number,
): void {
  if (receipt.verdict === "skipped" || receipt.verdict === "unknown") return
  state.trials++
  if (receipt.verdict === "pass") {
    state.successes++
    state.retriesLeft = maxRetries
    state.lastObservation = null
    return
  }
  state.retriesLeft = Math.max(0, state.retriesLeft - 1)
  state.lastObservation = receipt.combined || receipt.skipReason || "Verification failed without output"
}
