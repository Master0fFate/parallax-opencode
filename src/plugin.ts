/**
 * PARALLAX ENGINE -- Canonical TypeScript Plugin
 *
 * Consolidated source of truth for the Parallax Engine OpenCode plugin.
 * Contains all 7 custom tools, mode state machine (free/plan/build/debug),
 * protocol enforcement, friction-loop verification, skill injection,
 * session state preservation, and trace recording.
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

import type {
  AgentMode,
  ProtocolStep,
  FrictionState,
  ModeState,
  ProtocolState,
  ParallaxConfig,
  HorizonAutonomyLevel,
} from "./types.js"
import { detectProject, runVerify } from "./detect.js"
import {
  initTrace,
  addPhase,
  addWrite,
  exportTrace,
  getTrace,
} from "./trace.js"
import { computeCoherenceScore } from "./score.js"
import * as horizon from "./horizon.js"
import * as hyperplan from "./hyperplan.js"
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FRICTION_RETRIES = 3
const CHECK_DEBOUNCE_MS = 1000
const STATE_DEBOUNCE_MS = 100
const CONFIG_DIR = join(homedir(), ".config", "opencode")
const STATE_FILE = join(".parallax", "state.json")
const CONFIG_FILE = join(".parallax", "config.json")

// ---------------------------------------------------------------------------
// Module-level stores
// ---------------------------------------------------------------------------

const frictionStore = new Map<string, FrictionState>()
const modeStore = new Map<string, ModeState>()
const protocolStore = new Map<string, ProtocolState>()
let currentSessionId: string | null = null
let currentAgentName: string | null = null

// Known agent names for case-insensitive matching. Add new agents here.
const KNOWN_AGENTS = ["parallax", "horizon"] as const

// ---------------------------------------------------------------------------
// Agent name resolution (case-insensitive)
// ---------------------------------------------------------------------------

/**
 * Normalize agent name for case-insensitive comparison.
 * Returns the lowercase, trimmed version of the name, or null if empty.
 */
function normalizeAgentName(name: string | null | undefined): string | null {
  if (!name) return null
  const normalized = name.trim().toLowerCase()
  return normalized || null
}

/**
 * Check if the current agent matches a known agent name (case-insensitive).
 * Use this instead of `currentAgentName === "horizon"` to avoid case-sensitivity bugs.
 */
function isAgent(agentName: string): boolean {
  return normalizeAgentName(currentAgentName) === normalizeAgentName(agentName)
}

// Protocol state uses a fixed key that never changes within a plugin load.
// OpenCode creates multiple internal sessions (root, child, subagent) during
// a single conversation. The protocol state must survive all of them.
const PROTOCOL_KEY = "current"

function sessionId(): string {
  return PROTOCOL_KEY
}

function getFriction(s: string = sessionId()): FrictionState {
  if (!frictionStore.has(s)) {
    frictionStore.set(s, {
      successes: 0,
      trials: 0,
      retriesLeft: MAX_FRICTION_RETRIES,
      lastObservation: null,
    })
  }
  return frictionStore.get(s)!
}

function getMode(s: string = sessionId()): ModeState {
  if (!modeStore.has(s)) {
    modeStore.set(s, { mode: "free" })
  }
  return modeStore.get(s)!
}

function getProtocol(s: string = sessionId()): ProtocolState {
  if (!protocolStore.has(s)) {
    protocolStore.set(s, {
      ambiguityDone: false,
      invariantsDone: false,
      gateDone: false,
      designDone: false,
      commitDone: false,
      summaryDone: false,
      writesBeforeGate: 0,
      gateBlocked: false,
    })
  }
  return protocolStore.get(s)!
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

let configCache: ParallaxConfig | null = null
let configCacheLoaded = false

function loadConfig(): ParallaxConfig {
  if (configCacheLoaded) return configCache || {}
  configCacheLoaded = true
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf8")
      configCache = JSON.parse(raw) as ParallaxConfig
    }
  } catch {
    // Invalid JSON or missing file -> use defaults
  }
  return configCache || {}
}

// ---------------------------------------------------------------------------
// State persistence (Phase 2.1)
// ---------------------------------------------------------------------------

let stateDebounceTimer: ReturnType<typeof setTimeout> | null = null

function flushState(): void {
  try {
    const s = getFriction()
    const m = getMode()
    // Use in-memory state directly. flushState() is called AFTER in-memory
    // stores have been modified (e.g. parallax_checkin sets flags, then calls
    // writeState(true) -> flushState()). Reading from disk here would overwrite
    // the just-set in-memory changes with stale disk data.
    const p = getProtocol()
    const trace = getTrace(sessionId())
    const state = {
      sessionId: "current",
      sessionStart: trace.session.startedAt,
      mode: m.mode,
      friction: {
        successes: s.successes,
        trials: s.trials,
        retriesLeft: s.retriesLeft,
        lastObservation: s.lastObservation,
      },
      protocol: {
        ambiguityDone: p.ambiguityDone,
        invariantsDone: p.invariantsDone,
        gateDone: p.gateDone,
        designDone: p.designDone,
        commitDone: p.commitDone,
        summaryDone: p.summaryDone,
        writesBeforeGate: p.writesBeforeGate,
        gateBlocked: p.gateBlocked,
      },
    }
    // Debug: write BEFORE state file to isolate error
    const json = JSON.stringify(state, null, 2)
    writeFileSync(STATE_FILE, json, "utf8")
  } catch {
  }
}

function writeState(immediate = false): void {
  if (immediate) {
    flushState()
    return
  }
  if (stateDebounceTimer) clearTimeout(stateDebounceTimer)
  stateDebounceTimer = setTimeout(() => {
    stateDebounceTimer = null
    try {
      const s = getFriction()
      const m = getMode()
      // Use in-memory state directly. writeState() is debounced from callers
      // that just modified in-memory stores (tool.execute.before, parallax_checkin).
      // Reading from disk here would overwrite those modifications with stale data.
      const p = getProtocol()
      const state = {
        sessionId: "current",
        sessionStart: getTrace(sessionId()).session.startedAt,
        mode: m.mode,
        friction: {
          successes: s.successes,
          trials: s.trials,
          retriesLeft: s.retriesLeft,
          lastObservation: s.lastObservation,
        },
        protocol: {
          ambiguityDone: p.ambiguityDone,
          invariantsDone: p.invariantsDone,
          gateDone: p.gateDone,
          designDone: p.designDone,
          commitDone: p.commitDone,
          summaryDone: p.summaryDone,
          writesBeforeGate: p.writesBeforeGate,
          gateBlocked: p.gateBlocked,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")
    } catch {
      // Best-effort: don't crash the plugin if disk is full
    }
  }, STATE_DEBOUNCE_MS)
}


// ---------------------------------------------------------------------------
// Read full state from disk and sync all in-memory stores.
// OpenCode loads plugins in separate execution contexts for tools vs hooks.
// In-memory Maps are NOT shared across contexts. This function bridges the
// gap by reading the persisted state.json and updating the current context's
// in-memory stores so that subsequent getProtocol()/getMode()/getFriction()
// calls return the correct values.
// ---------------------------------------------------------------------------

function syncStateFromDisk(): void {
  try {
    if (!existsSync(STATE_FILE)) return
    const raw = readFileSync(STATE_FILE, "utf8")
    const s = JSON.parse(raw)
    if (!s) return

    const sid = sessionId()

    // Sync protocol state
    if (s.protocol) {
      protocolStore.set(sid, {
        ambiguityDone: s.protocol.ambiguityDone === true,
        invariantsDone: s.protocol.invariantsDone === true,
        gateDone: s.protocol.gateDone === true,
        designDone: s.protocol.designDone === true,
        commitDone: s.protocol.commitDone === true,
        summaryDone: s.protocol.summaryDone === true,
        writesBeforeGate: typeof s.protocol.writesBeforeGate === "number" ? s.protocol.writesBeforeGate : 0,
        gateBlocked: s.protocol.gateBlocked === true,
      })
    }

    // Sync mode
    if (s.mode && ["free", "plan", "build", "debug", "horizon"].includes(s.mode)) {
      modeStore.set(sid, { mode: s.mode as AgentMode })
    }

    // Sync friction
    if (s.friction) {
      frictionStore.set(sid, {
        successes: typeof s.friction.successes === "number" ? s.friction.successes : 0,
        trials: typeof s.friction.trials === "number" ? s.friction.trials : 0,
        retriesLeft: typeof s.friction.retriesLeft === "number" ? s.friction.retriesLeft : MAX_FRICTION_RETRIES,
        lastObservation: s.friction.lastObservation || null,
      })
    }
  } catch {
    // Corrupt or unreadable state file -- ignore, defaults will be used
  }
}

// ---------------------------------------------------------------------------
// Read protocol state from disk (write hook reads this, not in-memory Maps)
// ---------------------------------------------------------------------------

function readProtocolFromDisk(): ProtocolState | null {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf8")
      const s = JSON.parse(raw)
      if (s && s.protocol) {
        return {
          ambiguityDone: s.protocol.ambiguityDone === true,
          invariantsDone: s.protocol.invariantsDone === true,
          gateDone: s.protocol.gateDone === true,
          designDone: s.protocol.designDone === true,
          commitDone: s.protocol.commitDone === true,
          summaryDone: s.protocol.summaryDone === true,
          writesBeforeGate: typeof s.protocol.writesBeforeGate === "number" ? s.protocol.writesBeforeGate : 0,
          gateBlocked: s.protocol.gateBlocked === true,
        }
      }
    }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// Skill loader
// ---------------------------------------------------------------------------

const skillCache: Record<string, string | null> = {}

function loadSkill(name: string): string | null {
  if (name in skillCache) return skillCache[name]
  const path = join(CONFIG_DIR, "skills", name, "SKILL.md")
  try {
    const raw = readFileSync(path, "utf8")
    skillCache[name] = raw.replace(/^---[\s\S]*?---\n*/, "")
  } catch {
    skillCache[name] = null
  }
  return skillCache[name]
}

// ---------------------------------------------------------------------------
// Horizon sessions cache (avoid disk read on every system prompt transform)
// ---------------------------------------------------------------------------

let horizonSessionsCache: ReturnType<typeof horizon.listHorizonSessions> | null = null
let horizonSessionsCacheTime = 0
const HORIZON_SESSIONS_CACHE_TTL_MS = 5000

function getCachedHorizonSessions(): ReturnType<typeof horizon.listHorizonSessions> {
  const now = Date.now()
  if (horizonSessionsCache && now - horizonSessionsCacheTime < HORIZON_SESSIONS_CACHE_TTL_MS) {
    return horizonSessionsCache
  }
  horizonSessionsCache = horizon.listHorizonSessions()
  horizonSessionsCacheTime = now
  return horizonSessionsCache
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (!s || s.length <= maxLen) return s || ""
  return s.slice(0, maxLen) + `\n[Truncated at ${maxLen} chars]`
}

// ---------------------------------------------------------------------------
// Step labels & mode metadata
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<ProtocolStep, string> = {
  ambiguity: "Ambiguity Check",
  invariants: "4 Invariants",
  gate: "Verification Gate",
  design: "Design Doc",
  commit: "Commit Decision",
  summary: "Summarize",
}

interface ModeMeta {
  skill: string | null
  label: string | null
}

const MODE_META: Record<AgentMode, ModeMeta> = {
  free:    { skill: null,                    label: null },
  build:   { skill: null,                    label: "PARALLAX BUILD MODE" },
  plan:    { skill: "parallax-plan",         label: "PARALLAX PLAN MODE" },
  debug:   { skill: "parallax-debug",        label: "PARALLAX DEBUG MODE" },
  horizon: { skill: null,                    label: "HORIZON MODE" },
}

// ---------------------------------------------------------------------------
// Debounce timer
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const plugin: Plugin = async ({ client }) => {
    return {
    // -----------------------------------------------------------------------
    // Custom tools
    // -----------------------------------------------------------------------

    tool: {
      // VERIFY
      parallax_verify: tool({
        description:
          "Run the project's verification command (cargo check, tsc, npm run lint, " +
          "python compileall) and return the result. Use this instead of running " +
          "checks manually via bash.",
        args: {},
        async execute() {
          const result = runVerify()
          if (!result) {
            return "[parallax] No known project type -- skipping verification."
          }
          if (result.exitCode === 0) {
            return `[parallax] VERIFICATION PASSED (exit 0)\n${truncate(result.stdout, 500)}`
          }
          return `[parallax] VERIFICATION FAILED (exit ${result.exitCode})\n${truncate(result.combined, 2000)}`
        },
      }),

      // ANALYZE
      parallax_analyze: tool({
        description:
          "Run structured Parallax multi-perspective analysis on a specific component " +
          "or change. Surfaces edge cases, cross-cutting concerns, and verification " +
          "criteria before you write code.",
        args: {
          topic: tool.schema.string().describe(
            "The component, module, function, or change to analyze",
          ),
        },
        async execute(args: { topic: string }) {
          addPhase(sessionId(), "mode_switch", { analysisTopic: args.topic })
          return (
            `[parallax] ANALYSIS FRAMEWORK: ${args.topic}\n\n` +
            `Apply these questions to "${args.topic}":\n\n` +
            `NOMINAL CASE -- What does success look like for ${args.topic}?\n\n` +
            `EDGE CASES:\n` +
            `- Empty states / null / missing inputs\n` +
            `- Boundary conditions / overflow\n` +
            `- Error states / failure paths\n` +
            `- Concurrency / race conditions\n` +
            `- State transitions / interruption safety\n` +
            `- Security (injection, credential exposure, path traversal)\n` +
            `- Backward compatibility (migrations, deprecation)\n\n` +
            `CROSS-CUTTING:\n` +
            `- Error handling: does every failure path produce a clear message?\n` +
            `- Observability: can we trace what happened?\n` +
            `- Performance: hot paths, O(n^2), memory leaks\n` +
            `- Testability: how would each component be tested?\n` +
            `- Rollback: if this fails, how do we undo it?\n\n` +
            `Use grep and read to investigate ${args.topic} in the codebase, ` +
            `then proceed with the Parallax protocol.`
          )
        },
      }),

      // CHECKIN -- protocol step tracking with ordering enforcement
      parallax_checkin: tool({
        description:
          "Mark a protocol step as complete. The plugin tracks this to enforce " +
          "the protocol order. Call this after completing each step.",
        args: {
          step: tool.schema.string().describe(
            "The protocol step to mark complete: ambiguity, invariants, gate, design, commit, summary",
          ),
        },
        async execute(args: { step: string }) {
          const p = getProtocol()
          const step = args.step as ProtocolStep

          if (!STEP_LABELS[step]) {
            return (
              `[parallax] Unknown step "${step}". ` +
              `Valid: ${Object.keys(STEP_LABELS).join(", ")}`
            )
          }

          const sid = sessionId()
          const cfg = loadConfig()

          // Enforce ordering
          if (step === "ambiguity" && !p.ambiguityDone) {
            p.ambiguityDone = true
            addPhase(sid, "ambiguity_check")
            writeState(true)
            return "[parallax] Step 1/6: Ambiguity Check marked complete."
          }
          if (step === "invariants") {
            if (!p.ambiguityDone) {
              return "[parallax] ERROR: Complete Ambiguity Check first (Step 1)."
            }
            p.invariantsDone = true
            addPhase(sid, "four_invariants")
            writeState(true)
            return "[parallax] Step 2/6: 4 Invariants marked complete."
          }
          if (step === "gate") {
            if (!p.invariantsDone) {
              return "[parallax] ERROR: Complete 4 Invariants first (Step 2)."
            }
            p.gateDone = true
            addPhase(sid, "verification_gate")
            writeState(true)
            return "[parallax] Step 3/6: Verification Gate marked complete."
          }
          if (step === "design") {
            if (!p.gateDone && cfg.designDocRequired) {
              return "[parallax] ERROR: Complete Verification Gate first (Step 3)."
            }
            p.designDone = true
            addPhase(sid, "design_check")
            writeState(true)
            return "[parallax] Step 4/6: Design Doc marked complete."
          }
          if (step === "commit") {
            p.commitDone = true
            addPhase(sid, "commit_decision")
            writeState(true)
            return "[parallax] Step 5/6: Commit Decision marked complete."
          }
          if (step === "summary") {
            p.summaryDone = true
            addPhase(sid, "summary")
            writeState(true)

            // Phase 2.3: Post-session retrospective
            const trace = getTrace(sid)
            const breakdown = computeCoherenceScore(trace)
            const s = getFriction()
            const passCount = trace.writes.filter((w) => w.verification === "pass").length
            const failCount = trace.writes.filter((w) => w.verification === "fail").length

            const retrospective = [
              `[parallax] Step 6/6: Summary marked complete. Protocol finished.`,
              ``,
              `## Session Retrospective`,
              ``,
              `**What was built:** ${trace.writes.length} writes across ${trace.phases.length} phases`,
              `**Verification:** ${passCount} passed, ${failCount} failed`,
              `**Coherence Score:** ${breakdown.total}/100`,
              `**Friction:** ${s.successes} ok / ${s.trials} trials, ${s.retriesLeft} retries remaining`,
              ``,
              `**Review Focus:**`,
              failCount > 0
                ? `- ${failCount} verification failures -- review the failed files`
                : `- No verification failures`,
              breakdown.total < 60
                ? `- Low coherence score (${breakdown.total}/100) -- protocol steps may have been skipped`
                : ``,
              breakdown.edgeCaseCoverage < 10
                ? `- Low edge case coverage (${breakdown.edgeCaseCoverage}/20) -- consider running parallax_analyze on critical paths`
                : ``,
            ].filter(Boolean).join("\n")

            return retrospective
          }
          if (p[`${step}Done` as keyof ProtocolState]) {
            return `[parallax] Step "${step}" was already completed.`
          }
          return `[parallax] Unknown step state for "${step}".`
        },
      }),

      // MODE: PLAN
      parallax_plan: tool({
        description:
          "Switch to PLAN mode. Injects the Precision Architect skill for deep " +
          "requirements elicitation and structured planning. Best for Phase 1-3 " +
          "of the protocol. Use this when you need to fully spec out a feature " +
          "before building.",
        args: {},
        async execute() {
          getMode().mode = "plan"
          addPhase(sessionId(), "mode_switch", { mode: "plan" })
          writeState()
          return (
            "[parallax] PLAN mode activated. Precision Architect skill loaded. " +
            "Elicit requirements fully before building."
          )
        },
      }),

      // MODE: BUILD
      parallax_build: tool({
        description:
          "Switch to BUILD mode (default). Standard Parallax execution protocol. " +
          "Best for Phase 4-5 execution work. Use this when you have a clear plan " +
          "and need to write code.",
        args: {},
        async execute() {
          getMode().mode = "build"
          addPhase(sessionId(), "mode_switch", { mode: "build" })
          writeState()
          return (
            "[parallax] BUILD mode activated. Standard Parallax execution protocol. " +
            "Write clean code, verify with parallax_verify."
          )
        },
      }),

      // MODE: DEBUG
      parallax_debug: tool({
        description:
          "Switch to DEBUG mode. Injects the Universal Auditor skill for " +
          "comprehensive post-build audit. Best for Phase 6 review. Use this " +
          "after building to audit quality, security, and correctness.",
        args: {},
        async execute() {
          getMode().mode = "debug"
          addPhase(sessionId(), "mode_switch", { mode: "debug" })
          writeState()
          return (
            "[parallax] DEBUG mode activated. Universal Auditor skill loaded. " +
            "Run a full audit pass."
          )
        },
      }),

      // MODE: HORIZON
      parallax_horizon: tool({
        description:
          "Switch to HORIZON mode. Activates the long-horizon autonomous " +
          "supervisor agent that plans, researches, executes, self-tests, " +
          "and self-iterates until the task is 100% complete. Orchestrates " +
          "sub-agents with Parallax reasoning for deep work. Use for " +
          "multi-hour to multi-day tasks spanning multiple files.",
        args: {},
        async execute() {
          getMode().mode = "horizon"
          addPhase(sessionId(), "mode_switch", { mode: "horizon" })
          writeState()
          return (
            "[parallax] HORIZON mode activated. " +
            "Long-horizon autonomous supervisor loaded. " +
            "I will plan, research, execute, self-test, and self-iterate " +
            "until the task is 100% complete."
          )
        },
      }),

      // -------------------------------------------------------------------
      // HORIZON TOOLS -- persistence & orchestration
      // -------------------------------------------------------------------

      // HORIZON INIT SESSION
      horizon_init_session: tool({
        description:
          "Initialize a new Horizon session directory with plan.json, state.json, " +
          "and index entry. Creates the full directory tree: research/, skills/, traces/. " +
          "Call this at the start of a Horizon task.",
        args: {
          sessionId: tool.schema.string().describe(
            "Unique session ID (e.g., 'session-001')",
          ),
          goal: tool.schema.string().describe(
            "The user's original goal statement",
          ),
          autonomyLevel: tool.schema.string().optional().describe(
            "Autonomy level: full, semi, or supervised (default: full)",
          ),
        },
        async execute(args: {
          sessionId: string
          goal: string
          autonomyLevel?: string
        }) {
          const level = (
            args.autonomyLevel || "full"
          ) as HorizonAutonomyLevel
          if (!["full", "semi", "supervised"].includes(level)) {
            return "[horizon] ERROR: autonomyLevel must be 'full', 'semi', or 'supervised'."
          }
          horizon.initHorizonSession(args.sessionId, args.goal, level)
          client.app.log({
            body: {
              service: "horizon",
              level: "info",
              message: `[horizon] Session '${args.sessionId}' initialized. Goal: ${args.goal.slice(0, 80)}`,
            },
          }).catch(() => {})
          return (
            `[horizon] Session initialized: ${args.sessionId}\n` +
            `Goal: ${args.goal.slice(0, 120)}\n` +
            `Autonomy: ${level}\n` +
            `Directory: ~/.parallax/horizon/sessions/${args.sessionId}/`
          )
        },
      }),

      // HORIZON WRITE PLAN
      horizon_write_plan: tool({
        description:
          "Write or update the plan.json for a Horizon session. Expects the full " +
          "plan object. Validates required fields. Use after defining milestones " +
          "and features during the PLAN phase.",
        args: {
          sessionId: tool.schema.string().describe(
            "Session ID to write the plan for",
          ),
          planJson: tool.schema.string().describe(
            "The full plan object as a JSON string. Must include schemaVersion, " +
            "milestones array, and stats object.",
          ),
        },
        async execute(args: { sessionId: string; planJson: string }) {
          try {
            const plan = JSON.parse(args.planJson)
            if (!plan.schemaVersion || !Array.isArray(plan.milestones)) {
              return (
                "[horizon] ERROR: Invalid plan -- must include schemaVersion " +
                "and milestones array."
              )
            }
            horizon.writeHorizonPlan(args.sessionId, plan)
            const features = plan.milestones.reduce(
              (acc: number, m: { features?: unknown[] }) =>
                acc + (m.features ? m.features.length : 0),
              0,
            )
            return (
              `[horizon] Plan written for session: ${args.sessionId}\n` +
              `Milestones: ${plan.milestones.length}, Features: ${features}`
            )
          } catch (e) {
            return `[horizon] ERROR: Invalid JSON in planJson -- ${String(e)}`
          }
        },
      }),

      // HORIZON READ PLAN
      horizon_read_plan: tool({
        description:
          "Read the current plan.json for a Horizon session. Returns the full " +
          "plan object including milestones, features, stats, and skills. " +
          "Use to check progress during execution.",
        args: {
          sessionId: tool.schema.string().describe(
            "Session ID to read the plan from",
          ),
        },
        async execute(args: { sessionId: string }) {
          const plan = horizon.readHorizonPlan(args.sessionId)
          if (!plan) {
            return "[horizon] No plan found for this session."
          }
          const completed = plan.stats.completedFeatures
          const total = plan.stats.totalFeatures
          const pct = total > 0 ? Math.round((completed / total) * 100) : 0
          return (
            `[horizon] Plan for session: ${args.sessionId}\n` +
            `Status: ${plan.status}\n` +
            `Progress: ${completed}/${total} features (${pct}%)\n` +
            `Milestones: ${plan.milestones.length}\n` +
            `Retries: ${plan.stats.totalRetries}\n` +
            `Autonomy: ${plan.autonomyLevel}\n\n` +
            `Full plan:\n${JSON.stringify(plan, null, 2)}`
          )
        },
      }),

      // HORIZON UPDATE FEATURE
      horizon_update_feature: tool({
        description:
          "Update a single feature's status within a plan. Updates the feature " +
          "and recalculates plan stats (completed/failed/total). Use after a " +
          "sub-agent completes or fails.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          featureId: tool.schema.string().describe(
            "Feature ID to update (e.g., 'feat-001')",
          ),
          status: tool.schema.string().describe(
            "New status: pending, in_progress, completed, or failed",
          ),
          subAgentSessionId: tool.schema.string().optional().describe(
            "Sub-agent session ID if one was dispatched",
          ),
        },
        async execute(args: {
          sessionId: string
          featureId: string
          status: string
          subAgentSessionId?: string
        }) {
          const validStatuses = ["pending", "in_progress", "completed", "failed"]
          if (!validStatuses.includes(args.status)) {
            return (
              `[horizon] ERROR: Invalid status '${args.status}'. ` +
              `Must be one of: ${validStatuses.join(", ")}`
            )
          }
          const updates: Record<string, unknown> = { status: args.status }
          if (args.subAgentSessionId) {
            updates.subAgentSessionId = args.subAgentSessionId
          }
          if (args.status === "in_progress") {
            const plan = horizon.readHorizonPlan(args.sessionId)
            if (plan) {
              const feature = plan.milestones
                .flatMap((m) => m.features)
                .find((f) => f.id === args.featureId)
              if (feature) {
                // RETRY CAP ENFORCEMENT: reject if max retries exceeded
                const config = horizon.loadHorizonConfig()
                if (feature.attempts >= (feature.maxAttempts || config.maxRetryCycles)) {
                  return (
                    `[horizon] RETRY CAP REACHED for '${args.featureId}'. ` +
                    `Attempts: ${feature.attempts}/${feature.maxAttempts || config.maxRetryCycles}. ` +
                    `Mark the feature as 'failed' to move on, or adjust maxRetryCycles in config.`
                  )
                }
                updates.attempts = feature.attempts + 1
              }
            }
          }
          const result = horizon.updateHorizonFeature(
            args.sessionId,
            args.featureId,
            updates as any,
          )
          if (!result) {
            return `[horizon] Feature '${args.featureId}' not found in session ${args.sessionId}.`
          }

          // Progress reporting
          const pct = result.stats.totalFeatures > 0
            ? Math.round((result.stats.completedFeatures / result.stats.totalFeatures) * 100)
            : 0
          const lvl = args.status === "failed" ? "error" : args.status === "completed" ? "info" : "warn"
          client.app.log({
            body: {
              service: "horizon",
              level: lvl,
              message:
                `[horizon] Feature '${args.featureId}' -> ${args.status}. ` +
                `Progress: ${result.stats.completedFeatures}/${result.stats.totalFeatures} (${pct}%)`,
            },
          }).catch(() => {})

          return (
            `[horizon] Feature '${args.featureId}' updated to '${args.status}'\n` +
            `Progress: ${result.stats.completedFeatures}/${result.stats.totalFeatures} (${pct}%)`
          )
        },
      }),

      // HORIZON UPDATE MILESTONE
      horizon_update_milestone: tool({
        description:
          "Update a milestone's status. Use when a milestone's features are " +
          "all complete and you want to mark the milestone done.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          milestoneId: tool.schema.string().describe(
            "Milestone ID to update",
          ),
          status: tool.schema.string().describe(
            "New status: pending, in_progress, completed, or failed",
          ),
        },
        async execute(args: {
          sessionId: string
          milestoneId: string
          status: string
        }) {
          const validStatuses = ["pending", "in_progress", "completed", "failed"]
          if (!validStatuses.includes(args.status)) {
            return (
              `[horizon] ERROR: Invalid status '${args.status}'. ` +
              `Must be one of: ${validStatuses.join(", ")}`
            )
          }
          const result = horizon.updateHorizonMilestone(
            args.sessionId,
            args.milestoneId,
            args.status as any,
          )
          if (!result) {
            return `[horizon] Milestone '${args.milestoneId}' not found.`
          }
          return `[horizon] Milestone '${args.milestoneId}' updated to '${args.status}'.`
        },
      }),

      // HORIZON WRITE STATE
      horizon_write_state: tool({
        description:
          "Write or update the orchestration state.json for a Horizon session. " +
          "Use to track which phase Horizon is in, which milestone/feature is " +
          "active, and any pause state.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          stateJson: tool.schema.string().describe(
            "Partial or full state object as JSON. Fields provided will be merged " +
            "into existing state. The lastCheckpoint is auto-set.",
          ),
        },
        async execute(args: { sessionId: string; stateJson: string }) {
          try {
            const updates = JSON.parse(args.stateJson)
            const existing = horizon.readHorizonState(args.sessionId) || {
              sessionId: args.sessionId,
              currentPhase: "research",
              activeSubAgents: [],
              currentMilestoneId: null,
              currentFeatureId: null,
              lastCheckpoint: null,
              pausedAt: null,
              pauseReason: null,
            }
            const merged = { ...existing, ...updates, sessionId: args.sessionId }
            horizon.writeHorizonState(args.sessionId, merged)
            return (
              `[horizon] State updated for session: ${args.sessionId}\n` +
              `Phase: ${merged.currentPhase}`
            )
          } catch (e) {
            return `[horizon] ERROR: Invalid JSON in stateJson -- ${String(e)}`
          }
        },
      }),

      // HORIZON READ STATE
      horizon_read_state: tool({
        description:
          "Read the current orchestration state.json. Use to check which phase " +
          "is active, what milestone/feature is being worked on, and any pause state.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
        },
        async execute(args: { sessionId: string }) {
          const state = horizon.readHorizonState(args.sessionId)
          if (!state) {
            return "[horizon] No state found for this session."
          }
          return (
            `[horizon] State for session: ${args.sessionId}\n` +
            `Phase: ${state.currentPhase}\n` +
            `Active sub-agents: ${state.activeSubAgents.length}\n` +
            `Current milestone: ${state.currentMilestoneId || "none"}\n` +
            `Current feature: ${state.currentFeatureId || "none"}\n` +
            `Last checkpoint: ${state.lastCheckpoint || "never"}\n` +
            (state.pausedAt
              ? `Paused at: ${state.pausedAt} (reason: ${state.pauseReason || "unknown"})`
              : "Not paused")
          )
        },
      }),

      // HORIZON APPEND DECISION
      horizon_append_decision: tool({
        description:
          "Log an autonomous decision to the session's decisions.jsonl. " +
          "Every auto-resolved ambiguity should be documented here for post-hoc review.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          feature: tool.schema.string().describe(
            "Feature ID this decision relates to",
          ),
          ambiguity: tool.schema.string().describe(
            "What was ambiguous or unclear",
          ),
          researchResult: tool.schema.string().describe(
            "What research or analysis was done",
          ),
          decision: tool.schema.string().describe(
            "What was decided",
          ),
          rationale: tool.schema.string().describe(
            "Why this decision was made",
          ),
          confidence: tool.schema.string().optional().describe(
            "Confidence: high, medium, or low (default: medium)",
          ),
        },
        async execute(args: {
          sessionId: string
          feature: string
          ambiguity: string
          researchResult: string
          decision: string
          rationale: string
          confidence?: string
        }) {
          const decision = {
            timestamp: new Date().toISOString(),
            feature: args.feature,
            ambiguity: args.ambiguity,
            researchResult: args.researchResult,
            decision: args.decision,
            rationale: args.rationale,
            confidence: (args.confidence || "medium") as "high" | "medium" | "low",
          }
          horizon.appendHorizonDecision(args.sessionId, decision)
          return (
            `[horizon] Decision logged for feature '${args.feature}': ` +
            `${args.decision.slice(0, 80)}`
          )
        },
      }),

      // HORIZON READ DECISIONS
      horizon_read_decisions: tool({
        description:
          "Read all logged decisions from the session's decisions.jsonl. " +
          "Returns a chronological list of auto-decisions with rationale.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
        },
        async execute(args: { sessionId: string }) {
          const decisions = horizon.readHorizonDecisions(args.sessionId)
          if (decisions.length === 0) {
            return "[horizon] No decisions logged for this session."
          }
          const lines = decisions.map(
            (d, i) =>
              `  ${i + 1}. [${d.confidence}] ${d.feature}: ${d.decision.slice(0, 100)}`,
          )
          return (
            `[horizon] Decision log for session: ${args.sessionId}\n` +
            `Total: ${decisions.length} decisions\n\n` +
            lines.join("\n")
          )
        },
      }),

      // HORIZON WRITE RESEARCH
      horizon_write_research: tool({
        description:
          "Write research findings and sources for a session. Stores to " +
          "research/findings.md and research/sources.json. Call after the " +
          "RESEARCH phase to cache context.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          findings: tool.schema.string().describe(
            "Structured research findings as markdown text",
          ),
          sourcesJson: tool.schema.string().optional().describe(
            "Optional JSON object mapping URL labels to URLs, as a JSON string",
          ),
        },
        async execute(args: {
          sessionId: string
          findings: string
          sourcesJson?: string
        }) {
          let sources: Record<string, string> = {}
          if (args.sourcesJson) {
            try {
              sources = JSON.parse(args.sourcesJson)
            } catch {
              return "[horizon] ERROR: sourcesJson must be a valid JSON object."
            }
          }
          horizon.writeHorizonResearch(args.sessionId, args.findings, sources)
          return (
            `[horizon] Research written for session: ${args.sessionId}\n` +
            `Findings: ${args.findings.length} chars\n` +
            `Sources: ${Object.keys(sources).length} entries`
          )
        },
      }),

      // HORIZON READ RESEARCH
      horizon_read_research: tool({
        description:
          "Read research findings and sources for a session. Returns the " +
          "synthesized research summary and cached URL references.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
        },
        async execute(args: { sessionId: string }) {
          const research = horizon.readHorizonResearch(args.sessionId)
          if (!research.findings && Object.keys(research.sources).length === 0) {
            return "[horizon] No research found for this session."
          }
          let out = `[horizon] Research for session: ${args.sessionId}\n`
          if (research.findings) {
            out += `\nFindings:\n${research.findings.slice(0, 2000)}`
            if (research.findings.length > 2000) out += "\n... [truncated]"
          }
          if (Object.keys(research.sources).length > 0) {
            out += "\n\nSources:\n"
            out += Object.entries(research.sources)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join("\n")
          }
          return out
        },
      }),

      // HORIZON CREATE SKILL
      horizon_create_skill: tool({
        description:
          "Create a session-scoped skill in the session's skills directory. " +
          "Use when the PLAN phase identifies a gap where a custom skill would " +
          "improve sub-agent output quality. Registers the skill in plan.json.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          name: tool.schema.string().describe(
            "Skill name (kebab-case, e.g., 'react-patterns')",
          ),
          description: tool.schema.string().describe(
            "Short description of what this skill does",
          ),
          content: tool.schema.string().describe(
            "Full skill markdown content (without YAML frontmatter)",
          ),
        },
        async execute(args: {
          sessionId: string
          name: string
          description: string
          content: string
        }) {
          horizon.createHorizonSkill(
            args.sessionId,
            args.name,
            args.description,
            args.content,
          )
          return (
            `[horizon] Skill created: ${args.name}\n` +
            `Path: ~/.parallax/horizon/sessions/${args.sessionId}/skills/${args.name}/SKILL.md`
          )
        },
      }),

      // HORIZON LIST SKILLS
      horizon_list_skills: tool({
        description:
          "List all session-scoped skills created for a session.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
        },
        async execute(args: { sessionId: string }) {
          const skills = horizon.listHorizonSkills(args.sessionId)
          if (skills.length === 0) {
            return "[horizon] No session-scoped skills for this session."
          }
          return (
            `[horizon] Skills for session: ${args.sessionId}\n` +
            skills.map((s) => `  - ${s}`).join("\n")
          )
        },
      }),

      // HORIZON SAVE TRACE
      horizon_save_trace: tool({
        description:
          "Archive a sub-agent's trace data into the session's traces/ directory. " +
          "Call when a sub-agent completes to preserve its reasoning trace for audit.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          subAgentSessionId: tool.schema.string().describe(
            "The sub-agent's session ID",
          ),
          traceData: tool.schema.string().describe(
            "The full trace JSON string to archive",
          ),
        },
        async execute(args: {
          sessionId: string
          subAgentSessionId: string
          traceData: string
        }) {
          horizon.saveHorizonSubAgentTrace(
            args.sessionId,
            args.subAgentSessionId,
            args.traceData,
          )
          return (
            `[horizon] Trace archived for sub-agent: ${args.subAgentSessionId}\n` +
            `Path: ~/.parallax/horizon/sessions/${args.sessionId}/traces/${args.subAgentSessionId}.json`
          )
        },
      }),

      // HORIZON LIST SESSIONS
      horizon_list_sessions: tool({
        description:
          "List all Horizon sessions from the index. Returns UUID, goal, " +
          "status, autonomy level, and creation date for each session.",
        args: {},
        async execute() {
          const sessions = horizon.listHorizonSessions()
          if (sessions.length === 0) {
            return "[horizon] No sessions found."
          }
          const lines = sessions.map(
            (s) =>
              `  ${s.id} | ${s.meta.status} | ${s.meta.autonomyLevel} | ` +
              `${s.meta.createdAt.slice(0, 10)} | ${s.meta.goal.slice(0, 60)}`,
          )
          return (
            `[horizon] Sessions (${sessions.length}):\n\n` +
            lines.join("\n")
          )
        },
      }),

      // HORIZON SESSION STATUS
      horizon_session_status: tool({
        description:
          "Get a comprehensive status snapshot of a session: plan progress, " +
          "current phase, decisions logged, research cached, skills created, " +
          "and traces archived.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
        },
        async execute(args: { sessionId: string }) {
          const status = horizon.getHorizonSessionStatus(args.sessionId)
          if (!status.plan && !status.state) {
            return `[horizon] No session found: ${args.sessionId}`
          }
          const plan = status.plan
          const state = status.state
          const pct = plan && plan.stats.totalFeatures > 0
            ? Math.round((plan.stats.completedFeatures / plan.stats.totalFeatures) * 100)
            : 0

          return (
            `[horizon] Session status: ${args.sessionId}\n\n` +
            `Plan: ${plan ? plan.status : "N/A"}\n` +
            `Phase: ${state ? state.currentPhase : "N/A"}\n` +
            `Progress: ${plan ? `${plan.stats.completedFeatures}/${plan.stats.totalFeatures} (${pct}%)` : "N/A"}\n` +
            `Decisions: ${status.decisions.length} logged\n` +
            `Research: ${status.research.findings ? `${status.research.findings.length} chars` : "none"}\n` +
            `Skills: ${status.skills.length} session-scoped\n` +
            `Traces: ${status.traces.length} archived\n` +
            `Autonomy: ${plan ? plan.autonomyLevel : "N/A"}\n` +
            `Retries: ${plan ? plan.stats.totalRetries : 0}\n` +
            (state?.pausedAt ? `\n[PAUSED] ${state.pauseReason || "Unknown reason"}` : "")
          )
        },
      }),

      // HORIZON EVALUATE SUB-AGENT -- 6-dimension weighted self-check
      horizon_evaluate_subagent: tool({
        description:
          "Evaluate a sub-agent's output across 6 dimensions with weighted scoring. " +
          "Scores each dimension 0-100. Pass threshold is 75% weighted total. " +
          "Logs result to decisions.jsonl and updates feature verification state.",
        args: {
          sessionId: tool.schema.string().describe("Session ID"),
          featureId: tool.schema.string().describe(
            "Feature ID this evaluation relates to",
          ),
          protocolIntegrity: tool.schema.number().describe(
            "Score 0-100: All Parallax steps completed? Coherence >= 60?",
          ),
          verification: tool.schema.number().describe(
            "Score 0-100: Tests pass? No lint errors?",
          ),
          correctness: tool.schema.number().describe(
            "Score 0-100: Output matches acceptance criteria? No logical errors?",
          ),
          designQuality: tool.schema.number().describe(
            "Score 0-100: AI slop detected? Follows project conventions?",
          ),
          edgeCaseCoverage: tool.schema.number().describe(
            "Score 0-100: Null/empty states? Error paths? Boundary conditions?",
          ),
          userPerspective: tool.schema.number().describe(
            "Score 0-100: Works for novice and pro? Intuitive?",
          ),
        },
        async execute(args: {
          sessionId: string
          featureId: string
          protocolIntegrity: number
          verification: number
          correctness: number
          designQuality: number
          edgeCaseCoverage: number
          userPerspective: number
        }) {
          const dims = [
            { key: "protocolIntegrity", label: "Protocol Integrity", score: args.protocolIntegrity, weight: 0.15 },
            { key: "verification",      label: "Verification",       score: args.verification,      weight: 0.25 },
            { key: "correctness",       label: "Correctness",        score: args.correctness,       weight: 0.25 },
            { key: "designQuality",     label: "Design Quality",     score: args.designQuality,     weight: 0.15 },
            { key: "edgeCaseCoverage",  label: "Edge Case Coverage", score: args.edgeCaseCoverage,  weight: 0.10 },
            { key: "userPerspective",   label: "User Perspective",   score: args.userPerspective,   weight: 0.10 },
          ]

          // Validate each dimension
          for (const d of dims) {
            if (d.score < 0 || d.score > 100 || !Number.isFinite(d.score)) {
              return (
                `[horizon] ERROR: ${d.label} must be a number between 0-100. Got ${d.score}.`
              )
            }
          }

          const weightedScore = Math.round(
            dims.reduce((sum, d) => sum + d.score * d.weight, 0),
          )
          const passed = weightedScore >= 75

          // Build breakdown table
          const breakdown = dims.map(
            (d) => `  ${d.label.padEnd(22)} ${String(d.score).padStart(3)}/100 x ${(d.weight * 100)}% = ${Math.round(d.score * d.weight)}`,
          ).join("\n")

          // Log the evaluation as a decision
          const verdict = passed ? "PASS" : "FAIL"
          horizon.appendHorizonDecision(args.sessionId, {
            timestamp: new Date().toISOString(),
            feature: args.featureId,
            ambiguity: `Self-check evaluation for feature ${args.featureId}`,
            researchResult: `6-dimension weighted scoring: ${weightedScore}/100`,
            decision: `${verdict} (threshold: 75%)`,
            rationale: breakdown.replace(/\n/g, "; "),
            confidence: passed ? "high" : "medium",
          })

          // Update feature verification state
          horizon.updateHorizonFeature(args.sessionId, args.featureId, {
            verification: {
              passed,
              testResults: null,
              issues: passed ? [] : [`Self-check scored ${weightedScore}/100, below 75% threshold`],
              score: weightedScore,
            },
          } as any)

          // Progress reporting
          client.app.log({
            body: {
              service: "horizon",
              level: passed ? "info" : "warn",
              message:
                `[horizon] Self-check for '${args.featureId}': ${verdict} ` +
                `(${weightedScore}/100, threshold: 75)`,
            },
          }).catch(() => {})

          return (
            `[horizon] Self-check evaluation for '${args.featureId}': ${verdict}\n` +
            `Weighted score: ${weightedScore}/100 (threshold: 75)\n\n` +
            `Breakdown:\n${breakdown}\n\n` +
            (passed
              ? "All dimensions pass. Feature ready for next step."
              : `Below threshold. Review the low-scoring dimensions and re-dispatch.`)
          )
        },
      }),

      // HORIZON CONFIG
      horizon_config: tool({
        description:
          "Read or write the Horizon global configuration. With no configJson, " +
          "returns current config. With configJson, merges and saves.",
        args: {
          configJson: tool.schema.string().optional().describe(
            "Optional JSON string with config fields to set. Fields: " +
            "autonomyLevel, autoApproveMilestones, maxRetryCycles, " +
            "decisionConfidenceThreshold, pauseOnCriticalFailure, " +
            "testCommand, lintCommand.",
          ),
        },
        async execute(args: { configJson?: string }) {
          if (args.configJson) {
            try {
              const updates = JSON.parse(args.configJson)
              const existing = horizon.loadHorizonConfig()
              const merged = { ...existing, ...updates }
              horizon.saveHorizonConfig(merged)
              return (
                `[horizon] Config updated:\n` +
                `  autonomyLevel: ${merged.autonomyLevel}\n` +
                `  maxRetryCycles: ${merged.maxRetryCycles}\n` +
                `  testCommand: ${merged.testCommand}\n` +
                `  lintCommand: ${merged.lintCommand}`
              )
            } catch (e) {
              return `[horizon] ERROR: Invalid JSON in configJson -- ${String(e)}`
            }
          }
          const config = horizon.loadHorizonConfig()
          return (
            `[horizon] Current config:\n` +
            `  autonomyLevel: ${config.autonomyLevel}\n` +
            `  autoApproveMilestones: ${config.autoApproveMilestones}\n` +
            `  maxRetryCycles: ${config.maxRetryCycles}\n` +
            `  decisionConfidenceThreshold: ${config.decisionConfidenceThreshold}\n` +
            `  pauseOnCriticalFailure: ${config.pauseOnCriticalFailure}\n` +
            `  testCommand: ${config.testCommand}\n` +
            `  lintCommand: ${config.lintCommand}`
          )
        },
      }),

      parallax_hyperplan: tool({
              description: "Multi-round adversarial plan hardening. Supports 3 rounds of critique: " +
                "'analysis' (Round 1 -- independent critiques from N angles), " +
                "'cross-attack' (Round 2 -- each critic attacks others' findings), " +
                "'defense' (Round 3 -- each critic defends/refines/concedes), " +
                "and 'synthesize' (insight bundle with 4 categories: hard constraints, " +
                "decisions, risks, open questions). Built-in complexity detection " +
                "skips trivial plans automatically.",
              args: {
                mode: tool.schema.string().describe("'generate' to create adversarial prompts (use round param to select " +
                  "analysis/cross-attack/defense); 'synthesize' to combine critiques " +
                  "into a structured insight bundle with hard constraints, decisions, " +
                  "risks, and open questions."),
                round: tool.schema.string().optional().describe("For 'generate' mode: 'analysis' (Round 1 -- default), " +
                  "'cross-attack' (Round 2 -- needs 'findings'), " +
                  "'defense' (Round 3 -- needs 'attacks')."),
                plan: tool.schema.string().describe("The plan as a JSON string or markdown description. Analyzed for " +
                  "complexity signals to determine if hyperplan is warranted."),
                angles: tool.schema.string().optional().describe("Optional JSON array of angle IDs to use. Default angles: " +
                  "[\"pragmatist\", \"integration\", \"sentinel\", \"architect\", \"humanist\"]. " +
                  "For 'moderate' complexity plans, only critical-severity angles are used " +
                  "unless custom angles specified."),
                force: tool.schema.boolean().optional().describe("Force hyperplan execution even for trivial plans (default: false). " +
                  "Trivial plans automatically skip to avoid wasted compute."),
                critiques: tool.schema.string().optional().describe("For 'synthesize' mode or cross-attack round. JSON array of critique " +
                  "objects returned by sub-agents. Each critique must include angleId, " +
                  "angleName, findings, severity, affectedAreas."),
                findings: tool.schema.string().optional().describe("For 'cross-attack' round. JSON array of all Round 1 findings. " +
                  "Each entry: { angleId, angleName, findings }. " +
                  "Each critic attacks the other critics' findings."),
                attacks: tool.schema.string().optional().describe("For 'defense' round. JSON object mapping angleId to its attacks. " +
                  "Each attack: { targetFinding, attackerName, attack, severity }. " +
                  "Each critic defends/refines/concedes their own attacked findings."),
                context: tool.schema.string().optional().describe("Optional additional context about the project or codebase. Injected " +
                  "into sub-agent prompts for more targeted critiques."),
              },
              async execute(args) {
                if (args.mode === "generate") {
                  const round = args.round || "analysis";
                  // Parse optional custom angles
                  let customAngles;
                  if (args.angles) {
                    try {
                      customAngles = JSON.parse(args.angles);
                      if (!Array.isArray(customAngles)) {
                        return "[hyperplan] ERROR: 'angles' must be a JSON array of string IDs.";
                      }
                    }
                    catch {
                      return "[hyperplan] ERROR: Invalid JSON in 'angles' parameter.";
                    }
                  }
                  // ROUND 1: Independent analysis prompts
                  if (round === "analysis") {
                    const result = hyperplan.generateHyperplan(args.plan, {
                      customAngles,
                      force: args.force === true,
                      extraContext: args.context,
                    });
                    if (result.skipped) {
                      const prefix = result.complexity === "trivial"
                        ? "TRIVIAL PLAN -- SKIPPING"
                        : "NOT WARRANTED -- SKIPPING";
                      return (`[hyperplan] ${prefix}\n` +
                        `Reason: ${result.reason}\n` +
                        `Complexity: ${result.complexity} (score: ${hyperplan.assessComplexity(args.plan).score})\n` +
                        `\n` +
                        `To force hyperplan on this plan, call again with force=true.`);
                    }
                    const promptsText = result.prompts
                      .map((p, i) => `=== PROMPT ${i + 1}: ${result.angles[i].name} [${result.angles[i].severity.toUpperCase()}] ===\n` +
                      `Angle ID: ${p.angleId}\n` +
                      `Attack Vector: ${result.angles[i].attackVector}\n\n` +
                      p.prompt)
                      .join("\n\n");
                    return (`[hyperplan] ROUND 1: ANALYSIS\n` +
                      `Complexity: ${result.complexity.toUpperCase()} (score: ${hyperplan.assessComplexity(args.plan).score})\n` +
                      `Angles: ${result.angles.length} perspectives\n` +
                      `Reason: ${result.reason}\n\n` +
                      `## DISPATCH INSTRUCTIONS\n` +
                      `Dispatch ${result.angles.length} sub-agents in PARALLEL via task() -- one per prompt below.\n` +
                      `Give each sub-agent its prompt. Collect all critiques as JSON.\n\n` +
                      promptsText + "\n\n" +
                      `## AFTER ROUND 1\n` +
                      `Collect all critiques, then proceed to Round 2 (cross-attack) or synthesize:\n` +
                      `  Round 2: parallax_hyperplan({ mode: "generate", round: "cross-attack", plan: "...", findings: "<all findings JSON>" })\n` +
                      `  Synthesize: parallax_hyperplan({ mode: "synthesize", plan: "...", critiques: "<all critiques JSON>" })`);
                  }
                  // ROUND 2: Cross-attack prompts
                  if (round === "cross-attack") {
                    if (!args.findings) {
                      return ("[hyperplan] ERROR: 'findings' parameter is required for 'cross-attack' round. " +
                        "Provide a JSON array of Round 1 findings from all critics.");
                    }
                    let parsedFindings;
                    try {
                      parsedFindings = JSON.parse(args.findings);
                      if (!Array.isArray(parsedFindings)) {
                        return "[hyperplan] ERROR: 'findings' must be a JSON array.";
                      }
                    }
                    catch {
                      return "[hyperplan] ERROR: Invalid JSON in 'findings' parameter.";
                    }
                    // Use the existing generate to get angles, then generate cross-attack prompts
                    const genResult = hyperplan.generateHyperplan(args.plan, {
                      customAngles,
                      force: args.force === true,
                      extraContext: args.context,
                    });
                    const angles = genResult.angles;
                    if (angles.length === 0) {
                      return "[hyperplan] No angles available for cross-attack. Run Round 1 first.";
                    }
                    const crossAttacks = hyperplan.generateAllCrossAttacks(angles, parsedFindings);
                    const promptsText = crossAttacks
                      .map((ca, i) => `=== CROSS-ATTACK PROMPT ${i + 1}: ${angles[i].name} ===\n` +
                      `Angle ID: ${ca.angleId}\n\n` +
                      ca.prompt)
                      .join("\n\n");
                    return (`[hyperplan] ROUND 2: CROSS-ATTACK\n` +
                      `Angles: ${angles.length} critics\n` +
                      `Findings under attack: ${parsedFindings.length}\n\n` +
                      `## DISPATCH INSTRUCTIONS\n` +
                      `Dispatch ${angles.length} sub-agents in PARALLEL via task() -- one per prompt below.\n` +
                      `Each critic receives ALL other critics' findings and must attack every one.\n\n` +
                      promptsText + "\n\n" +
                      `## AFTER ROUND 2\n` +
                      `Collect all cross-attacks, then proceed to Round 3 (defense):\n` +
                      `  parallax_hyperplan({ mode: "generate", round: "defense", plan: "...", attacks: "<attacks_by_angle JSON>" })`);
                  }
                  // ROUND 3: Defense/refinement prompts
                  if (round === "defense") {
                    if (!args.attacks) {
                      return ("[hyperplan] ERROR: 'attacks' parameter is required for 'defense' round. " +
                        "Provide a JSON object mapping each angleId to its attacks array.");
                    }
                    let parsedAttacks;
                    try {
                      parsedAttacks = JSON.parse(args.attacks);
                      if (typeof parsedAttacks !== "object" || Array.isArray(parsedAttacks)) {
                        return "[hyperplan] ERROR: 'attacks' must be a JSON object mapping angleId to attack arrays.";
                      }
                    }
                    catch {
                      return "[hyperplan] ERROR: Invalid JSON in 'attacks' parameter.";
                    }
                    const genResult = hyperplan.generateHyperplan(args.plan, {
                      customAngles,
                      force: args.force === true,
                      extraContext: args.context,
                    });
                    const angleMap = new Map(genResult.angles.map((a) => [a.id, a]));
                    const defensePrompts = [];
                    for (const [angleId, attacks] of Object.entries(parsedAttacks)) {
                      const angle = angleMap.get(angleId);
                      if (!angle)
                        continue;
                      const prompt = hyperplan.generateDefensePrompt(angle, attacks as Array<{ targetFinding: string; attackerName: string; attack: string; severity: string }>);
                      defensePrompts.push({ angleId, prompt });
                    }
                    if (defensePrompts.length === 0) {
                      return "[hyperplan] No defense prompts generated. Check that angle IDs match.";
                    }
                    const promptsText = defensePrompts
                      .map((dp, i) => `=== DEFENSE PROMPT ${i + 1}: ${genResult.angles.find((a) => a.id === dp.angleId)?.name || dp.angleId} ===\n\n` +
                      dp.prompt)
                      .join("\n\n");
                    return (`[hyperplan] ROUND 3: DEFENSE & REFINEMENT\n` +
                      `Critics defending: ${defensePrompts.length}\n\n` +
                      `## DISPATCH INSTRUCTIONS\n` +
                      `Dispatch ${defensePrompts.length} sub-agents in PARALLEL via task().\n` +
                      `Each critic receives ONLY the attacks against their own findings.\n` +
                      `They must DEFEND, REFINE, or CONCEDE each point.\n\n` +
                      promptsText + "\n\n" +
                      `## AFTER ROUND 3\n` +
                      `Collect all defenses, then produce the final insight bundle:\n` +
                      `  parallax_hyperplan({ mode: "synthesize", plan: "...", critiques: "<all critiques JSON>" })`);
                  }
                  return (`[hyperplan] ERROR: Unknown round "${round}". ` +
                    `Valid rounds: "analysis" (default), "cross-attack", "defense".`);
                }
                if (args.mode === "synthesize") {
                  if (!args.critiques) {
                    return ("[hyperplan] ERROR: 'critiques' parameter is required for 'synthesize' mode. " +
                      "Provide a JSON array of critique objects from sub-agents.");
                  }
                  let critiques;
                  try {
                    critiques = JSON.parse(args.critiques);
                    if (!Array.isArray(critiques)) {
                      return "[hyperplan] ERROR: 'critiques' must be a JSON array.";
                    }
                  }
                  catch {
                    return "[hyperplan] ERROR: Invalid JSON in 'critiques' parameter.";
                  }
                  // Use enhanced insight bundle synthesis (4-category output)
                  const insightBundle = hyperplan.synthesizeInsightBundle(args.plan, critiques);
                  return (`[hyperplan] INSIGHT BUNDLE SYNTHESIS\n` +
                    `Critiques analyzed: ${critiques.length}\n\n` +
                    insightBundle);
                }
                return (`[hyperplan] ERROR: Unknown mode "${args.mode}". ` +
                  `Use "generate" (for analysis/cross-attack/defense rounds) or "synthesize" ` +
                  `(for insight bundle generation).`);
              },
            }),
      // TRACE EXPORT -- export current session trace to file
      parallax_trace_export: tool({
        description:
          "Export the current session's structured reasoning trace to a JSON file. " +
          "Traces capture protocol phases, writes, verifications, and coherence score. " +
          "Use --pretty for human-readable formatting.",
        args: {
          pretty: tool.schema.boolean().optional().describe(
            "Format output with indentation for human readability",
          ),
        },
        async execute(args: { pretty?: boolean }) {
          const sid = sessionId()
          const pretty = args.pretty === true
          const filePath = exportTrace(sid, pretty)
          const trace = getTrace(sid)

          // Compute and attach score
          const breakdown = computeCoherenceScore(trace)
          trace.coherenceScore = breakdown.total

          return (
            `[parallax] Trace exported: ${filePath}\n` +
            `Session: ${sid}\n` +
            `Phases: ${trace.phases.length}, Writes: ${trace.writes.length}\n` +
            `Coherence Score: ${breakdown.total}/100`
          )
        },
      }),

      // TRACE PR COMMENT -- generates markdown for PR description (Phase 1.1)
      parallax_trace_pr_comment: tool({
        description:
          "Generate a formatted markdown summary of the current session trace " +
          "suitable for pasting into a GitHub PR comment. Shows coherence score, " +
          "protocol phases completed, write verification summary, and friction stats. " +
          "The AI should call this at session end and paste the output into the PR.",
        args: {},
        async execute() {
          const sid = sessionId()
          const trace = getTrace(sid)
          const breakdown = computeCoherenceScore(trace)
          const s = getFriction()

          if (trace.writes.length === 0) {
            return (
              `## Parallax Trace -- Planning Session\n\n` +
              `**Session:** ${sid}\n` +
              `**Protocol Steps:** ${trace.phases.length} phases recorded\n` +
              `**Coherence Score:** ${breakdown.total}/100\n\n` +
              `*No code was written in this session.*`
            )
          }

          const passCount = trace.writes.filter((w) => w.verification === "pass").length
          const failCount = trace.writes.filter((w) => w.verification === "fail").length
          const passRate = trace.writes.length > 0
            ? Math.round((passCount / trace.writes.length) * 100)
            : 0

          const phaseTimeline = trace.phases
            .filter((p) => p.phase !== "execution" && p.phase !== "mode_switch")
            .map((p) => {
              const label = p.phase.replace(/_/g, " ")
              return `- [x] ${label} (${p.timestamp.slice(11, 19)})`
            })
            .join("\n")

          const writeSummary = trace.writes
            .slice(0, 20)
            .map((w) => {
              const icon = w.verification === "pass" ? "[OK]" : w.verification === "fail" ? "[FAIL]" : "[SKIP]"
              const file = w.file.length > 60 ? "..." + w.file.slice(-57) : w.file
              return `- ${icon} \`${file}\``
            })
            .join("\n")

          const more = trace.writes.length > 20
            ? `\n*...and ${trace.writes.length - 20} more writes*\n`
            : ""

          return [
            `## Parallax Trace`,
            ``,
            `| Metric | Value |`,
            `|---|---|`,
            `| **Coherence Score** | **${breakdown.total}/100** |`,
            `| Protocol Coverage | ${breakdown.protocolCoverage}/30 |`,
            `| Verification Integrity | ${breakdown.verificationIntegrity}/35 |`,
            `| Edge Case Coverage | ${breakdown.edgeCaseCoverage}/20 |`,
            `| Timing Discipline | ${breakdown.timingDiscipline}/15 |`,
            ``,
            `**Session:** \`${sid}\``,
            ``,
            `### Protocol Phases`,
            phaseTimeline,
            ``,
            `### Verification Summary`,
            `- ${passCount} passed, ${failCount} failed (${passRate}% pass rate)`,
            `- ${s.trials} trials, ${s.successes} successes`,
            `- Friction retries consumed: ${3 - s.retriesLeft}`,
            ``,
            `### Files Changed`,
            writeSummary,
            more,
            ``,
            `> Full trace: \`.parallax/traces/${sid}.json\``,
          ].join("\n")
        },
      }),

      // TRACE VIEW -- inline trace viewer (Phase 1.2)
      parallax_trace_view: tool({
        description:
          "Show the current session's complete reasoning trace in the chat. " +
          "Displays ambiguity assessment, 4 invariants analysis, verification gate " +
          "results, every write with pass/fail status, commit decision, and summary. " +
          "Use this when the user asks to see the trace.",
        args: {},
        async execute() {
          const sid = sessionId()
          const trace = getTrace(sid)
          const breakdown = computeCoherenceScore(trace)
          const s = getFriction()
          const p = getProtocol()

          const stepStatus = (done: boolean, label: string) =>
            done ? `[DONE] ${label}` : `[PENDING] ${label}`

          const writesList = trace.writes.length === 0
            ? "*No writes recorded yet.*"
            : trace.writes
                .slice(-30)
                .map((w) => {
                  const icon = w.verification === "pass" ? "OK" : w.verification === "fail" ? "FAIL" : "SKIP"
                  const file = w.file.length > 80 ? "..." + w.file.slice(-77) : w.file
                  return `  ${icon} | ${file} | retries left: ${w.frictionRetriesLeft}`
                })
                .join("\n")

          const more = trace.writes.length > 30
            ? `\n  ... and ${trace.writes.length - 30} more writes (see full trace at .parallax/traces/${sid}.json)`
            : ""

          return [
            `## Parallax Session Trace`,
            `**Session:** \`${sid}\``,
            `**Mode:** ${getMode().mode.toUpperCase()}`,
            ``,
            `### Coherence Score: ${breakdown.total}/100`,
            `  Protocol Coverage:     ${breakdown.protocolCoverage}/30`,
            `  Verification Integrity: ${breakdown.verificationIntegrity}/35`,
            `  Edge Case Coverage:    ${breakdown.edgeCaseCoverage}/20`,
            `  Timing Discipline:     ${breakdown.timingDiscipline}/15`,
            ``,
            `### Protocol Progress`,
            `  ${stepStatus(p.ambiguityDone, "1. Ambiguity Check")}`,
            `  ${stepStatus(p.invariantsDone, "2. 4 Invariants")}`,
            `  ${stepStatus(p.gateDone, "3. Verification Gate")}`,
            `  ${stepStatus(p.designDone, "4. Design Doc (optional)")}`,
            `  ${stepStatus(p.commitDone, "5. Commit Decision")}`,
            `  ${stepStatus(p.summaryDone, "6. Summary")}`,
            ``,
            `### Friction`,
            `  Successes: ${s.successes} / Trials: ${s.trials}`,
            `  Retries remaining: ${s.retriesLeft}`,
            s.lastObservation ? `  Last error: ${s.lastObservation.slice(0, 200)}` : "",
            ``,
            `### Writes (last 30)`,
            writesList,
            more,
            ``,
            `> Full trace JSON: \`.parallax/traces/${sid}.json\``,
          ].filter(Boolean).join("\n")
        },
      }),

      // HEALTH -- diagnostic state inspection
      parallax_health: tool({
        description:
          "Diagnostic tool that dumps the current state from all stores " +
          "(in-memory + disk) and reports discrepancies. Use this to debug " +
          "state issues, verify cross-context synchronization, or inspect " +
          "the plugin's internal health.",
        args: {},
        async execute() {
          const sid = sessionId()

          // Read from in-memory stores
          const memProtocol = getProtocol()
          const memMode = getMode()
          const memFriction = getFriction()

          // Read from disk
          const diskState = (() => {
            try {
              if (existsSync(STATE_FILE)) {
                return JSON.parse(readFileSync(STATE_FILE, "utf8"))
              }
            } catch {}
            return null
          })()

          const diskProtocol = diskState?.protocol || null
          const diskMode = diskState?.mode || null
          const diskFriction = diskState?.friction || null

          // Compare function
          const cmp = (a: unknown, b: unknown) => {
            if (a === undefined && b === undefined) return "OK"
            if (a === null && b === null) return "OK"
            if (JSON.stringify(a) === JSON.stringify(b)) return "OK"
            return "MISMATCH"
          }

          const protocolStatus = cmp(memProtocol, diskProtocol)
          const modeStatus = cmp(memMode?.mode, diskMode)
          const frictionStatus = cmp(
            { successes: memFriction.successes, trials: memFriction.trials, retriesLeft: memFriction.retriesLeft },
            diskFriction ? { successes: diskFriction.successes, trials: diskFriction.trials, retriesLeft: diskFriction.retriesLeft } : null
          )

          const allOk = protocolStatus === "OK" && modeStatus === "OK" && frictionStatus === "OK"
          const verdict = allOk ? "HEALTHY" : "DESYNC DETECTED"

          const lines = [
            `## Parallax Health Check`,
            ``,
            `**Session ID:** \`${sid}\``,
            `**Agent:** ${currentAgentName || "(none)"}`,
            `**Mode (memory):** ${memMode.mode}`,
            `**Mode (disk):** ${diskMode || "(no file)"}`,
            `**State file:** ${STATE_FILE}`,
            `**State exists:** ${diskState ? "yes" : "no"}`,
            ``,
            `### Cross-Context Synchronization`,
            `  Protocol: ${protocolStatus === "OK" ? "OK" : "DESYNC -- memory != disk"}`,
            `  Mode:     ${modeStatus === "OK" ? "OK" : "DESYNC -- memory != disk"}`,
            `  Friction: ${frictionStatus === "OK" ? "OK" : "DESYNC -- memory != disk"}`,
            ``,
            `### In-Memory State`,
            `  Protocol:`,
            `    ambiguityDone:   ${memProtocol.ambiguityDone}`,
            `    invariantsDone:  ${memProtocol.invariantsDone}`,
            `    gateDone:        ${memProtocol.gateDone}`,
            `    designDone:      ${memProtocol.designDone}`,
            `    commitDone:      ${memProtocol.commitDone}`,
            `    summaryDone:     ${memProtocol.summaryDone}`,
            `    writesBeforeGate: ${memProtocol.writesBeforeGate}`,
            `  Mode: ${memMode.mode}`,
            `  Friction: ${memFriction.successes} ok / ${memFriction.trials} trials / ${memFriction.retriesLeft} retries`,
            ``,
            `### Disk State`,
            diskProtocol ? [
              `  Protocol:`,
              `    ambiguityDone:   ${diskProtocol.ambiguityDone}`,
              `    invariantsDone:  ${diskProtocol.invariantsDone}`,
              `    gateDone:        ${diskProtocol.gateDone}`,
              `    designDone:      ${diskProtocol.designDone}`,
              `    commitDone:      ${diskProtocol.commitDone}`,
              `    summaryDone:     ${diskProtocol.summaryDone}`,
              `    writesBeforeGate: ${diskProtocol.writesBeforeGate}`,
              `  Mode: ${diskMode}`,
              `  Friction: ${diskFriction?.successes ?? "?"} ok / ${diskFriction?.trials ?? "?"} trials / ${diskFriction?.retriesLeft ?? "?"} retries`,
            ].join("\n") : "  (no state file found)",
            ``,
            `**Verdict:** ${verdict}`,
          ]

          return lines.join("\n")
        },
      }),
    },

    // -----------------------------------------------------------------------
    // Pre-write enforcement: protocol ordering + friction block
    // -----------------------------------------------------------------------

    "tool.execute.before": async (input: { tool: string; args?: Record<string, unknown> }) => {
      if (!["write", "edit", "apply_patch"].includes(input.tool)) return

      // HORIZON ORCHESTRATION EXEMPTION:
      // If the active agent is "horizon" and writing to the Horizon persistence
      // directory (~/.parallax/horizon/...), allow the write without protocol
      // enforcement. Horizon's orchestration writes (plan.json, state.json,
      // research files, skills, decisions) are autonomous operations that
      // should not require Parallax protocol steps.
      const horizonDir = join(".parallax", "horizon")
      const filePath = input.args?.filePath as string | undefined
      if (
        isAgent("horizon") &&
        filePath &&
        // Normalize path separators for cross-platform comparison
        filePath.replace(/\\/g, "/").includes(horizonDir.replace(/\\/g, "/"))
      ) {
        return
      }

      // Read from disk: OpenCode loads plugin in separate execution contexts
      // for tools vs hooks. In-memory Maps are NOT shared across contexts.
      // syncStateFromDisk() reads state.json and updates ALL in-memory stores
      // so that subsequent getProtocol() calls return the persisted values, and
      // modifications (like writesBeforeGate++) are captured in-memory for
      // writeState() to persist.
      syncStateFromDisk()
      const p = getProtocol()
      const cfg = loadConfig()

      // Enforce ambiguity check before any write
      if (!p.ambiguityDone) {
        throw new Error(
          `[parallax] PROTOCOL VIOLATION: Ambiguity Check (Step 1) not completed.\n` +
          `You MUST state HIGH/MEDIUM/LOW and ask clarifying questions ` +
          `before writing code.\n` +
          `Use parallax_checkin({ step: "ambiguity" }) after completing it.`,
        )
      }

      // Phase 3.2: Design doc enforcement (opt-in)
      if (cfg.designDocRequired && !p.designDone && p.invariantsDone && !process.env.PARALLAX_FORCE) {
        throw new Error(
          `[parallax] PROTOCOL VIOLATION: Design Doc (Step 4) required by project config.\n` +
          `Complete a design document before writing code for non-trivial changes.\n` +
          `Use parallax_checkin({ step: "design" }) after completing it.\n` +
          `Override: set PARALLAX_FORCE=1 to bypass.`,
        )
      }

      // Warn after 3 writes without invariants checkin
      if (!p.invariantsDone) {
        p.writesBeforeGate++
        writeState()
        if (p.writesBeforeGate > 3) {
          throw new Error(
            `[parallax] PROTOCOL VIOLATION: 4 Invariants (Step 2) not completed ` +
            `after ${p.writesBeforeGate} writes.\n` +
            `State: state ownership, feedback location, deletion blast radius, ` +
            `timing concerns.\n` +
            `Use parallax_checkin({ step: "invariants" }) after completing it.`,
          )
        }
      }

      // Friction block
      const s = getFriction()
      if (s.retriesLeft === 0 && s.lastObservation) {
        throw new Error(
          `[parallax] Friction blocked: fix the outstanding issue first.\n` +
          `${s.lastObservation}`,
        )
      }
    },

    // -----------------------------------------------------------------------
    // Post-write debounced auto-verify (friction loop)
    // -----------------------------------------------------------------------

    "tool.execute.after": async (input: {
      tool: string
      args?: Record<string, unknown>
    }) => {
      if (!["write", "edit", "apply_patch"].includes(input.tool)) return

      // SYNC FROM DISK: Ensure friction state reflects any updates from other
      // execution contexts (tools vs hooks run in separate contexts).
      syncStateFromDisk()
      const s = getFriction()
      if (s.retriesLeft === 0) return

      const sid = sessionId()

      // Record the file being written for trace
      const fileName =
        input.args && typeof input.args.filePath === "string"
          ? input.args.filePath
          : input.args && typeof input.args.path === "string"
            ? input.args.path
            : `(${input.tool})`

      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const result = runVerify()
        if (!result) {
          addWrite(sid, fileName, "skipped", s.retriesLeft)
          return
        }
        s.trials++
        if (result.exitCode === 0) {
          s.successes++
          s.retriesLeft = MAX_FRICTION_RETRIES
          s.lastObservation = null
          addWrite(sid, fileName, "pass", s.retriesLeft)
          writeState()
          client.app
            .log({
              body: {
                service: "parallax",
                level: "info",
                message: `[parallax] Check passed (${s.successes} ok / ${s.trials} trials)`,
              },
            })
            .catch(() => {})
        } else {
          s.retriesLeft--
          s.lastObservation = truncate(result.combined, 2000)
          addWrite(sid, fileName, "fail", s.retriesLeft)
          writeState()
          const lvl = s.retriesLeft === 0 ? "error" : "warn"
          client.app
            .log({
              body: {
                service: "parallax",
                level: lvl,
                message: `[parallax] Check FAILED. ${s.retriesLeft} retries left.`,
                extra: { output: s.lastObservation },
              },
            })
            .catch(() => {})
        }
      }, CHECK_DEBOUNCE_MS)
    },

    // -----------------------------------------------------------------------
    // Event hook: track session ID
    // -----------------------------------------------------------------------

    event: async (input: {
      event: { type: string; properties?: Record<string, unknown> }
    }) => {
      if (input.event.type === "session.created") {
        const props = input.event.properties || {}
        const info = (props.info || {}) as Record<string, unknown>
        // Child sessions have a parentID. Only track the root session
        // for trace recording. Protocol state uses a fixed key and is unaffected.
        if (info.parentID) return

        currentSessionId =
          (info.id as string) ||
          (props.sessionID as string) ||
          (info.sessionID as string) ||
          null

        // Agent name lives in Session.agent (v2 SDK types.gen.d.ts:590)
        // Normalize to lowercase for case-insensitive matching via isAgent()
        currentAgentName = normalizeAgentName(
          (info.agent as string) || (props.agent as string)
        )

        // Initialize trace with session info
        if (currentSessionId) {
          initTrace(currentSessionId, process.cwd(), detectProject())

        // Carry over protocol state from default if checkins happened before
        // the session.created event fired (common race on session start).
        if (protocolStore.has("default")) {
          protocolStore.set(currentSessionId!, protocolStore.get("default")!)
          protocolStore.delete("default")
        }
        if (frictionStore.has("default")) {
          frictionStore.set(currentSessionId!, frictionStore.get("default")!)
          frictionStore.delete("default")
        }
        if (modeStore.has("default")) {
          modeStore.set(currentSessionId!, modeStore.get("default")!)
          modeStore.delete("default")
        }

          writeState()
        }
      }

      // Track agent switches (TAB to change agent in OpenCode TUI)
      if (input.event.type === "session.next.agent.switched") {
        const props = input.event.properties as Record<string, unknown> | undefined
        currentAgentName = normalizeAgentName(props?.agent as string)
      }

    },

    // -----------------------------------------------------------------------
    // Shell environment injection (Phase 2.6)
    // -----------------------------------------------------------------------

    "shell.env": async (input: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }) => {
      syncStateFromDisk()
      const m = getMode()
      const s = getFriction()
      output.env.PARALLAX_MODE = m.mode
      output.env.PARALLAX_SESSION_ID = currentSessionId || ""
      output.env.PARALLAX_FRICTION_RETRIES = String(s.retriesLeft)
    },

    // -----------------------------------------------------------------------
    // System prompt transformation: inject protocol status + mode skill
    // -----------------------------------------------------------------------

    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system?: string[] },
    ) => {
      // SYNC FROM DISK: This hook runs in a separate execution context from
      // tools. In-memory Maps are always fresh/empty here. We must read the
      // persisted state from disk so the system prompt shows the ACTUAL
      // protocol status (which steps are DONE vs PENDING). Without this,
      // the agent sees all steps as PENDING even after checkins.
      syncStateFromDisk()
      const m = getMode()
      const s = getFriction()
      const p = getProtocol()

      // Phase 2.5: Multi-agent protocol sharing -- carry state to new agent
      if (currentAgentName) {
        const sys = output.system || (output.system = [])
        sys.push(
          `\n## PARALLAX AGENT CONTEXT\n` +
          `You are now operating as agent "${currentAgentName}". ` +
          `Parallax protocol state carries over:\n` +
          `- Mode: ${m.mode.toUpperCase()}\n` +
          `- Ambiguity: ${p.ambiguityDone ? "DONE" : "PENDING"}\n` +
          `- Invariants: ${p.invariantsDone ? "DONE" : "PENDING"}\n` +
          `- Gate: ${p.gateDone ? "DONE" : "PENDING"}\n` +
          `- Friction: ${s.retriesLeft} retries remaining`,
        )
      }

      // Build protocol status block
      const statusLines: string[] = []
      const steps: ProtocolStep[] = [
        "ambiguity",
        "invariants",
        "gate",
        "design",
        "commit",
        "summary",
      ]
      let currentStep: string | null = null
      for (const step of steps) {
        const done = p[`${step}Done`]
        const label = STEP_LABELS[step]
        statusLines.push(`  ${done ? "[DONE]" : "[PENDING]"} Step: ${label}`)
        if (!done && !currentStep) currentStep = label
      }
      const activeStep = currentStep || "Complete"

      const sys = output.system || (output.system = [])
      sys.push(
        `\n## PARALLAX PROTOCOL STATUS\n\n` +
          `Active Step: ${activeStep}\n${statusLines.join("\n")}`,
      )

      // Inject mode skill
      if (m.mode !== "free") {
        const meta = MODE_META[m.mode]
        if (meta && meta.label) sys.push(`\n=== ${meta.label} ===`)
        if (meta && meta.skill) {
          const content = loadSkill(meta.skill)
          if (content) sys.push(content)
        }
        if (m.mode === "build") {
          sys.push(
            "\nExecute the plan. Write clean code. Verify with parallax_verify " +
              "after writes. Flag deferred items.",
          )
        }
        if (m.mode === "horizon") {
          sys.push(
            "\n[CORE BEHAVIOR]\n" +
            "- You plan, research, execute, self-test, and self-iterate until done\n" +
            "- You NEVER ask the user mid-execution questions. You research and decide.\n" +
            "- You document all auto-decisions in decisions.jsonl\n" +
            "- You dispatch sub-agents for implementation work\n" +
            "- You self-evaluate every sub-agent output across 6 dimensions\n" +
            "- You run automated tests after every sub-agent\n" +
            "- You re-plan and retry when verification fails (max 3 cycles)\n" +
            "- You report progress through client.app.log()\n\n" +
            "[AUTONOMY RULES -- NON-NEGOTIABLE]\n" +
            "These are hard rules, not suggestions:\n" +
            "1. NEVER ask 'should I continue?' -- If the plan has 5 features and you finished feature 1, you IMMEDIATELY start feature 2. No pause. No confirmation. No 'would you like me to proceed?'. Just do it.\n" +
            "2. NEVER ask 'should I do X?' -- If the plan says do X, you do X. You don't ask permission. You don't suggest. You execute.\n" +
            "3. NEVER stop mid-plan -- You execute the ENTIRE plan from start to finish. If you complete task A and task B is next, you start task B immediately. The only time you stop is when ALL features in ALL milestones are complete or failed after 3 retry cycles.\n" +
            "4. NEVER ask for testing approval -- After completing a feature, you run the test suite YOURSELF. You don't ask the user to test it. You test it, evaluate it, fix it if needed, and move on.\n" +
            "5. Self-iterate without prompting -- If tests fail, you create a corrective sub-plan and dispatch a fix agent. You don't ask the user what went wrong. You figure it out and fix it.\n" +
            "6. Document, don't ask -- When you make a decision, you LOG it in decisions.jsonl and proceed. You don't ask the user which approach they prefer.\n" +
            "The ONLY acceptable reasons to pause are: all features complete, a feature failed all 3 retry cycles, or a blocker that literally cannot be resolved without user input (e.g., missing API credentials).\n\n" +
            "[WORKFLOW]\n" +
            "1. RESEARCH -- use all MCP tools + codebase analysis before any editing\n" +
            "2. PLAN -- decompose into milestones + features in plan.json\n" +
            "3. EXECUTE -- dispatch sub-agents, test, evaluate, iterate. DO NOT STOP UNTIL ALL FEATURES ARE DONE.\n" +
            "4. AUDIT -- final parallax_debug pass on all work\n\n" +
            "[SHELL COMMAND TIMEOUTS]\n" +
            "Some shell commands can hang indefinitely. ALWAYS set a timeout:\n" +
            "- Quick commands (ls, cat, grep, git status): 30 seconds\n" +
            "- Build commands (npm run build, cargo build, make): 300 seconds\n" +
            "- Test commands (npm test, pytest, cargo test): 600 seconds\n" +
            "- Network commands (npm install, pip install, git clone): 120 seconds\n" +
            "- Unknown commands: Start with 60 seconds, increase if needed\n" +
            "If a command times out, log it as a decision, retry once with a longer timeout. If it times out again, flag the issue and move to the next feature. NEVER let a command run forever.\n\n" +
            "[RESEARCH TOOL DISCOVERY]\n" +
            "You do not know which MCPs are installed -- they vary per setup. Scan your available tool list and categorize:\n" +
            "- Documentation tools (names/descriptions mentioning 'docs', 'query', 'resolve library', 'API reference') -- use for library/framework questions\n" +
            "- Code search tools (mentioning 'grep', 'search', 'code', 'GitHub') -- use for real-world patterns\n" +
            "- Web fetch tools (mentioning 'fetch', 'URL', 'web', 'markdown') -- use for articles, docs\n" +
            "- Browser tools -- use for complex interactive pages\n" +
            "- Codebase tools (read/grep/glob) -- use for project files\n" +
            "Use the most targeted tool. Never assume any specific MCP is present.\n\n" +
            "[SUB-AGENT DISPATCH GUIDE]\n" +
            "When dispatching a sub-agent via task(), you MUST:\n" +
            "1. Read the plan to get skills.sessionScoped list\n" +
            "2. Read each skill from ~/.parallax/horizon/sessions/<sessionId>/skills/<name>/SKILL.md\n" +
            "3. Include the skill content in the task prompt under a '## SESSION-SCOPED SKILLS' section\n" +
            "4. Tell the sub-agent: 'Follow the patterns and conventions in the attached session-scoped skills. These are project-specific and override general defaults.'\n" +
            "5. Also include: 'Scan your available tools for research MCPs (documentation queries, code search, web fetching) and use the most appropriate one for each question. Do not assume any specific MCP is present.'\n\n" +
            "[HORIZON TOOLS]\n" +
            "- horizon_init_session -- Initialize a new session\n" +
            "- horizon_write_plan -- Write/update plan.json\n" +
            "- horizon_read_plan -- Read current plan\n" +
            "- horizon_update_feature -- Update a feature's status\n" +
            "- horizon_update_milestone -- Update a milestone's status\n" +
            "- horizon_write_state -- Write orchestration state\n" +
            "- horizon_read_state -- Read orchestration state\n" +
            "- horizon_append_decision -- Log an autonomous decision\n" +
            "- horizon_read_decisions -- Read decision log\n" +
            "- horizon_write_research -- Write research findings\n" +
            "- horizon_read_research -- Read research findings\n" +
            "- horizon_create_skill -- Create session-scoped skill\n" +
            "- horizon_list_skills -- List session-scoped skills\n" +
            "- horizon_save_trace -- Archive sub-agent trace\n" +
            "- horizon_list_sessions -- List all Horizon sessions\n" +
            "- horizon_evaluate_subagent -- 6-dimension weighted self-check (pass >= 75%)\n" +
            "- horizon_session_status -- Comprehensive session status\n" +
            "- horizon_config -- Read/write Horizon config\n\n" +
            "[OTHER TOOLS]\n" +
            "- task() to dispatch sub-agents (include MCP tool reference in prompt)\n" +
            "- parallax_plan/build/debug for complex sub-agent configuration\n" +
            "- parallax_verify for automated verification\n" +
            "- todowrite for plan tracking\n\n" +
            "[PERSISTENCE]\n" +
            "All state at ~/.parallax/horizon/sessions/<id>/",
          )

          // SESSION RESTART RECOVERY: detect existing sessions for resume
          const hSessions = getCachedHorizonSessions()
          const activeSessions = hSessions.filter(
            (s) => s.meta.status === "executing" || s.meta.status === "planning",
          )
          if (activeSessions.length > 0) {
            const latest = activeSessions[activeSessions.length - 1]
            const hPlan = horizon.readHorizonPlan(latest.id)
            const hState = horizon.readHorizonState(latest.id)
            if (hPlan && hState) {
              const pct = hPlan.stats.totalFeatures > 0
                ? Math.round((hPlan.stats.completedFeatures / hPlan.stats.totalFeatures) * 100)
                : 0
              sys.push(
                "\n## SESSION RESTART DETECTED\n\n" +
                `An existing session was found. You may resume it:\n\n` +
                `Session: ${latest.id}\n` +
                `Goal: ${hPlan.goal.slice(0, 120)}\n` +
                `Status: ${hPlan.status}\n` +
                `Phase: ${hState.currentPhase}\n` +
                `Progress: ${hPlan.stats.completedFeatures}/${hPlan.stats.totalFeatures} (${pct}%)\n` +
                `Milestones: ${hPlan.milestones.length}\n` +
                `Autonomy: ${hPlan.autonomyLevel}\n\n` +
                `Use horizon_read_plan and horizon_read_state to inspect, ` +
                `then horizon_write_state to set the active phase and continue.`,
              )
            }
          }
        }
      }

      // Inject friction state
      if (s.lastObservation) {
        sys.push(
          `\n## PARALLAX FRICTION STATE\n\n` +
            `A previous check failed. Fix this before writing more code:\n\n` +
            `${s.lastObservation}\n\nRetries remaining: ${s.retriesLeft}`,
        )
      }
    },

    // -----------------------------------------------------------------------
    // Session compaction: preserve state across context window resets
    // -----------------------------------------------------------------------

    "experimental.session.compacting": async (
      _input: unknown,
      output: { context?: string[] },
    ) => {
      // SYNC FROM DISK: Same context isolation issue as system.transform.
      syncStateFromDisk()
      const s = getFriction()
      const m = getMode()
      const p = getProtocol()
      const sid = sessionId()

      // Export trace to disk on compaction
      try {
        exportTrace(sid)
      } catch {
        // Non-fatal: trace export is best-effort
      }

      const ctx = output.context || (output.context = [])
      const lines = [
        `## PARALLAX SESSION STATE`,
        `- Mode: ${m.mode}`,
        `- Ambiguity: ${p.ambiguityDone}, Invariants: ${p.invariantsDone}, ` +
          `Gate: ${p.gateDone}`,
        `- Friction: ${s.successes} ok / ${s.trials} trials, ` +
          `Retries: ${s.retriesLeft}`,
      ]

      // Include Horizon session context when in horizon mode
      if (m.mode === "horizon") {
        const hPlan = horizon.readHorizonPlan(sid)
        const hState = horizon.readHorizonState(sid)
        if (hPlan) {
          lines.push(
            `- Horizon goal: ${hPlan.goal.slice(0, 120)}`,
            `- Horizon progress: ${hPlan.stats.completedFeatures}/${hPlan.stats.totalFeatures}`,
            `- Horizon phase: ${hState ? hState.currentPhase : "unknown"}`,
            `- Horizon autonomy: ${hPlan.autonomyLevel}`,
          )
        }
      }

      ctx.push(lines.join("\n"))
    },
  }
}

export default plugin