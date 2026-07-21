/**
 * HORIZON AGENT -- Persistence & Orchestration Module
 *
 * Manages all Horizon agent state on disk: session directories, plans,
 * orchestration state, decision audit logs, research caches, session-scoped
 * skills, and sub-agent trace archives.
 *
 * Directory layout:
 *   ~/.parallax/horizon/
 *     config.json              # Global Horizon config
 *     index.json               # Session UUID -> goal summaries
 *     sessions/<session-uuid>/
 *       plan.json              # Structured plan (milestones + features)
 *       state.json             # Orchestration state
 *       decisions.jsonl        # Auto-decision audit log
 *       research/
 *         findings.md          # Synthesized research summary
 *         sources.json         # URL references with key excerpts
 *       skills/<name>/
 *         SKILL.md             # Session-scoped skill
 *       traces/
 *         <sub-agent-id>.json  # Sub-agent trace exports
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  renameSync,
  unlinkSync,
} from "fs"
import { randomUUID } from "node:crypto"
import { homedir } from "os"
import { basename, join, resolve } from "path"

import type {
  HorizonPlan,
  HorizonDecision,
  HorizonConfig,
  HorizonIndex,
  HorizonSessionMeta,
  HorizonAutonomyLevel,
  HorizonPlanStatus,
  HorizonFeature,
  HorizonMilestone,
  HorizonAuditVerdict,
  HorizonBlocker,
  HorizonBlockerKind,
  HorizonRecoveryDirective,
  HorizonState,
  VerificationReceipt,
} from "./types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HORIZON_DIR = join(homedir(), ".parallax", "horizon")
const SESSIONS_DIR = join(HORIZON_DIR, "sessions")
const CONFIG_PATH = join(HORIZON_DIR, "config.json")
const INDEX_PATH = join(HORIZON_DIR, "index.json")

/** Absolute root used by Horizon's documented global persistence store. */
export function getHorizonDir(): string {
  return HORIZON_DIR
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function assertSafeId(kind: string, value: string): string {
  if (!ID_PATTERN.test(value) || value === "." || value === ".." || basename(value) !== value) {
    throw new Error(`[horizon] Invalid ${kind}: ${value}`)
  }
  return value
}

function containedPath(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(root, ...segments)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + "\\") && !resolvedPath.startsWith(resolvedRoot + "/")) {
    throw new Error(`[horizon] Path escapes root: ${resolvedPath}`)
  }
  return resolvedPath
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8")
  renameSync(tmp, path)
}

function writeTextAtomic(path: string, value: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, value, "utf8")
  renameSync(tmp, path)
}

function sessionDir(sessionId: string): string {
  return containedPath(SESSIONS_DIR, assertSafeId("sessionId", sessionId))
}

function now(): string {
  return new Date().toISOString()
}

function continuationLockPath(sessionId: string): string {
  return join(sessionDir(sessionId), "autopilot.lock")
}

function quarantineLock(path: string): string | null {
  const quarantine = `${path}.${process.pid}.${randomUUID()}.stale`
  try {
    renameSync(path, quarantine)
    return quarantine
  } catch {
    return null
  }
}

/** Acquire a cross-process lease so one idle event creates at most one continuation. */
export function acquireHorizonContinuationLease(
  sessionId: string,
  owner: string,
  ttlMs = 30_000,
): boolean {
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  const path = continuationLockPath(sessionId)
  const writeLease = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify({ owner, expiresAt: Date.now() + ttlMs }), { encoding: "utf8", flag: "wx" })
      return true
    } catch {
      return false
    }
  }
  if (writeLease()) return true
  try {
    const existing = JSON.parse(readFileSync(path, "utf8")) as { expiresAt?: number }
    if (typeof existing.expiresAt === "number" && existing.expiresAt <= Date.now()) {
      const stale = quarantineLock(path)
      if (!stale) return false
      try { unlinkSync(stale) } catch { /* quarantine cleanup is best-effort */ }
      return writeLease()
    }
  } catch {
    // A malformed lock is quarantined atomically so only one contender retries.
    const stale = quarantineLock(path)
    if (!stale) return false
    try { unlinkSync(stale) } catch { /* quarantine cleanup is best-effort */ }
    return writeLease()
  }
  return false
}

export function releaseHorizonContinuationLease(sessionId: string, owner: string): void {
  const path = continuationLockPath(sessionId)
  let existing: { owner?: string }
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as { owner?: string }
  } catch {
    return
  }
  if (existing.owner !== owner) return
  const released = quarantineLock(path)
  if (!released) return
  try { unlinkSync(released) } catch { /* quarantine cleanup is best-effort */ }
}

function withHorizonMutationLock<T>(sessionId: string, action: () => T): T {
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  const path = join(dir, "mutation.lock")
  const owner = `${process.pid}:${randomUUID()}`
  const acquire = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify({ owner, pid: process.pid }), { encoding: "utf8", flag: "wx" })
      return true
    } catch {
      return false
    }
  }
  if (!acquire()) {
    let stale = false
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as { pid?: number }
      if (typeof current.pid === "number") {
        try { process.kill(current.pid, 0) } catch { stale = true }
      }
    } catch {
      stale = true
    }
    if (!stale) throw new Error("[horizon] Session is busy with another durable mutation")
    const quarantined = quarantineLock(path)
    if (!quarantined) throw new Error("[horizon] Session mutation lock is contended")
    try { unlinkSync(quarantined) } catch { /* quarantine cleanup is best-effort */ }
    if (!acquire()) throw new Error("[horizon] Session mutation lock is contended")
  }
  try {
    return action()
  } finally {
    const released = quarantineLock(path)
    if (released) {
      try { unlinkSync(released) } catch { /* quarantine cleanup is best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: HorizonConfig = {
  autonomyLevel: "full",
  autoApproveMilestones: true,
  recoveryEscalationInterval: 3,
  decisionConfidenceThreshold: 0.7,
  testCommand: "npm test",
  lintCommand: "npm run lint",
}

const CONFIG_KEYS = new Set([...Object.keys(DEFAULT_CONFIG), "maxRetryCycles", "pauseOnCriticalFailure"])

export function validateHorizonConfig(value: unknown): HorizonConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[horizon] Config must be a JSON object")
  }
  const input = { ...(value as Record<string, unknown>) }
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`[horizon] Unknown config field: ${key}`)
  }
  // Schema 1.0 compatibility: the former retry cap now controls when the
  // recovery strategy pivots. It never limits the number of attempts.
  if (input.recoveryEscalationInterval === undefined && input.maxRetryCycles !== undefined) {
    input.recoveryEscalationInterval = input.maxRetryCycles
  }
  delete input.maxRetryCycles
  delete input.pauseOnCriticalFailure

  const merged = { ...DEFAULT_CONFIG, ...input } as Record<string, unknown>
  if (!["full", "semi", "supervised"].includes(String(merged.autonomyLevel))) {
    throw new Error("[horizon] autonomyLevel must be full, semi, or supervised")
  }
  if (typeof merged.autoApproveMilestones !== "boolean") {
    throw new Error("[horizon] autoApproveMilestones must be boolean")
  }
  if (!Number.isInteger(merged.recoveryEscalationInterval) ||
      (merged.recoveryEscalationInterval as number) < 1 ||
      (merged.recoveryEscalationInterval as number) > 100) {
    throw new Error("[horizon] recoveryEscalationInterval must be an integer between 1 and 100")
  }
  if (typeof merged.decisionConfidenceThreshold !== "number" || !Number.isFinite(merged.decisionConfidenceThreshold) || merged.decisionConfidenceThreshold < 0 || merged.decisionConfidenceThreshold > 1) {
    throw new Error("[horizon] decisionConfidenceThreshold must be between 0 and 1")
  }
  for (const key of ["testCommand", "lintCommand"]) {
    if (typeof merged[key] !== "string" || !(merged[key] as string).trim() || (merged[key] as string).length > 1000) {
      throw new Error(`[horizon] ${key} must be a non-empty string of at most 1000 characters`)
    }
  }
  return merged as unknown as HorizonConfig
}

const BLOCKER_KINDS = new Set<HorizonBlockerKind>([
  "credentials",
  "permissions",
  "external-service",
  "platform",
  "framework",
  "structural",
  "user-cancelled",
])

export function validateHorizonBlocker(value: unknown): HorizonBlocker {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[horizon] A durable pause requires typed blocker evidence")
  }
  const blocker = value as HorizonBlocker
  if (!BLOCKER_KINDS.has(blocker.kind)) {
    throw new Error("[horizon] Invalid blocker kind")
  }
  if (typeof blocker.evidence !== "string" || blocker.evidence.trim().length < 20 || blocker.evidence.length > 4000) {
    throw new Error("[horizon] Blocker evidence must be between 20 and 4000 characters")
  }
  if (typeof blocker.createdAt !== "string" || !Number.isFinite(Date.parse(blocker.createdAt))) {
    throw new Error("[horizon] Blocker createdAt must be an ISO timestamp")
  }
  if (typeof blocker.resumable !== "boolean") {
    throw new Error("[horizon] Blocker resumable must be boolean")
  }
  return { ...blocker, evidence: blocker.evidence.trim() }
}

const RECOVERY_STRATEGIES: HorizonRecoveryDirective["strategy"][] = [
  "correct",
  "replan",
  "research",
  "decompose",
]

/** Derive a deterministic strategy pivot without imposing an attempt limit. */
export function getHorizonRecoveryDirective(
  feature: Pick<HorizonFeature, "attempts">,
  config: HorizonConfig = loadHorizonConfig(),
): HorizonRecoveryDirective {
  const attempt = Math.max(1, Math.trunc(feature.attempts || 0))
  const cycle = Math.floor((attempt - 1) / config.recoveryEscalationInterval)
  const strategy = RECOVERY_STRATEGIES[cycle % RECOVERY_STRATEGIES.length]
  const directives: Record<HorizonRecoveryDirective["strategy"], string> = {
    correct: "Use the latest receipt and audit findings for a focused correction; do not repeat an unchanged attempt.",
    replan: "Re-read the current workspace and acceptance criteria, identify why prior corrections failed, and implement a materially different plan.",
    research: "Inspect framework documentation, source, and nearby proven patterns before choosing a new implementation approach.",
    decompose: "Split the blocked brief into smaller independently verifiable steps, solve the first root constraint, then re-integrate.",
  }
  return { attempt, startedAt: now(), cycle, strategy, directive: directives[strategy] }
}

export function loadHorizonConfig(): HorizonConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  } catch (error) {
    throw new Error(`[horizon] Config is not valid JSON: ${String(error)}`)
  }
  return validateHorizonConfig(parsed)
}

export function saveHorizonConfig(config: HorizonConfig): void {
  ensureDir(HORIZON_DIR)
  writeJsonAtomic(CONFIG_PATH, validateHorizonConfig(config))
}

// ---------------------------------------------------------------------------
// Session index
// ---------------------------------------------------------------------------

export function loadHorizonIndex(): HorizonIndex {
  try {
    if (existsSync(INDEX_PATH)) {
      const raw = readFileSync(INDEX_PATH, "utf8")
      return JSON.parse(raw) as HorizonIndex
    }
  } catch {
    // Invalid JSON -> start fresh
  }
  return { sessions: {} }
}

export function saveHorizonIndex(index: HorizonIndex): void {
  ensureDir(HORIZON_DIR)
  writeJsonAtomic(INDEX_PATH, index)
}

function updateIndexEntry(
  sessionId: string,
  updater: (entry: HorizonSessionMeta) => HorizonSessionMeta,
): void {
  const index = loadHorizonIndex()
  if (index.sessions[sessionId]) {
    index.sessions[sessionId] = updater(index.sessions[sessionId])
    saveHorizonIndex(index)
  }
}

// ---------------------------------------------------------------------------
// Session initialization
// ---------------------------------------------------------------------------

export function initHorizonSession(
  sessionId: string,
  goal: string,
  autonomyLevel: HorizonAutonomyLevel,
  binding?: { openCodeSessionId: string; workspaceRoot: string },
): void {
  const dir = sessionDir(sessionId)
  if (existsSync(join(dir, "plan.json"))) {
    throw new Error(`[horizon] Session already exists: ${sessionId}`)
  }
  ensureDir(dir)
  ensureDir(join(dir, "research"))
  ensureDir(join(dir, "skills"))
  ensureDir(join(dir, "traces"))

  // Create plan.json
  const plan: HorizonPlan = {
    schemaVersion: "1.1",
    sessionId,
    openCodeSessionId: binding?.openCodeSessionId || null,
    workspaceRoot: binding ? resolve(binding.workspaceRoot) : null,
    goal,
    autonomyLevel,
    status: "planning",
    createdAt: now(),
    completedAt: null,
    milestones: [],
    skills: { global: [], sessionScoped: [] },
    stats: {
      totalFeatures: 0,
      completedFeatures: 0,
      failedFeatures: 0,
      totalRetries: 0,
      estimatedCost: null,
    },
  }
  writeJsonAtomic(join(dir, "plan.json"), plan)

  // Create state.json
  const state: HorizonState = {
    sessionId,
    currentPhase: "research",
    activeSubAgents: [],
    currentMilestoneId: null,
    currentFeatureId: null,
    lastCheckpoint: now(),
    pausedAt: null,
    pauseReason: null,
  }
  writeJsonAtomic(join(dir, "state.json"), state)

  // Create decisions.jsonl (empty)
  writeTextAtomic(join(dir, "decisions.jsonl"), "")

  // Create index entry
  const index = loadHorizonIndex()
  index.sessions[sessionId] = {
    goal,
    createdAt: now(),
    status: "planning",
    autonomyLevel,
    openCodeSessionId: binding?.openCodeSessionId || null,
    workspaceRoot: binding ? resolve(binding.workspaceRoot) : null,
  }
  saveHorizonIndex(index)
}

// ---------------------------------------------------------------------------
// Plan read/write
// ---------------------------------------------------------------------------

export function readHorizonPlan(sessionId: string): HorizonPlan | null {
  try {
    const path = join(sessionDir(sessionId), "plan.json")
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf8")) as HorizonPlan
  } catch {
    return null
  }
}

export function writeHorizonPlan(sessionId: string, plan: HorizonPlan): void {
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  writeJsonAtomic(join(dir, "plan.json"), plan)

  // Sync index status
  updateIndexEntry(sessionId, (entry) => ({ ...entry, status: plan.status }))
}

/** Merge planning changes without allowing execution/evidence history to be erased. */
export function mergeHorizonPlanDefinition(
  existing: HorizonPlan,
  incoming: HorizonPlan,
): HorizonPlan {
  if (existing.sessionId !== incoming.sessionId) {
    throw new Error("[horizon] Cannot merge plans with different session IDs")
  }
  if (existing.status === "completed") {
    throw new Error("[horizon] A completed plan cannot be rewritten")
  }
  const existingFeatures = new Map(existing.milestones.flatMap((milestone) =>
    milestone.features.map((feature) => [feature.id, feature] as const)))
  const incomingIds = new Set(incoming.milestones.flatMap((milestone) =>
    milestone.features.map((feature) => feature.id)))

  const milestones = incoming.milestones.map((milestone) => {
    const priorMilestone = existing.milestones.find((candidate) => candidate.id === milestone.id)
    const features = milestone.features.map((feature) => {
      const prior = existingFeatures.get(feature.id)
      if (!prior) return feature
      // Once receipt/audit evidence exists, the brief it proves is immutable.
      // Replanning must add a new feature rather than relabel old evidence.
      if (prior.status === "in_progress" || prior.status === "completed" || prior.status === "blocked" ||
          prior.verification.receiptId || prior.audit) return prior
      return {
        ...feature,
        status: prior.status,
        subAgentSessionId: prior.subAgentSessionId,
        workerSummary: prior.workerSummary,
        attempts: prior.attempts,
        maxAttempts: prior.maxAttempts,
        recovery: prior.recovery,
        attemptHistory: prior.attemptHistory,
        blocker: prior.blocker,
        verification: prior.verification,
        audit: prior.audit,
        skillsGenerated: prior.skillsGenerated,
      }
    })
    if (priorMilestone) {
      features.push(...priorMilestone.features.filter((feature) => !incomingIds.has(feature.id)))
    }
    const allCompleted = features.length > 0 && features.every((feature) => feature.status === "completed")
    return {
      ...milestone,
      status: allCompleted ? "completed" as const : (priorMilestone?.status || milestone.status),
      features,
    }
  })
  milestones.push(...existing.milestones
    .filter((milestone) => !incoming.milestones.some((candidate) => candidate.id === milestone.id))
    .map((milestone) => ({
      ...milestone,
      features: milestone.features.filter((feature) => !incomingIds.has(feature.id)),
    }))
    .filter((milestone) => milestone.features.length > 0))

  const features = milestones.flatMap((milestone) => milestone.features)
  const completedFeatures = features.filter((feature) => feature.status === "completed").length
  const failedFeatures = features.filter((feature) => feature.status === "failed").length
  const totalRetries = features.reduce((total, feature) => total + (feature.attempts || 0), 0)
  return {
    ...incoming,
    schemaVersion: "1.1",
    openCodeSessionId: existing.openCodeSessionId || incoming.openCodeSessionId || null,
    workspaceRoot: existing.workspaceRoot || incoming.workspaceRoot || null,
    autonomyLevel: existing.autonomyLevel,
    status: existing.milestones.length > 0 ? existing.status : incoming.status,
    createdAt: existing.createdAt,
    completedAt: existing.completedAt,
    milestones,
    skills: {
      global: [...new Set([...existing.skills.global, ...incoming.skills.global])],
      sessionScoped: [...new Set([...existing.skills.sessionScoped, ...incoming.skills.sessionScoped])],
    },
    stats: {
      totalFeatures: features.length,
      completedFeatures,
      failedFeatures,
      totalRetries,
      estimatedCost: incoming.stats.estimatedCost ?? existing.stats.estimatedCost,
    },
  }
}

/** Atomically merge and persist a planning update against the latest execution state. */
export function updateHorizonPlanDefinition(
  sessionId: string,
  incoming: HorizonPlan,
): HorizonPlan {
  return withHorizonMutationLock(sessionId, () => {
    const existing = readHorizonPlan(sessionId)
    if (!existing) throw new Error(`[horizon] Session not found: ${sessionId}`)
    const merged = mergeHorizonPlanDefinition(existing, incoming)
    writeHorizonPlan(sessionId, merged)
    return merged
  })
}

// ---------------------------------------------------------------------------
// Feature-level updates within a plan
// ---------------------------------------------------------------------------

function updateHorizonFeatureUnlocked(
  sessionId: string,
  featureId: string,
  updates: Partial<HorizonFeature>,
): HorizonPlan | null {
  const plan = readHorizonPlan(sessionId)
  if (!plan) return null

  for (const milestone of plan.milestones) {
    const idx = milestone.features.findIndex((f) => f.id === featureId)
    if (idx !== -1) {
      const current = milestone.features[idx]
      if (plan.status === "completed" && updates.status !== "completed") {
        throw new Error("[horizon] A completed plan cannot be reopened")
      }
      if (current.status === "completed" && updates.status !== "completed") {
        throw new Error("[horizon] A completed feature cannot be reopened")
      }
      if (updates.status === "failed" && plan.autonomyLevel === "full") {
        throw new Error("[horizon] Full-autonomy features cannot terminally fail; retry with a new strategy or persist a proven blocker")
      }
      if (updates.status === "blocked") {
        updates = { ...updates, blocker: validateHorizonBlocker(updates.blocker) }
      }
      if (updates.status === "pending" && current.status === "blocked") {
        updates = { ...updates, blocker: null }
      }
      if (updates.status === "in_progress") {
        const workerSessionId = updates.subAgentSessionId?.trim()
        if (current.status !== "pending" && current.status !== "failed") {
          throw new Error("[horizon] A worker can start only from a pending or legacy failed stage")
        }
        if (!workerSessionId) {
          throw new Error("[horizon] Starting a worker requires its child session ID")
        }
        const features = plan.milestones.flatMap((entry) => entry.features)
        if (features.some((feature) => feature.id !== featureId && feature.status === "in_progress")) {
          throw new Error("[horizon] Sequential pipeline permits only one in-progress feature")
        }
        if (features.some((feature) =>
          feature.subAgentSessionId === workerSessionId ||
          feature.audit?.subAgentSessionId === workerSessionId ||
          feature.attemptHistory?.some((attempt) =>
            attempt.workerSessionId === workerSessionId || attempt.auditorSessionId === workerSessionId))) {
          throw new Error("[horizon] Each delegated worker requires a new child session")
        }
        // Preserve superseded IDs before clearing the current evidence so old
        // child sessions and receipts cannot be replayed by a later feature.
        const attemptHistory = [...(current.attemptHistory || [])]
        if (current.subAgentSessionId && !attemptHistory.some((attempt) =>
          attempt.workerSessionId === current.subAgentSessionId)) {
          attemptHistory.push({
            attempt: current.attempts,
            workerSessionId: current.subAgentSessionId,
            receiptId: current.verification.receiptId || null,
            auditorSessionId: current.audit?.subAgentSessionId || null,
          })
        }
        // Starting any initial/corrective worker invalidates evidence from the
        // previous batch. The new worker must produce a new receipt and audit.
        const attempts = (current.attempts || 0) + 1
        updates = {
          ...updates,
          subAgentSessionId: workerSessionId,
          attempts,
          recovery: getHorizonRecoveryDirective({ attempts }),
          attemptHistory,
          blocker: null,
          workerSummary: null,
          verification: {
            passed: false,
            testResults: null,
            issues: [],
            score: null,
            receiptId: null,
            verdict: null,
          },
          audit: null,
        }
      }
      if (updates.status === "completed") {
        if (current.status !== "in_progress" || !horizonFeatureIsReady(current)) {
          throw new Error("[horizon] Completion requires an observed pass receipt and independent accept audit")
        }
        if (updates.subAgentSessionId && updates.subAgentSessionId !== current.subAgentSessionId) {
          throw new Error("[horizon] Completion cannot replace the worker session ID")
        }
      }
      milestone.features[idx] = { ...current, ...updates } as HorizonFeature

      // Recompute plan stats
      let completed = 0
      let failed = 0
      let totalRetries = 0
      for (const m of plan.milestones) {
        for (const f of m.features) {
          if (f.status === "completed") completed++
          if (f.status === "failed") failed++
          totalRetries += f.attempts
        }
      }
      plan.stats.completedFeatures = completed
      plan.stats.failedFeatures = failed
      plan.stats.totalRetries = totalRetries
      plan.stats.totalFeatures = completed + failed +
        plan.milestones.reduce((acc, m) => acc + m.features.filter(
          (f) => f.status === "pending" || f.status === "in_progress" || f.status === "blocked",
        ).length, 0)

      for (const item of plan.milestones) {
        if (item.features.length > 0 && item.features.every((feature) => feature.status === "completed")) {
          item.status = "completed"
        }
      }
      const allFeatures = plan.milestones.flatMap((item) => item.features)
      if (allFeatures.length > 0 && allFeatures.every((feature) => feature.status === "completed")) {
        plan.status = "completed"
        plan.completedAt = plan.completedAt || now()
      }

      writeHorizonPlan(sessionId, plan)
      return plan
    }
  }
  return null
}

export function updateHorizonFeature(
  sessionId: string,
  featureId: string,
  updates: Partial<HorizonFeature>,
): HorizonPlan | null {
  return withHorizonMutationLock(sessionId, () =>
    updateHorizonFeatureUnlocked(sessionId, featureId, updates))
}

export function updateHorizonMilestone(
  sessionId: string,
  milestoneId: string,
  status: HorizonMilestone["status"],
): HorizonPlan | null {
  const plan = readHorizonPlan(sessionId)
  if (!plan) return null

  const ms = plan.milestones.find((m) => m.id === milestoneId)
  if (!ms) return null

  ms.status = status
  writeHorizonPlan(sessionId, plan)
  return plan
}

// ---------------------------------------------------------------------------
// State read/write
// ---------------------------------------------------------------------------

export function readHorizonState(sessionId: string): HorizonState | null {
  try {
    const path = join(sessionDir(sessionId), "state.json")
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf8")) as HorizonState
  } catch {
    return null
  }
}

export function writeHorizonState(sessionId: string, state: HorizonState): void {
  if (!Array.isArray(state.activeSubAgents) || state.activeSubAgents.length > 1) {
    throw new Error("[horizon] Sequential pipeline permits at most one active sub-agent")
  }
  if (state.pausedAt) {
    state.blocker = validateHorizonBlocker(state.blocker)
  } else {
    state.blocker = null
  }
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  state.lastCheckpoint = now()
  writeJsonAtomic(join(dir, "state.json"), state)
}

/** True when full-autonomy work should receive another synthetic continuation turn. */
export function horizonSessionNeedsContinuation(
  plan: HorizonPlan | null,
  state: HorizonState | null,
): boolean {
  if (!plan || plan.autonomyLevel !== "full" || plan.status === "completed") return false
  const hasValidBlocker = (value: unknown): boolean => {
    try { validateHorizonBlocker(value); return true } catch { return false }
  }
  if (state?.pausedAt && hasValidBlocker(state.blocker)) return false
  const features = plan.milestones.flatMap((milestone) => milestone.features)
  if (features.some((feature) =>
    feature.status === "pending" || feature.status === "in_progress" || feature.status === "failed" ||
    (feature.status === "blocked" && !hasValidBlocker(feature.blocker)))) {
    return true
  }
  if (features.length === 0 && plan.status === "planning") return true
  return false
}

// ---------------------------------------------------------------------------
// Observed verification and independent audit evidence
// ---------------------------------------------------------------------------

/** Persist verdict evidence copied from a validated workspace schema-v2 receipt. */
function recordHorizonVerificationReceiptUnlocked(
  sessionId: string,
  featureId: string,
  receipt: VerificationReceipt,
  workerSummary = "",
): HorizonPlan | null {
  const plan = readHorizonPlan(sessionId)
  const feature = plan?.milestones.flatMap((milestone) => milestone.features)
    .find((candidate) => candidate.id === featureId)
  if (!feature) return null
  if (feature.status !== "in_progress" || !feature.subAgentSessionId) {
    throw new Error("[horizon] Receipt evidence requires the current worker stage")
  }
  if (feature.verification.receiptId || feature.audit) {
    throw new Error("[horizon] Receipt evidence is already persisted for this worker stage")
  }
  if (receipt.schemaVersion !== 2 || !["pass", "fail", "skipped", "unknown"].includes(receipt.verdict)) {
    throw new Error("[horizon] Receipt evidence must use schema v2 with an exact verdict")
  }
  if (receipt.sessionId !== feature.subAgentSessionId) {
    throw new Error("[horizon] Receipt does not belong to the current worker session")
  }
  if (plan!.milestones.flatMap((milestone) => milestone.features).some((candidate) =>
    (candidate.id !== featureId && candidate.verification.receiptId === receipt.id) ||
    candidate.attemptHistory?.some((attempt) => attempt.receiptId === receipt.id))) {
    throw new Error("[horizon] Receipt evidence is already assigned to another attempt")
  }
  if (workerSummary.length > 2000) throw new Error("[horizon] Worker summary exceeds 2000 characters")
  const passed = receipt.verdict === "pass"
  return updateHorizonFeatureUnlocked(sessionId, featureId, {
    verification: {
      ...feature.verification,
      passed,
      receiptId: receipt.id,
      verdict: receipt.verdict,
      testResults: receipt.command === null
        ? receipt.skipReason
        : `${receipt.command} ${receipt.args.join(" ")}`.trim(),
      issues: passed ? [] : [`Observed verification verdict: ${receipt.verdict}`],
    },
    workerSummary,
    // A new receipt invalidates any audit of an older worker result.
    audit: null,
  })
}

export function recordHorizonVerificationReceipt(
  sessionId: string,
  featureId: string,
  receipt: VerificationReceipt,
  workerSummary = "",
): HorizonPlan | null {
  return withHorizonMutationLock(sessionId, () =>
    recordHorizonVerificationReceiptUnlocked(sessionId, featureId, receipt, workerSummary))
}

/** Persist a bounded auditor result only after observed receipt evidence exists. */
function recordHorizonAuditUnlocked(
  sessionId: string,
  featureId: string,
  verdict: HorizonAuditVerdict,
  auditorSessionId: string,
  summary: string,
  traceId: string | null = null,
): HorizonPlan | null {
  if (!auditorSessionId.trim()) throw new Error("[horizon] auditorSessionId is required")
  if (summary.length > 2000) throw new Error("[horizon] Auditor summary exceeds 2000 characters")
  const plan = readHorizonPlan(sessionId)
  const feature = plan?.milestones.flatMap((milestone) => milestone.features)
    .find((candidate) => candidate.id === featureId)
  if (!feature) return null
  if (feature.status !== "in_progress" || !feature.verification.receiptId || !feature.verification.verdict) {
    throw new Error("[horizon] Auditor dispatch requires the current worker's observed schema-v2 receipt evidence")
  }
  if (feature.audit) {
    throw new Error("[horizon] An audit is already persisted for this worker stage")
  }
  if (feature.subAgentSessionId === auditorSessionId) {
    throw new Error("[horizon] Auditor must be independent from the worker session")
  }
  if (plan!.milestones.flatMap((milestone) => milestone.features).some((candidate) =>
    candidate.audit?.subAgentSessionId === auditorSessionId ||
    (candidate.id !== featureId && candidate.subAgentSessionId === auditorSessionId) ||
    candidate.attemptHistory?.some((attempt) =>
      attempt.workerSessionId === auditorSessionId || attempt.auditorSessionId === auditorSessionId))) {
    throw new Error("[horizon] Each audit requires a new independent child session")
  }
  if (verdict === "accept" && feature.verification.verdict !== "pass") {
    throw new Error("[horizon] Auditor cannot accept a non-pass verification receipt")
  }
  return updateHorizonFeatureUnlocked(sessionId, featureId, {
    audit: { verdict, subAgentSessionId: auditorSessionId, traceId, summary },
    // A corrective result re-opens the feature for exactly one next worker;
    // accept leaves the current receipt-backed stage intact for completion.
    ...(verdict === "corrective-worker" ? { status: "pending" as const } : {}),
  })
}

export function recordHorizonAudit(
  sessionId: string,
  featureId: string,
  verdict: HorizonAuditVerdict,
  auditorSessionId: string,
  summary: string,
  traceId: string | null = null,
): HorizonPlan | null {
  return withHorizonMutationLock(sessionId, () =>
    recordHorizonAuditUnlocked(
      sessionId, featureId, verdict, auditorSessionId, summary, traceId))
}

/** Store an advisory evaluator score without changing receipt-backed evidence. */
function recordHorizonEvaluationScoreUnlocked(
  sessionId: string,
  featureId: string,
  score: number,
): HorizonPlan | null {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error("[horizon] Evaluation score must be between 0 and 100")
  }
  const plan = readHorizonPlan(sessionId)
  const feature = plan?.milestones.flatMap((milestone) => milestone.features)
    .find((candidate) => candidate.id === featureId)
  if (!feature) return null
  return updateHorizonFeatureUnlocked(sessionId, featureId, {
    verification: { ...feature.verification, score },
  })
}

export function recordHorizonEvaluationScore(
  sessionId: string,
  featureId: string,
  score: number,
): HorizonPlan | null {
  return withHorizonMutationLock(sessionId, () =>
    recordHorizonEvaluationScoreUnlocked(sessionId, featureId, score))
}

/** Acceptance requires both observed passing evidence and an independent audit. */
export function horizonFeatureIsReady(feature: HorizonFeature): boolean {
  return feature.verification.passed === true &&
    feature.verification.verdict === "pass" &&
    Boolean(feature.verification.receiptId) &&
    feature.audit?.verdict === "accept" &&
    feature.audit.subAgentSessionId !== feature.subAgentSessionId
}

// ---------------------------------------------------------------------------
// Decision audit log
// ---------------------------------------------------------------------------

export function appendHorizonDecision(
  sessionId: string,
  decision: HorizonDecision,
): void {
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  appendFileSync(
    join(dir, "decisions.jsonl"),
    JSON.stringify(decision) + "\n",
    "utf8",
  )
}

export function readHorizonDecisions(sessionId: string): HorizonDecision[] {
  try {
    const path = join(sessionDir(sessionId), "decisions.jsonl")
    if (!existsSync(path)) return []
    const raw = readFileSync(path, "utf8")
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HorizonDecision)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Research cache
// ---------------------------------------------------------------------------

export function writeHorizonResearch(
  sessionId: string,
  findings: string,
  sources: Record<string, string>,
): void {
  const dir = join(sessionDir(sessionId), "research")
  ensureDir(dir)
  writeTextAtomic(join(dir, "findings.md"), findings)
  writeJsonAtomic(join(dir, "sources.json"), sources)
}

export function readHorizonResearch(
  sessionId: string,
): { findings: string | null; sources: Record<string, string> } {
  const dir = join(sessionDir(sessionId), "research")
  let findings: string | null = null
  let sources: Record<string, string> = {}

  try {
    const fPath = join(dir, "findings.md")
    if (existsSync(fPath)) findings = readFileSync(fPath, "utf8")
  } catch {
    // Not found
  }

  try {
    const sPath = join(dir, "sources.json")
    if (existsSync(sPath)) {
      sources = JSON.parse(readFileSync(sPath, "utf8"))
    }
  } catch {
    // Not found or invalid
  }

  return { findings, sources }
}

// ---------------------------------------------------------------------------
// Session-scoped skills
// ---------------------------------------------------------------------------

export function createHorizonSkill(
  sessionId: string,
  name: string,
  description: string,
  content: string,
): void {
  assertSafeId("skill name", name)
  const dir = containedPath(join(sessionDir(sessionId), "skills"), name)
  ensureDir(dir)

  const skillContent = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `scope: session`,
    `sessionId: ${sessionId}`,
    "---",
    "",
    content,
  ].join("\n")

  writeTextAtomic(join(dir, "SKILL.md"), skillContent)

  // Register in plan.json
  const plan = readHorizonPlan(sessionId)
  if (plan) {
    if (!plan.skills.sessionScoped.includes(name)) {
      plan.skills.sessionScoped.push(name)
      writeHorizonPlan(sessionId, plan)
    }
  }
}

export function listHorizonSkills(sessionId: string): string[] {
  const dir = join(sessionDir(sessionId), "skills")
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((entry) => {
      const skillPath = join(dir, entry, "SKILL.md")
      return existsSync(skillPath)
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Sub-agent trace archiving
// ---------------------------------------------------------------------------

export function saveHorizonSubAgentTrace(
  sessionId: string,
  subAgentSessionId: string,
  traceData: string,
): void {
  assertSafeId("subAgentSessionId", subAgentSessionId)
  const dir = join(sessionDir(sessionId), "traces")
  ensureDir(dir)
  writeTextAtomic(containedPath(dir, `${subAgentSessionId}.json`), traceData)
}

export function listHorizonTraces(sessionId: string): string[] {
  const dir = join(sessionDir(sessionId), "traces")
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export function listHorizonSessions(): Array<{
  id: string
  meta: HorizonSessionMeta
}> {
  const index = loadHorizonIndex()
  return Object.entries(index.sessions).map(([id, meta]) => ({
    id,
    meta: { ...meta },
  }))
}

// ---------------------------------------------------------------------------
// Session status helpers
// ---------------------------------------------------------------------------

export function getHorizonSessionStatus(
  sessionId: string,
): {
  plan: HorizonPlan | null
  state: HorizonState | null
  decisions: HorizonDecision[]
  research: { findings: string | null; sources: Record<string, string> }
  skills: string[]
  traces: string[]
} {
  return {
    plan: readHorizonPlan(sessionId),
    state: readHorizonState(sessionId),
    decisions: readHorizonDecisions(sessionId),
    research: readHorizonResearch(sessionId),
    skills: listHorizonSkills(sessionId),
    traces: listHorizonTraces(sessionId),
  }
}

// ---------------------------------------------------------------------------
// Session directory cleanup
// ---------------------------------------------------------------------------

export function archiveHorizonSession(sessionId: string): boolean {
  const id = assertSafeId("sessionId", sessionId)
  const src = sessionDir(id)
  // The source ID was validated above, so appending a fixed suffix is safe.
  // Do not run the suffixed name through the 128-character external-ID limit.
  const dst = containedPath(SESSIONS_DIR, `${id}.archived`)
  try {
    if (!existsSync(src) || existsSync(dst)) return false

    // Finalize durable session metadata before moving the complete directory.
    const plan = readHorizonPlan(id)
    if (plan) {
      const features = plan.milestones.flatMap((milestone) => milestone.features)
      if (features.some((feature) => feature.status !== "completed")) return false
      plan.status = "completed"
      plan.completedAt = plan.completedAt || now()
      writeJsonAtomic(join(src, "plan.json"), plan)
    }
    const state = readHorizonState(id)
    if (state) {
      state.currentPhase = "complete"
      state.activeSubAgents = []
      state.currentMilestoneId = null
      state.currentFeatureId = null
      state.lastCheckpoint = now()
      writeJsonAtomic(join(src, "state.json"), state)
    }
    updateIndexEntry(id, (entry) => ({
      ...entry,
      status: "completed" as HorizonPlanStatus,
    }))
    renameSync(src, dst)
    return true
  } catch {
    return false
  }
}
