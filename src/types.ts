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

export type AgentMode = "free" | "plan" | "build" | "debug" | "horizon"

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

export type VerificationVerdict = "pass" | "fail" | "skipped" | "unknown"
export type VerificationSource = "manual" | "automatic"

export interface VerificationCommand {
  projectType: Exclude<ProjectType, null>
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null
  script: string | null
  command: string
  args: string[]
  cwd: string
}

/** An immutable, evidence-bearing record for one bounded verification run. */
export interface VerificationReceipt {
  schemaVersion: 2
  id: string
  sessionId: string
  source: VerificationSource
  startedAt: string
  command: string | null
  args: string[]
  cwd: string
  timeoutMs: number
  durationMs: number
  exitCode: number | null
  verdict: VerificationVerdict
  changedFiles: string[]
  stdout: string
  stderr: string
  combined: string
  outputTruncated: boolean
  timedOut: boolean
  skipReason: string | null
}

export interface VerificationLedger {
  schemaVersion: 2
  receipts: VerificationReceipt[]
}

/** @deprecated Prefer VerificationReceipt. Retained for API compatibility. */
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

export type WriteVerdict = VerificationVerdict

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
  receiptId?: string
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
  verificationLedger: VerificationLedger
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
// Horizon agent types
// ---------------------------------------------------------------------------

export type HorizonAutonomyLevel = "full" | "semi" | "supervised"

export type HorizonPhase = "research" | "plan" | "execute" | "audit" | "complete"

export type HorizonPlanStatus = "planning" | "executing" | "completed" | "failed"

export type HorizonItemStatus = "pending" | "in_progress" | "completed" | "failed"

export type HorizonProtocolLevel = "full"

export type HorizonVerificationVerdict = "pass" | "fail" | "skipped" | "unknown"

export type HorizonAuditVerdict = "accept" | "corrective-worker"

export interface HorizonPlan {
  schemaVersion: string
  sessionId: string
  goal: string
  autonomyLevel: HorizonAutonomyLevel
  status: HorizonPlanStatus
  createdAt: string
  completedAt: string | null
  milestones: HorizonMilestone[]
  skills: {
    global: string[]
    sessionScoped: string[]
  }
  stats: {
    totalFeatures: number
    completedFeatures: number
    failedFeatures: number
    totalRetries: number
    estimatedCost: number | null
  }
}

export interface HorizonMilestone {
  id: string
  name: string
  description: string
  status: HorizonItemStatus
  order: number
  requiresApproval: boolean
  features: HorizonFeature[]
}

export interface HorizonFeature {
  id: string
  name: string
  description: string
  acceptanceCriteria: string
  protocolLevel: HorizonProtocolLevel
  status: HorizonItemStatus
  order: number
  subAgentSessionId: string | null
  /** Bounded supervisor-facing summary; full implementation stays in child trace. */
  workerSummary?: string | null
  attempts: number
  maxAttempts: number
  verification: {
    /** True only when backed by the persisted observed receipt below. */
    passed: boolean
    testResults: string | null
    issues: string[]
    /** Advisory evaluator score; never determines `passed` or readiness. */
    score: number | null
    receiptId?: string | null
    verdict?: HorizonVerificationVerdict | null
  }
  audit?: {
    verdict: HorizonAuditVerdict
    subAgentSessionId: string
    traceId: string | null
    summary: string
  } | null
  skillsRequired: string[]
  skillsGenerated: string[]
}

export interface HorizonState {
  sessionId: string
  currentPhase: HorizonPhase
  activeSubAgents: string[]
  currentMilestoneId: string | null
  currentFeatureId: string | null
  lastCheckpoint: string | null
  pausedAt: string | null
  pauseReason: string | null
}

export interface HorizonDecision {
  timestamp: string
  feature: string
  ambiguity: string
  researchResult: string
  decision: string
  rationale: string
  confidence: "high" | "medium" | "low"
}

export interface HorizonSessionMeta {
  goal: string
  createdAt: string
  status: HorizonPlanStatus
  autonomyLevel: HorizonAutonomyLevel
}

export interface HorizonIndex {
  sessions: Record<string, HorizonSessionMeta>
}

export interface HorizonConfig {
  autonomyLevel: HorizonAutonomyLevel
  autoApproveMilestones: boolean
  maxRetryCycles: number
  decisionConfidenceThreshold: number
  pauseOnCriticalFailure: boolean
  testCommand: string
  lintCommand: string
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Hyperplan types -- adversarial plan hardening
// ---------------------------------------------------------------------------

export type HyperplanMode = "generate" | "synthesize"

export interface HyperplanAngle {
  id: string
  name: string
  attackVector: string
  instruction: string
  focusAreas: string[]
  severity: "critical" | "major" | "minor"
}

export interface HyperplanCritique {
  angleId: string
  angleName: string
  findings: string
  severity: "critical" | "major" | "minor"
  affectedAreas: string[]
}

export interface HyperplanResult {
  complexity: "trivial" | "moderate" | "complex"
  reason: string
  skipped: boolean
  angles: HyperplanAngle[]
  prompts: Array<{ angleId: string; prompt: string }>
}

export interface HyperplanSynthesis {
  confidence: number
  survivingInsights: string[]
  rejectedCritiques: Array<{ critique: string; reason: string }>
  hardenedPlan: string
  summary: string
}

export interface ParallaxConfig {
  strictness?: "strict" | "standard" | "relaxed"
  minScore?: number
  adaptiveProtocol?: boolean
  designDocRequired?: boolean
  trivialPatterns?: string[]
  highRiskPatterns?: string[]
}
