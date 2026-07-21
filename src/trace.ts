/**
 * PARALLAX ENGINE -- Trace Recording & Export
 *
 * Manages the per-session structured reasoning trace. Traces capture every
 * protocol phase, write operation, verification result, and mode switch.
 *
 * Traces persist to `.parallax/traces/<session-id>.json` on demand or
 * on session compaction.
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync } from "fs"
import { randomUUID } from "node:crypto"
import { basename, join, resolve } from "path"
import type {
  ParallaxTrace,
  PhaseName,
  WriteVerdict,
  PhaseRecord,
  WriteRecord,
  TraceMetrics,
  ProjectType,
  VerificationReceipt,
} from "./types.js"
import { computeCoherenceScore, isVerifiedPass } from "./score.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACE_DIR_RELATIVE = join(".parallax", "traces")
const TRACE_SCHEMA_VERSION = "1.0"
const TRACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertSafeTraceId(sessionId: string): string {
  if (!TRACE_ID_PATTERN.test(sessionId) || sessionId === "." || sessionId === ".." || basename(sessionId) !== sessionId) {
    throw new Error(`[parallax] Invalid trace session ID: ${sessionId}`)
  }
  return sessionId
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, contents, "utf8")
  renameSync(temporary, path)
}

// ---------------------------------------------------------------------------
// In-memory trace store (per session ID)
// ---------------------------------------------------------------------------

const traceStore = new Map<string, ParallaxTrace>()

/**
 * Get or create a trace for the given session ID.
 */
export function getTrace(sessionId: string): ParallaxTrace {
  if (!traceStore.has(sessionId)) {
    traceStore.set(sessionId, createEmptyTrace(sessionId))
  }
  return traceStore.get(sessionId)!
}

/** Hydrate a resumed session before any tool/hook appends or exports evidence. */
export function hydrateTrace(
  sessionId: string,
  root: string = process.cwd(),
): ParallaxTrace {
  if (!traceStore.has(sessionId)) {
    const persisted = loadTrace(sessionId, root)
    if (persisted?.session?.id === sessionId) traceStore.set(sessionId, persisted)
  }
  return getTrace(sessionId)
}

/**
 * Create a fresh empty trace for a session.
 */
function createEmptyTrace(sessionId: string): ParallaxTrace {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    session: {
      id: sessionId,
      agent: "parallax",
      agentVersion: "0.7.3",
      startedAt: new Date().toISOString(),
      endedAt: null,
      project: null,
      projectType: null,
    },
    phases: [],
    writes: [],
    verificationLedger: { schemaVersion: 2, receipts: [] },
    metrics: null,
    coherenceScore: null,
  }
}

/**
 * Initialize trace with session and project metadata.
 */
export function initTrace(sessionId: string, project: string | null, projectType: ProjectType): void {
  const trace = project ? hydrateTrace(sessionId, project) : getTrace(sessionId)
  trace.session.project = project
  trace.session.projectType = projectType
  trace.session.endedAt = null
}

/**
 * Record a protocol phase in the trace.
 */
export function addPhase(
  sessionId: string,
  phase: PhaseName,
  data: Record<string, unknown> = {},
): void {
  const trace = getTrace(sessionId)
  const record: PhaseRecord = {
    phase,
    timestamp: new Date().toISOString(),
    data,
  }
  trace.phases.push(record)
}

/**
 * Record a write/edit operation in the trace.
 */
export function addWrite(
  sessionId: string,
  file: string,
  verification: WriteVerdict,
  frictionRetriesLeft: number,
  receiptId?: string,
): void {
  const trace = getTrace(sessionId)
  const record: WriteRecord = {
    file,
    timestamp: new Date().toISOString(),
    verification,
    frictionRetriesLeft,
    ...(receiptId ? { receiptId } : {}),
  }
  trace.writes.push(record)
}

/** Record the same schema-v2 receipt shape for every verification trigger. */
export function addVerificationReceipt(
  sessionId: string,
  receipt: VerificationReceipt,
): void {
  const trace = getTrace(sessionId)
  // Tolerate traces created by pre-v2 callers while keeping new exports canonical.
  if (!trace.verificationLedger) {
    trace.verificationLedger = { schemaVersion: 2, receipts: [] }
  }
  trace.verificationLedger.receipts.push(receipt)
}

/**
 * Compute metrics for the trace.
 */
export function computeMetrics(trace: ParallaxTrace): TraceMetrics {
  const started = new Date(trace.session.startedAt).getTime()
  const now = Date.now()
  const durationSeconds = Math.round((now - started) / 1000)

  const totalWrites = trace.writes.length
  const receipts = trace.verificationLedger?.receipts || []
  const evidence = receipts.length
    ? receipts.map((receipt) => receipt.verdict)
    : trace.writes.map((write) => write.verification)
  const passes = receipts.length
    ? receipts.filter(isVerifiedPass).length
    : evidence.filter((verdict) => verdict === "pass").length
  const firstPassRate = receipts.length
    ? passes / receipts.length
    : totalWrites > 0
      ? trace.writes.filter(
        (w) => w.verification === "pass" && w.frictionRetriesLeft >= 3,
      ).length / totalWrites
      : 0
  // A receipt represents one verification attempt even when its batch contains
  // many files. Do not multiply retry counts by changed-file attribution.
  const totalFrictionRetries = receipts.length
    ? receipts.filter((receipt) => receipt.verdict === "fail").length
    : trace.writes.reduce((sum, w) => sum + (3 - w.frictionRetriesLeft), 0)

  const requiredPhases: PhaseName[] = [
    "ambiguity_check",
    "four_invariants",
    "verification_gate",
    "commit_decision",
    "summary",
  ]
  const uniqueRequiredPhases = new Set(
    trace.phases
      .filter((p) => requiredPhases.includes(p.phase))
      .map((p) => p.phase),
  )

  return {
    durationSeconds,
    totalPhases: trace.phases.length,
    totalWrites,
    // Unknown/skipped evidence remains in the denominator and can never inflate confidence.
    verificationPassRate: evidence.length > 0 ? passes / evidence.length : 0,
    firstAttemptPassRate: firstPassRate,
    totalFrictionRetries,
    protocolStepsCompleted: uniqueRequiredPhases.size,
  }
}

/**
 * Finalize the trace (set end time and compute metrics).
 */
export function finalizeTrace(sessionId: string): ParallaxTrace {
  const trace = getTrace(sessionId)
  trace.session.endedAt = new Date().toISOString()
  trace.metrics = computeMetrics(trace)
  trace.coherenceScore = computeCoherenceScore(trace).total
  return trace
}

export function writeTraceFile(
  trace: ParallaxTrace,
  pretty: boolean = false,
  root: string = process.cwd(),
): string {
  const dir = getTraceDir(root)
  const id = assertSafeTraceId(String(trace.session.id || ""))
  const filePath = join(dir, `${id}.json`)
  const json = pretty ? JSON.stringify(trace, null, 2) : JSON.stringify(trace)
  writeAtomic(filePath, json)
  return filePath
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Get the trace directory path for the current project.
 * Creates the directory if it doesn't exist.
 */
function getTraceDir(root: string = process.cwd()): string {
  const dir = join(resolve(root), TRACE_DIR_RELATIVE)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * Export the current trace to a JSON file on disk.
 * Returns the file path.
 */
export function exportTrace(
  sessionId: string,
  pretty: boolean = false,
  root: string = process.cwd(),
): string {
  assertSafeTraceId(sessionId)
  hydrateTrace(sessionId, root)
  const trace = finalizeTrace(sessionId)
  return writeTraceFile(trace, pretty, root)
}

/**
 * Export trace with pretty formatting (human-readable).
 */
export function exportTracePretty(sessionId: string, root: string = process.cwd()): string {
  return exportTrace(sessionId, true, root)
}

/**
 * List all trace files in the project's trace directory.
 */
export function listTraceFiles(root: string = process.cwd()): Array<{ sessionId: string; filePath: string; mtime: Date }> {
  const dir = getTraceDir(root)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const filePath = join(dir, f)
      let mtime = new Date()
      try {
        mtime = statSync(filePath).mtime
      } catch {
        // fall through to current time
      }
      return {
        sessionId: f.replace(/\.json$/, ""),
        filePath,
        mtime,
      }
    })
}

/**
 * Load a trace from disk by session ID.
 */
export function loadTrace(sessionId: string, root: string = process.cwd()): ParallaxTrace | null {
  assertSafeTraceId(sessionId)
  const dir = getTraceDir(root)
  const filePath = join(dir, `${sessionId}.json`)
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, "utf8")
    return JSON.parse(raw) as ParallaxTrace
  } catch {
    return null
  }
}

/**
 * Delete all in-memory trace state for a session (cleanup).
 */
export function cleanupTrace(sessionId: string): void {
  traceStore.delete(sessionId)
}
