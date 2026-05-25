/**
 * PARALLAX ENGINE -- Shared Types
 *
 * Central type definitions used across the plugin, trace system, score
 * computation, and CLI.
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

export type AgentMode = "free" | "plan" | "build" | "debug"

export type ProtocolStep = "ambiguity" | "invariants" | "gate" | "design" | "commit" | "summary"

export type ProjectType = "cargo" | "tsc" | "lint" | "python" | null

// ---------------------------------------------------------------------------
// Session store types
// ---------------------------------------------------------------------------

export interface FrictionState {
  successes: number
  trials: number
  retriesLeft: number
  lastObservation: string | null
}

export interface ModeState {
  mode: AgentMode
}

export interface ProtocolState {
  ambiguityDone: boolean
  invariantsDone: boolean
  gateDone: boolean
  designDone: boolean
  commitDone: boolean
  summaryDone: boolean
  writesBeforeGate: number
  gateBlocked: boolean
}

// ---------------------------------------------------------------------------
// Verification types
// ---------------------------------------------------------------------------

export interface VerifyResult {
  exitCode: number
  stdout: string
  stderr: string
  combined: string
}

// ---------------------------------------------------------------------------
// Trace types -- the core novel feature
// ---------------------------------------------------------------------------

export type PhaseName =
  | "ambiguity_check"
  | "four_invariants"
  | "verification_gate"
  | "design_check"
  | "mode_switch"
  | "execution"
  | "commit_decision"
  | "summary"

export type WriteVerdict = "pass" | "fail" | "skipped" | "unknown"

export interface PhaseRecord {
  phase: PhaseName
  timestamp: string
  data: Record<string, unknown>
}

export interface WriteRecord {
  file: string
  timestamp: string
  verification: WriteVerdict
  frictionRetriesLeft: number
}

export interface TraceSessionMeta {
  id: string | null
  agent: "parallax"
  agentVersion: string
  startedAt: string
  endedAt: string | null
  project: string | null
  projectType: string | null
}

export interface TraceMetrics {
  durationSeconds: number
  totalPhases: number
  totalWrites: number
  verificationPassRate: number
  firstAttemptPassRate: number
  totalFrictionRetries: number
  protocolStepsCompleted: number
}

export interface ParallaxTrace {
  schemaVersion: "1.0"
  session: TraceSessionMeta
  phases: PhaseRecord[]
  writes: WriteRecord[]
  metrics: TraceMetrics | null
  coherenceScore: number | null
}

// ---------------------------------------------------------------------------
// Score types
// ---------------------------------------------------------------------------

export interface ScoreBreakdown {
  total: number
  protocolCoverage: number
  verificationIntegrity: number
  edgeCaseCoverage: number
  timingDiscipline: number
}

export interface ScoreEntry {
  sessionId: string
  date: string
  score: number
  project: string | null
}

// ---------------------------------------------------------------------------
// CLI types
// ---------------------------------------------------------------------------

export interface CliCommand {
  name: string
  description: string
  usage: string
  run: (args: string[]) => Promise<number>
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface ParallaxConfig {
  strictness?: "strict" | "standard" | "relaxed"
  minScore?: number
  adaptiveProtocol?: boolean
  designDocRequired?: boolean
  trivialPatterns?: string[]
  highRiskPatterns?: string[]
}
