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
} from "fs"
import { homedir } from "os"
import { basename, join, resolve } from "path"

import type {
  HorizonPlan,
  HorizonState,
  HorizonDecision,
  HorizonConfig,
  HorizonIndex,
  HorizonSessionMeta,
  HorizonAutonomyLevel,
  HorizonPlanStatus,
  HorizonFeature,
  HorizonMilestone,
} from "./types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HORIZON_DIR = join(homedir(), ".parallax", "horizon")
const SESSIONS_DIR = join(HORIZON_DIR, "sessions")
const CONFIG_PATH = join(HORIZON_DIR, "config.json")
const INDEX_PATH = join(HORIZON_DIR, "index.json")

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
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8")
  renameSync(tmp, path)
}

function writeTextAtomic(path: string, value: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, value, "utf8")
  renameSync(tmp, path)
}

function sessionDir(sessionId: string): string {
  return containedPath(SESSIONS_DIR, assertSafeId("sessionId", sessionId))
}

function now(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: HorizonConfig = {
  autonomyLevel: "full",
  autoApproveMilestones: true,
  maxRetryCycles: 3,
  decisionConfidenceThreshold: 0.7,
  pauseOnCriticalFailure: true,
  testCommand: "npm test",
  lintCommand: "npm run lint",
}

export function loadHorizonConfig(): HorizonConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf8")
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as HorizonConfig
    }
  } catch {
    // Invalid JSON or missing file -> use defaults
  }
  return { ...DEFAULT_CONFIG }
}

export function saveHorizonConfig(config: HorizonConfig): void {
  ensureDir(HORIZON_DIR)
  writeJsonAtomic(CONFIG_PATH, config)
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
): void {
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  ensureDir(join(dir, "research"))
  ensureDir(join(dir, "skills"))
  ensureDir(join(dir, "traces"))

  // Create plan.json
  const plan: HorizonPlan = {
    schemaVersion: "1.0",
    sessionId,
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

// ---------------------------------------------------------------------------
// Feature-level updates within a plan
// ---------------------------------------------------------------------------

export function updateHorizonFeature(
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
      // Increment attempts when transitioning to in_progress
      if (updates.status === "in_progress" && current.status !== "in_progress") {
        updates = { ...updates, attempts: (current.attempts || 0) + 1 }
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
          (f) => f.status === "pending" || f.status === "in_progress",
        ).length, 0)

      writeHorizonPlan(sessionId, plan)
      return plan
    }
  }
  return null
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
  const dir = sessionDir(sessionId)
  ensureDir(dir)
  state.lastCheckpoint = now()
  writeJsonAtomic(join(dir, "state.json"), state)
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
  writeFileSync(join(dir, "findings.md"), findings, "utf8")
  writeFileSync(join(dir, "sources.json"), JSON.stringify(sources, null, 2), "utf8")
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
  // Rename session directory with an .archived suffix to indicate completion
  // without deletion, preserving data for post-hoc audit.
  const src = sessionDir(sessionId)
  const dst = sessionDir(`${sessionId}.archived`)
  try {
    if (!existsSync(src)) return false
    // Simple rename approach: mark in the index
    updateIndexEntry(sessionId, (entry) => ({
      ...entry,
      status: "completed" as HorizonPlanStatus,
    }))
    return true
  } catch {
    return false
  }
}
