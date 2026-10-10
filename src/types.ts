export type Verdict = "pass" | "fail" | "skipped" | "unknown"

export type Strictness = "strict" | "standard" | "relaxed"

export interface ParallaxConfig {
  strictness: Strictness
  trivialPatterns: string[]
  highRiskPatterns: string[]
  timeoutMs: number
}

export interface Check {
  command: string
  args: string[]
  cwd: string
}

export interface Receipt {
  v: 3
  id: string
  session: string
  at: string
  cwd: string
  command: string | null
  args: string[]
  timeoutMs: number
  durationMs: number
  exitCode: number | null
  verdict: Verdict
  files: string[]
  output: string
  truncated: boolean
  timedOut: boolean
  reason: string | null
}

export type Ambiguity = "low" | "medium" | "high"

export type Decision = "full" | "partial" | "hold" | "override"

export interface Preflight {
  at: string
  ambiguity: Ambiguity
  criteria: string
  invariants: string
}

export interface Session {
  v: 3
  id: string
  agent: string | null
  preflight: Preflight | null
  pending: string[]
  receipts: string[]
  lastFail: { id: string; output: string } | null
  closed: { at: string; decision: Decision; summary: string } | null
}

export type Autonomy = "full" | "manual"

export type FeatureStatus = "pending" | "review" | "completed" | "blocked"

export type BlockerKind =
  | "credentials"
  | "external-service"
  | "platform"
  | "framework"
  | "structural"
  | "permissions"
  | "user-cancelled"

export interface Blocker {
  kind: BlockerKind
  evidence: string
  at: string
  source: "agent" | "event"
}

export type Strategy = "correct" | "replan" | "research" | "decompose"

export interface Attempt {
  worker: string
  receipt: string
  verdict: Verdict
  summary: string
  auditor: string | null
  audit: "accept" | "corrective" | null
  auditSummary: string | null
}

export interface Feature {
  id: string
  name: string
  criteria: string
  status: FeatureStatus
  attempts: Attempt[]
  blocker: Blocker | null
}

export interface Milestone {
  id: string
  name: string
  features: Feature[]
}

export interface Plan {
  v: 2
  id: string
  session: string
  root: string
  goal: string
  autonomy: Autonomy
  createdAt: string
  completedAt: string | null
  pause: Blocker | null
  seq: number
  milestones: Milestone[]
}

export interface Note {
  at: string
  kind: "decision" | "research"
  feature: string | null
  text: string
}

export interface FeatureInput {
  id?: string
  name: string
  criteria: string
}

export interface MilestoneInput {
  name: string
  features: FeatureInput[]
}
