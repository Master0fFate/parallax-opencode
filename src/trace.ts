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

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import type {
  ParallaxTrace,
  PhaseName,
  WriteVerdict,
  PhaseRecord,
  WriteRecord,
  TraceMetrics,
  ProjectType,
} from "./types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACE_DIR_RELATIVE = join(".parallax", "traces")
const TRACE_SCHEMA_VERSION = "1.0"

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

/**
 * Create a fresh empty trace for a session.
 */
function createEmptyTrace(sessionId: string): ParallaxTrace {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    session: {
      id: sessionId,
      agent: "parallax",
      agentVersion: "0.2.0",
      startedAt: new Date().toISOString(),
      endedAt: null,
      project: null,
      projectType: null,
    },
    phases: [],
    writes: [],
    metrics: null,
    coherenceScore: null,
  }
}

/**
 * Initialize trace with session and project metadata.
 */
export function initTrace(sessionId: string, project: string | null, projectType: ProjectType): void {
  const trace = getTrace(sessionId)
  trace.session.project = project
  trace.session.projectType = projectType
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
): void {
  const trace = getTrace(sessionId)
  const record: WriteRecord = {
    file,
    timestamp: new Date().toISOString(),
    verification,
    frictionRetriesLeft,
  }
  trace.writes.push(record)
}

/**
 * Compute metrics for the trace.
 */
export function computeMetrics(trace: ParallaxTrace): TraceMetrics {
  const started = new Date(trace.session.startedAt).getTime()
  const now = Date.now()
  const durationSeconds = Math.round((now - started) / 1000)

  const totalWrites = trace.writes.length
  const totalWritesWithData = trace.writes.filter((w) => w.verification !== "unknown").length
  const passes = trace.writes.filter((w) => w.verification === "pass").length
  const firstPass = trace.writes.filter(
    (w) => w.verification === "pass" && w.frictionRetriesLeft >= 3,
  ).length
  const totalFrictionRetries = trace.writes.reduce(
    (sum, w) => sum + (3 - w.frictionRetriesLeft),
    0,
  )

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
    verificationPassRate:
      totalWritesWithData > 0 ? passes / totalWritesWithData : 0,
    firstAttemptPassRate:
      totalWrites > 0 ? firstPass / totalWrites : 0,
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
  return trace
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Get the trace directory path for the current project.
 * Creates the directory if it doesn't exist.
 */
function getTraceDir(): string {
  const dir = join(process.cwd(), TRACE_DIR_RELATIVE)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/**
 * Export the current trace to a JSON file on disk.
 * Returns the file path.
 */
export function exportTrace(sessionId: string, pretty: boolean = false): string {
  const trace = finalizeTrace(sessionId)
  const dir = getTraceDir()
  const filePath = join(dir, `${sessionId}.json`)
  const json = pretty ? JSON.stringify(trace, null, 2) : JSON.stringify(trace)
  writeFileSync(filePath, json, "utf8")
  return filePath
}

/**
 * Export trace with pretty formatting (human-readable).
 */
export function exportTracePretty(sessionId: string): string {
  return exportTrace(sessionId, true)
}

/**
 * List all trace files in the project's trace directory.
 */
export function listTraceFiles(): Array<{ sessionId: string; filePath: string; mtime: Date }> {
  const dir = getTraceDir()
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
export function loadTrace(sessionId: string): ParallaxTrace | null {
  const dir = getTraceDir()
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
