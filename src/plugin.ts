/**
 * PARALLAX ENGINE -- Canonical TypeScript Plugin
 *
 * Consolidated source of truth for the Parallax Engine OpenCode plugin.
 * Contains Parallax and Horizon tools, the mode state machine, runtime prompt
 * injection, protocol enforcement, friction-loop verification, skill injection,
 * session state preservation, and trace recording.
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import { type Plugin, tool, type ToolContext } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "os"
import { dirname, join, resolve } from "path"

import type {
  AgentMode,
  ProtocolStep,
  FrictionState,
  ModeState,
  ProtocolState,
  ParallaxConfig,
  HorizonAutonomyLevel,
} from "./types.js"
import { detectProject } from "./detect.js"
import { loadEffectiveParallaxConfig } from "./config.js"
import {
  applyVerificationReceipt,
  claimVerificationChanges,
  completeVerificationClaim,
  queueVerificationChanges,
  readVerificationLedger,
  restoreVerificationClaim,
  syncVerificationLedger,
  verifyAndRecord,
  type VerificationChangeClaim,
} from "./verification.js"
import {
  initTrace,
  addPhase,
  addWrite,
  exportTrace,
  getTrace,
  hydrateTrace,
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
const STATE_SCHEMA_VERSION = 2
const CONFIG_DIR = resolve(process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"))
const LEGACY_STATE_FILE = join(".parallax", "state.json")

// ---------------------------------------------------------------------------
// Module-level stores
// ---------------------------------------------------------------------------

const frictionStore = new Map<string, FrictionState>()
const modeStore = new Map<string, ModeState>()
const protocolStore = new Map<string, ProtocolState>()
let currentSessionId: string | null = null
let currentAgentName: string | null = null
const sessionRootStore = new Map<string, string>()
const sessionAgentStore = new Map<string, string>()

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
function isAgent(agentName: string, sid: string = sessionId()): boolean {
  const active = sessionAgentStore.get(sid) || (sid === "current" ? currentAgentName : null)
  return normalizeAgentName(active) === normalizeAgentName(agentName)
}

function sessionId(explicit?: string | null): string {
  return explicit || currentSessionId || "current"
}

function safeFileId(id: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== "." && id !== "..") {
    return id
  }
  return `session-${createHash("sha256").update(id).digest("hex")}`
}

function stateFile(root: string, sid: string): string {
  if (sid === "current") return legacyStateFile(root)
  return join(resolve(root), ".parallax", "sessions", safeFileId(sid), "state.json")
}

function legacyStateFile(root: string): string {
  return join(resolve(root), LEGACY_STATE_FILE)
}

function rootForSession(sid: string, fallback: string = process.cwd()): string {
  return sessionRootStore.get(sid) || resolve(fallback)
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8")
  renameSync(temporary, path)
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

const configCache = new Map<string, ParallaxConfig>()

function loadConfig(root: string = rootForSession(sessionId())): ParallaxConfig {
  const path = join(resolve(root), ".parallax", "config.json")
  if (configCache.has(path)) return configCache.get(path)!
  // Invalid or malformed settings are explicit failures rather than silently
  // weakening protocol enforcement.
  const config: ParallaxConfig = loadEffectiveParallaxConfig(root)
  configCache.set(path, config)
  return config
}

function strictness(root?: string): NonNullable<ParallaxConfig["strictness"]> {
  return loadConfig(root).strictness || "strict"
}

function isStrictMode(root?: string): boolean {
  return strictness(root) === "strict"
}

function isPathInside(root: string, target: string, targetBase: string = root): boolean {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(targetBase, target)
  return resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + "\\") ||
    resolvedTarget.startsWith(resolvedRoot + "/")
}

// ---------------------------------------------------------------------------
// State persistence (Phase 2.1)
// ---------------------------------------------------------------------------

const stateDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function stateSnapshot(sid: string) {
  const friction = getFriction(sid)
  const protocol = getProtocol(sid)
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessionId: sid,
    sessionStart: getTrace(sid).session.startedAt,
    mode: getMode(sid).mode,
    friction: { ...friction },
    protocol: { ...protocol },
  }
}

function flushState(sid: string = sessionId(), root: string = rootForSession(sid)): void {
  try {
    writeJsonAtomic(stateFile(root, sid), stateSnapshot(sid))
  } catch {
    // Persistence is best-effort; protocol enforcement must not crash on I/O errors.
  }
}

function writeState(
  immediate = false,
  sid: string = sessionId(),
  root: string = rootForSession(sid),
): void {
  const key = `${resolve(root)}\0${sid}`
  const pending = stateDebounceTimers.get(key)
  if (pending) clearTimeout(pending)
  if (immediate) {
    stateDebounceTimers.delete(key)
    flushState(sid, root)
    return
  }
  const timer = setTimeout(() => {
    stateDebounceTimers.delete(key)
    flushState(sid, root)
  }, STATE_DEBOUNCE_MS)
  stateDebounceTimers.set(key, timer)
}

function readPersistedState(sid: string, root: string): any | null {
  const path = stateFile(root, sid)
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"))

    // v1 stored every conversation in .parallax/state.json as session "current".
    // Atomically claim it once so unrelated future sessions cannot inherit stale
    // completed gates. The claimed file remains as a recovery/audit artifact.
    const legacy = legacyStateFile(root)
    if (!existsSync(legacy)) return null
    const claimed = `${legacy}.migrated`
    try {
      renameSync(legacy, claimed)
    } catch {
      return null
    }
    const migrated = JSON.parse(readFileSync(claimed, "utf8"))
    if (!migrated || typeof migrated !== "object") return null
    const versioned = { ...migrated, schemaVersion: STATE_SCHEMA_VERSION, sessionId: sid }
    writeJsonAtomic(path, versioned)
    return versioned
  } catch {
    return null
  }
}

function syncStateFromDisk(
  sid: string = sessionId(),
  root: string = rootForSession(sid),
): void {
  const state = readPersistedState(sid, root)
  if (!state || (state.schemaVersion !== undefined && state.schemaVersion !== STATE_SCHEMA_VERSION)) return

  if (state.protocol) {
    protocolStore.set(sid, {
      ambiguityDone: state.protocol.ambiguityDone === true,
      invariantsDone: state.protocol.invariantsDone === true,
      gateDone: state.protocol.gateDone === true,
      designDone: state.protocol.designDone === true,
      commitDone: state.protocol.commitDone === true,
      summaryDone: state.protocol.summaryDone === true,
      writesBeforeGate: Number.isFinite(state.protocol.writesBeforeGate) ? state.protocol.writesBeforeGate : 0,
      gateBlocked: state.protocol.gateBlocked === true,
    })
  }
  if (["free", "plan", "build", "debug", "horizon"].includes(state.mode)) {
    modeStore.set(sid, { mode: state.mode as AgentMode })
  }
  if (state.friction) {
    frictionStore.set(sid, {
      successes: Number.isFinite(state.friction.successes) ? state.friction.successes : 0,
      trials: Number.isFinite(state.friction.trials) ? state.friction.trials : 0,
      retriesLeft: Number.isFinite(state.friction.retriesLeft) ? state.friction.retriesLeft : MAX_FRICTION_RETRIES,
      lastObservation: typeof state.friction.lastObservation === "string" ? state.friction.lastObservation : null,
    })
  }
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

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingChangedFiles = new Map<string, Set<string>>()

function verificationBatchKey(root: string, sid: string): string {
  return `${resolve(root)}\0${sid}`
}

function changedFilesFromTool(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  const direct = typeof args.filePath === "string"
    ? args.filePath
    : typeof args.path === "string"
      ? args.path
      : null
  if (direct) return [direct]

  // OpenCode apply_patch payloads can touch several files in one tool call.
  const patch = typeof args.patchText === "string"
    ? args.patchText
    : typeof args.patch === "string"
      ? args.patch
      : ""
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)]
    .map((match) => match[1])
    .filter(Boolean)
  return files.length > 0 ? files : [`(${toolName}: path unavailable)`]
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const plugin: Plugin = async ({ client, directory, worktree }) => {
  const pluginRoot = resolve(worktree || directory || process.cwd())

  const activateSession = (requested?: string | null, requestedRoot?: string | null) => {
    const sid = sessionId(requested)
    // Hooks such as tool.execute.before do not carry a directory. Preserve the
    // root learned from that session's ToolContext/event instead of resetting
    // it to the plugin process's original worktree.
    const root = resolve(requestedRoot || sessionRootStore.get(sid) || pluginRoot)
    currentSessionId = sid
    sessionRootStore.set(sid, root)
    hydrateTrace(sid, root)
    return { sid, root }
  }

  const toolRuntime = (context?: ToolContext) => {
    const runtime = activateSession(
      context?.sessionID || "current",
      context?.worktree || context?.directory,
    )
    const agent = normalizeAgentName(context?.agent)
    if (agent) sessionAgentStore.set(runtime.sid, agent)
    return runtime
  }

  const takePendingBatch = (
    sid: string,
    root: string,
    cancelTimer = true,
  ): { changedFiles: string[]; claim: VerificationChangeClaim | null } => {
    const key = verificationBatchKey(root, sid)
    if (cancelTimer) {
      const timer = debounceTimers.get(key)
      if (timer) clearTimeout(timer)
      debounceTimers.delete(key)
    }
    const claim = claimVerificationChanges(root, sid)
    const files = new Set<string>(claim?.changedFiles || [])
    for (const file of pendingChangedFiles.get(key) || []) files.add(file)
    pendingChangedFiles.delete(key)
    return { changedFiles: [...files].sort(), claim }
  }

  const applyReceipt = (sid: string, root: string, receipt: ReturnType<typeof verifyAndRecord>) => {
    const friction = getFriction(sid)
    applyVerificationReceipt(friction, receipt, MAX_FRICTION_RETRIES)
    for (const file of receipt.changedFiles) {
      addWrite(sid, file, receipt.verdict, friction.retriesLeft, receipt.id)
    }
    writeState(true, sid, root)
    return friction
  }

  const verifyBatch = (
    sid: string,
    root: string,
    source: "manual" | "automatic",
    batch: { changedFiles: string[]; claim: VerificationChangeClaim | null },
  ) => {
    let receipt: ReturnType<typeof verifyAndRecord>
    try {
      receipt = verifyAndRecord({
        directory: root,
        sessionId: sid,
        source,
        changedFiles: batch.changedFiles,
      })
      // The durable receipt now owns attribution; only unrecorded claims recover.
      if (batch.claim) completeVerificationClaim(batch.claim)
    } catch (error) {
      if (batch.claim) restoreVerificationClaim(root, sid, batch.claim)
      // Files that only existed in the in-memory fallback are not part of the
      // durable claim. Retain them for the next manual or automatic attempt.
      const claimedFiles = new Set(batch.claim?.changedFiles || [])
      const memoryOnly = batch.changedFiles.filter((file) => !claimedFiles.has(file))
      if (memoryOnly.length > 0) {
        const key = verificationBatchKey(root, sid)
        const retained = pendingChangedFiles.get(key) || new Set<string>()
        for (const file of memoryOnly) retained.add(file)
        pendingChangedFiles.set(key, retained)
      }
      throw error
    }
    return { receipt, friction: applyReceipt(sid, root, receipt) }
  }

  return {
    // -----------------------------------------------------------------------
    // Custom tools
    // -----------------------------------------------------------------------

    tool: {
      // VERIFY
      parallax_verify: tool({
        description:
          "Run the project's deterministic verification script with a timeout and record " +
          "a schema-v2 receipt. Use this instead of running checks manually via bash.",
        args: {},
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          // A manual check claims the same durable batch as auto-check.
          const { receipt } = verifyBatch(sid, root, "manual", takePendingBatch(sid, root))
          const invocation = receipt.command
            ? `${receipt.command} ${receipt.args.join(" ")}`
            : "(no command)"
          const heading = receipt.verdict === "pass"
            ? "VERIFICATION PASSED"
            : receipt.verdict === "fail"
              ? "VERIFICATION FAILED"
              : `VERIFICATION ${receipt.verdict.toUpperCase()}`
          const evidence = receipt.combined || receipt.skipReason || "No output"
          return (
            `[parallax] ${heading} (${receipt.durationMs}ms, exit ${receipt.exitCode ?? "none"})\n` +
            `Command: ${invocation}\nReceipt: ${receipt.id}\n` +
            truncate(evidence, 2000)
          )
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
        async execute(args: { topic: string }, context?: ToolContext) {
          const { sid } = toolRuntime(context)
          addPhase(sid, "mode_switch", { analysisTopic: args.topic })
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
        async execute(args: { step: string }, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          const p = getProtocol(sid)
          const step = args.step as ProtocolStep

          if (!STEP_LABELS[step]) {
            return (
              `[parallax] Unknown step "${step}". ` +
              `Valid: ${Object.keys(STEP_LABELS).join(", ")}`
            )
          }

          const cfg = loadConfig(root)

          // Enforce ordering
          if (step === "ambiguity" && !p.ambiguityDone) {
            p.ambiguityDone = true
            addPhase(sid, "ambiguity_check")
            writeState(true, sid, root)
            return "[parallax] Step 1/6: Ambiguity Check marked complete."
          }
          if (step === "invariants") {
            if (!p.ambiguityDone) {
              return "[parallax] ERROR: Complete Ambiguity Check first (Step 1)."
            }
            p.invariantsDone = true
            addPhase(sid, "four_invariants")
            writeState(true, sid, root)
            return "[parallax] Step 2/6: 4 Invariants marked complete."
          }
          if (step === "gate") {
            if (!p.invariantsDone) {
              return "[parallax] ERROR: Complete 4 Invariants first (Step 2)."
            }
            p.gateDone = true
            addPhase(sid, "verification_gate")
            writeState(true, sid, root)
            return "[parallax] Step 3/6: Verification Gate marked complete."
          }
          if (step === "design") {
            if (!p.gateDone && cfg.designDocRequired) {
              return "[parallax] ERROR: Complete Verification Gate first (Step 3)."
            }
            p.designDone = true
            addPhase(sid, "design_check")
            writeState(true, sid, root)
            return "[parallax] Step 4/6: Design Doc marked complete."
          }
          if (step === "commit") {
            p.commitDone = true
            addPhase(sid, "commit_decision")
            writeState(true, sid, root)
            return "[parallax] Step 5/6: Commit Decision marked complete."
          }
          if (step === "summary") {
            p.summaryDone = true
            addPhase(sid, "summary")
            writeState(true, sid, root)

            // Phase 2.3: Post-session retrospective
            syncVerificationLedger(sid, root)
            const trace = getTrace(sid)
            const breakdown = computeCoherenceScore(trace)
            const s = getFriction(sid)
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
          "Switch to PLAN mode. Injects evidence-led scoping and verification planning. " +
          "Clear requests proceed with documented assumptions; essential unresolved " +
          "user-only decisions are asked once in a bundled question set.",
        args: {},
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          getMode(sid).mode = "plan"
          addPhase(sid, "mode_switch", { mode: "plan" })
          writeState(true, sid, root)
          return (
            "[parallax] PLAN mode activated. Build a scoped plan with acceptance " +
            "criteria, planned checks, and an honest receipt."
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
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          getMode(sid).mode = "build"
          addPhase(sid, "mode_switch", { mode: "build" })
          writeState(true, sid, root)
          return (
            "[parallax] BUILD mode activated. Standard Parallax execution protocol. " +
            "Write clean code, verify with parallax_verify."
          )
        },
      }),

      // MODE: DEBUG
      parallax_debug: tool({
        description:
          "Switch to DEBUG mode for evidence-based investigation, scoped remediation, " +
          "regression verification, and an honest audit receipt.",
        args: {},
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          getMode(sid).mode = "debug"
          addPhase(sid, "mode_switch", { mode: "debug" })
          writeState(true, sid, root)
          return (
            "[parallax] DEBUG mode activated. Investigate evidence, verify scoped " +
            "remediation when requested, and report assurance limits."
          )
        },
      }),

      // MODE: HORIZON
      parallax_horizon: tool({
        description:
          "Switch to HORIZON mode for durable long-running supervision with " +
          "persisted plans, bounded retries, verification receipts, and resumable state. " +
          "Horizon advances while OpenCode is running and permissions are granted; " +
          "it is not a background daemon or a completion guarantee.",
        args: {},
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          getMode(sid).mode = "horizon"
          addPhase(sid, "mode_switch", { mode: "horizon" })
          writeState(true, sid, root)
          return (
            "[parallax] HORIZON mode activated for durable supervision. " +
            "Work will follow PREFLIGHT -> CHANGE -> VERIFY -> RECEIPT with " +
            "bounded retries, persisted state, and OpenCode permissions respected."
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
            if (plan.sessionId !== args.sessionId || !["planning", "executing"].includes(plan.status)) {
              return "[horizon] ERROR: Plan identity/status is invalid for the planning surface."
            }
            const features = plan.milestones.flatMap(
              (milestone: { features?: unknown[] }) => Array.isArray(milestone.features) ? milestone.features : [],
            ) as Array<Record<string, any>>
            const retryCap = horizon.loadHorizonConfig().maxRetryCycles
            const invalidFeature = features.find((feature) =>
              feature.status !== "pending" || feature.attempts !== 0 || feature.subAgentSessionId != null ||
              feature.workerSummary != null || feature.audit != null || feature.verification?.passed !== false ||
              feature.verification?.receiptId != null || feature.verification?.verdict != null ||
              !Number.isInteger(feature.maxAttempts) || feature.maxAttempts < 1 || feature.maxAttempts > retryCap)
            if (invalidFeature) {
              return (
                `[horizon] ERROR: Plan feature '${String(invalidFeature.id || "unknown")}' contains execution/evidence state. ` +
                "Use the feature, receipt, and audit transition tools; planning cannot manufacture readiness."
              )
            }
            if (!plan.stats || plan.stats.completedFeatures !== 0 || plan.stats.failedFeatures !== 0 ||
                plan.stats.totalRetries !== 0 || plan.stats.totalFeatures !== features.length) {
              return "[horizon] ERROR: Initial plan statistics must describe pending features only."
            }
            horizon.writeHorizonPlan(args.sessionId, plan)
            const featureCount = features.length
            return (
              `[horizon] Plan written for session: ${args.sessionId}\n` +
              `Milestones: ${plan.milestones.length}, Features: ${featureCount}`
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
          const currentFeature = horizon.readHorizonPlan(args.sessionId)?.milestones
            .flatMap((milestone) => milestone.features)
            .find((feature) => feature.id === args.featureId)
          if (!currentFeature) {
            return `[horizon] Feature '${args.featureId}' not found in session ${args.sessionId}.`
          }
          if (args.status === "in_progress" && !args.subAgentSessionId?.trim()) {
            return "[horizon] ERROR: Sequential execution requires the active horizon-worker session ID."
          }
          if (args.status !== "in_progress" && args.subAgentSessionId) {
            return "[horizon] ERROR: A child worker session ID is accepted only when starting an in-progress worker stage."
          }
          if (args.status === "completed" && !horizon.horizonFeatureIsReady(currentFeature)) {
            return "[horizon] ERROR: Feature readiness requires an observed pass receipt and an independent horizon-auditor accept verdict."
          }
          const updates: Record<string, unknown> = { status: args.status }
          if (args.status === "in_progress") updates.subAgentSessionId = args.subAgentSessionId
          let result
          try {
            result = horizon.updateHorizonFeature(
              args.sessionId,
              args.featureId,
              updates as any,
            )
          } catch (error) {
            return `[horizon] ERROR: ${error instanceof Error ? error.message : String(error)}`
          }
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

      // HORIZON RECORD OBSERVED VERIFICATION
      horizon_record_verification: tool({
        description:
          "Persist a feature's observed schema-v2 receipt evidence from the workspace ledger. " +
          "The verdict is looked up by receipt ID and cannot be supplied or replaced by a score.",
        args: {
          sessionId: tool.schema.string().describe("Horizon session ID"),
          featureId: tool.schema.string().describe("Feature ID"),
          receiptId: tool.schema.string().describe("Observed schema-v2 receipt ID"),
          workerSummary: tool.schema.string().optional().describe(
            "Bounded worker summary (maximum 2000 characters; details remain in the child trace)",
          ),
        },
        async execute(args: {
          sessionId: string
          featureId: string
          receiptId: string
          workerSummary?: string
        }, context?: ToolContext) {
          const { root } = toolRuntime(context)
          const receipt = readVerificationLedger(root).receipts.find((candidate) => candidate.id === args.receiptId)
          if (!receipt) return `[horizon] ERROR: Receipt '${args.receiptId}' was not observed in the workspace schema-v2 ledger.`
          try {
            const result = horizon.recordHorizonVerificationReceipt(
              args.sessionId,
              args.featureId,
              receipt,
              args.workerSummary || "",
            )
            if (!result) return `[horizon] Feature '${args.featureId}' not found.`
            return `[horizon] Observed receipt persisted: ${receipt.id}\nVerdict: ${receipt.verdict}\nPassing evidence: ${receipt.verdict === "pass" ? "yes" : "no"}`
          } catch (error) {
            return `[horizon] ERROR: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      }),

      // HORIZON RECORD INDEPENDENT AUDIT
      horizon_record_audit: tool({
        description:
          "Persist one bounded independent horizon-auditor result after observed receipt evidence. " +
          "This records review evidence but cannot convert a non-pass receipt into readiness.",
        args: {
          sessionId: tool.schema.string().describe("Horizon session ID"),
          featureId: tool.schema.string().describe("Feature ID"),
          auditorSessionId: tool.schema.string().describe("Independent horizon-auditor child session ID"),
          verdict: tool.schema.string().describe("accept or corrective-worker"),
          summary: tool.schema.string().describe("Bounded audit summary, maximum 2000 characters"),
          traceId: tool.schema.string().optional().describe("Archived child trace ID"),
        },
        async execute(args: {
          sessionId: string
          featureId: string
          auditorSessionId: string
          verdict: string
          summary: string
          traceId?: string
        }) {
          if (args.verdict !== "accept" && args.verdict !== "corrective-worker") {
            return "[horizon] ERROR: Audit verdict must be 'accept' or 'corrective-worker'."
          }
          try {
            const result = horizon.recordHorizonAudit(
              args.sessionId,
              args.featureId,
              args.verdict,
              args.auditorSessionId,
              args.summary,
              args.traceId || null,
            )
            if (!result) return `[horizon] Feature '${args.featureId}' not found.`
            const feature = result.milestones.flatMap((milestone) => milestone.features)
              .find((candidate) => candidate.id === args.featureId)!
            return `[horizon] Independent audit persisted: ${args.verdict}\nReady: ${horizon.horizonFeatureIsReady(feature) ? "yes" : "no"}`
          } catch (error) {
            return `[horizon] ERROR: ${error instanceof Error ? error.message : String(error)}`
          }
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

      // HORIZON EVALUATE SUB-AGENT -- advisory score only
      horizon_evaluate_subagent: tool({
        description:
          "Evaluate supplied sub-agent output across 6 dimensions with advisory weighted scoring. " +
          "Records the score but cannot set verification passed or readiness; only observed " +
          "schema-v2 receipt evidence can do that.",
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
          const thresholdMet = weightedScore >= 75

          // Build breakdown table
          const breakdown = dims.map(
            (d) => `  ${d.label.padEnd(22)} ${String(d.score).padStart(3)}/100 x ${(d.weight * 100)}% = ${Math.round(d.score * d.weight)}`,
          ).join("\n")

          // Log an advisory evaluation. It cannot manufacture verification evidence.
          const rating = thresholdMet ? "THRESHOLD MET" : "BELOW THRESHOLD"
          horizon.appendHorizonDecision(args.sessionId, {
            timestamp: new Date().toISOString(),
            feature: args.featureId,
            ambiguity: `Advisory self-check for feature ${args.featureId}`,
            researchResult: `6-dimension weighted scoring: ${weightedScore}/100`,
            decision: `${rating} (advisory threshold: 75%)`,
            rationale: breakdown.replace(/\n/g, "; "),
            confidence: thresholdMet ? "high" : "medium",
          })

          // Preserve the observed receipt ID, verdict, and passed state.
          horizon.recordHorizonEvaluationScore(args.sessionId, args.featureId, weightedScore)

          // Progress reporting
          client.app.log({
            body: {
              service: "horizon",
              level: thresholdMet ? "info" : "warn",
              message:
                `[horizon] Advisory self-check for '${args.featureId}': ${rating} ` +
                `(${weightedScore}/100, advisory threshold: 75)`,
            },
          }).catch(() => {})

          return (
            `[horizon] Advisory self-check for '${args.featureId}': ${rating}\n` +
            `Weighted score: ${weightedScore}/100 (advisory threshold: 75)\n\n` +
            `Breakdown:\n${breakdown}\n\n` +
            "This score did not change verification passed/readiness; persist an observed schema-v2 receipt."
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
              const updates: unknown = JSON.parse(args.configJson)
              if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
                throw new Error("configJson must contain a JSON object")
              }
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
                      `Dispatch ${result.angles.length} sub-agents in parallel through the available task tool -- one per prompt below.\n` +
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
                      `Dispatch ${angles.length} sub-agents in parallel through the available task tool -- one per prompt below.\n` +
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
                      `Dispatch ${defensePrompts.length} sub-agents in parallel through the available task tool.\n` +
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
          "Export the current session's structured protocol and verification trace to a JSON file. " +
          "Traces capture protocol phases, writes, receipt-linked verdicts, and coherence score. " +
          "Use --pretty for human-readable formatting.",
        args: {
          pretty: tool.schema.boolean().optional().describe(
            "Format output with indentation for human readability",
          ),
        },
        async execute(args: { pretty?: boolean }, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          const pretty = args.pretty === true
          syncVerificationLedger(sid, root)
          const trace = getTrace(sid)
          const breakdown = computeCoherenceScore(trace)
          trace.coherenceScore = breakdown.total
          const filePath = exportTrace(sid, pretty, root)

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
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          syncVerificationLedger(sid, root)
          const trace = getTrace(sid)
          const breakdown = computeCoherenceScore(trace)
          const s = getFriction(sid)

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
          "Show the current session's recorded protocol and verification trace in the chat. " +
          "Displays check-in status, coherence scoring, recorded writes and receipt-linked " +
          "verdicts, and current friction state. " +
          "Use this when the user asks to see the trace.",
        args: {},
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)
          syncVerificationLedger(sid, root)
          const trace = getTrace(sid)
          const breakdown = computeCoherenceScore(trace)
          const s = getFriction(sid)
          const p = getProtocol(sid)

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
            `**Mode:** ${getMode(sid).mode.toUpperCase()}`,
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
        async execute(_args, context?: ToolContext) {
          const { sid, root } = toolRuntime(context)
          syncStateFromDisk(sid, root)

          // Read from in-memory stores
          const memProtocol = getProtocol(sid)
          const memMode = getMode(sid)
          const memFriction = getFriction(sid)

          // Read from disk
          const diskState = (() => {
            try {
              const path = stateFile(root, sid)
              if (existsSync(path)) {
                return JSON.parse(readFileSync(path, "utf8"))
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
            `**State file:** ${stateFile(root, sid)}`,
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

    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> },
    ) => {
      if (!["write", "edit", "apply_patch"].includes(input.tool)) return
      const { sid, root } = activateSession(input.sessionID || "current")
      // OpenCode exposes mutable tool arguments exclusively on output.args.
      // Reading input.args here would bypass mutations made by earlier hooks.
      const args = output.args

      // HORIZON ORCHESTRATION EXEMPTION:
      // If the active agent is "horizon" and writing to the Horizon persistence
      // directory (~/.parallax/horizon/...), allow the write without protocol
      // enforcement. Horizon's orchestration writes (plan.json, state.json,
      // research files, skills, decisions) are autonomous operations that
      // should not require Parallax protocol steps.
      const horizonDir = horizon.getHorizonDir()
      const filePath = (args.filePath || args.path) as string | undefined
      if (
        isAgent("horizon", sid) &&
        filePath &&
        isPathInside(horizonDir, filePath, root)
      ) {
        return
      }

      // Read from disk: OpenCode loads plugin in separate execution contexts
      // for tools vs hooks. In-memory Maps are NOT shared across contexts.
      // syncStateFromDisk() reads state.json and updates ALL in-memory stores
      // so that subsequent getProtocol() calls return the persisted values, and
      // modifications (like writesBeforeGate++) are captured in-memory for
      // writeState() to persist.
      syncStateFromDisk(sid, root)
      const p = getProtocol(sid)
      const cfg = loadConfig(root)

      if (isStrictMode(root) && (!p.ambiguityDone || !p.invariantsDone || !p.gateDone)) {
        const missing = [
          !p.ambiguityDone ? "Ambiguity Check (Step 1)" : null,
          !p.invariantsDone ? "4 Invariants (Step 2)" : null,
          !p.gateDone ? "Verification Gate (Step 3)" : null,
        ].filter(Boolean).join(", ")
        throw new Error(
          `[parallax] PROTOCOL VIOLATION: strict mode blocks writes until required gates are complete.\n` +
          `Missing: ${missing}.\n` +
          `Use parallax_checkin for ambiguity, invariants, and gate after completing each step.`,
        )
      }

      // Enforce ambiguity check before any write in non-strict modes too.
      if (!p.ambiguityDone) {
        throw new Error(
          `[parallax] PROTOCOL VIOLATION: Ambiguity Check (Step 1) not completed.\n` +
          `You MUST state HIGH/MEDIUM/LOW before writing code. Ask only when an ` +
          `essential decision cannot be derived safely; otherwise document assumptions and proceed.\n` +
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

      // Standard/relaxed mode keeps the historical soft invariant behavior.
      if (!p.invariantsDone) {
        p.writesBeforeGate++
        writeState(true, sid, root)
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

      // Verification failures never block the repair write. Every subsequent
      // write re-enters the same bounded verifier; a pass restores health.
    },

    // -----------------------------------------------------------------------
    // Post-write debounced auto-verify (friction loop)
    // -----------------------------------------------------------------------

    "tool.execute.after": async (input: {
      tool: string
      sessionID: string
      callID: string
      args: Record<string, unknown>
    }) => {
      if (!["write", "edit", "apply_patch"].includes(input.tool)) return
      const { sid, root } = activateSession(input.sessionID)

      // SYNC FROM DISK: Ensure friction state reflects any updates from other
      // execution contexts (tools vs hooks run in separate contexts).
      syncStateFromDisk(sid, root)

      // Add attribution before resetting the timer: rapid writes form one batch.
      const changedFiles = changedFilesFromTool(input.tool, input.args || {})
      const key = verificationBatchKey(root, sid)
      try {
        queueVerificationChanges(root, sid, changedFiles)
      } catch {
        // Keep an in-memory fallback when persistence is temporarily unavailable.
        const batch = pendingChangedFiles.get(key) || new Set<string>()
        for (const file of changedFiles) batch.add(file)
        pendingChangedFiles.set(key, batch)
      }

      const pendingVerify = debounceTimers.get(key)
      if (pendingVerify) clearTimeout(pendingVerify)
      const verifyTimer = setTimeout(() => {
        debounceTimers.delete(key)
        const pending = takePendingBatch(sid, root, false)
        // A manual verifier in another OpenCode context may already own it.
        if (pending.changedFiles.length === 0) return
        try {
          // Another hook may have reloaded this session while verification was
          // debounced. Reacquire its live object rather than mutating stale state.
          syncStateFromDisk(sid, root)
          const { receipt, friction } = verifyBatch(sid, root, "automatic", pending)
          const passed = receipt.verdict === "pass"
          client.app
            .log({
              body: {
                service: "parallax",
                level: passed ? "info" : "warn",
                message: passed
                  ? `[parallax] Check passed for ${receipt.changedFiles.length} file(s) (${friction.successes} ok / ${friction.trials} trials)`
                  : `[parallax] Check ${receipt.verdict.toUpperCase()} for ${receipt.changedFiles.length} file(s). ${friction.retriesLeft} retries left.`,
                extra: { receiptId: receipt.id, output: receipt.combined || receipt.skipReason },
              },
            })
            .catch(() => {})
        } catch (error) {
          client.app.log({
            body: {
              service: "parallax",
              level: "warn",
              message: "[parallax] Verification engine interrupted; the changed-file batch was retained.",
              extra: { output: String(error) },
            },
          }).catch(() => {})
        }
      }, CHECK_DEBOUNCE_MS)
      debounceTimers.set(key, verifyTimer)
    },

    // -----------------------------------------------------------------------
    // Message/event hooks: track the real session and active agent
    // -----------------------------------------------------------------------

    "chat.message": async (input: { sessionID: string; agent?: string }) => {
      const { sid } = activateSession(input.sessionID)
      const agent = normalizeAgentName(input.agent)
      if (agent) {
        currentAgentName = agent
        sessionAgentStore.set(sid, agent)
      }
    },

    event: async (input: {
      event: { type: string; properties?: Record<string, unknown> }
    }) => {
      if (input.event.type === "session.created") {
        const props = input.event.properties || {}
        const info = (props.info || {}) as Record<string, unknown>
        const createdSessionId =
          (info.id as string) ||
          (props.sessionID as string) ||
          (info.sessionID as string) ||
          null
        const eventRoot = (info.worktree as string) || (info.directory as string) || pluginRoot
        if (createdSessionId) activateSession(createdSessionId, eventRoot)

        // Agent name lives in Session.agent (v2 SDK types.gen.d.ts:590)
        // Normalize to lowercase for case-insensitive matching via isAgent()
        currentAgentName = normalizeAgentName(
          (info.agent as string) || (props.agent as string)
        )
        if (createdSessionId && currentAgentName) sessionAgentStore.set(createdSessionId, currentAgentName)

        // Initialize trace with session info
        if (createdSessionId) {
          const root = rootForSession(createdSessionId, eventRoot)
          syncStateFromDisk(createdSessionId, root)
          initTrace(createdSessionId, root, detectProject(root))
          writeState(false, createdSessionId, root)
        }
      }

      // Track agent switches (TAB to change agent in OpenCode TUI)
      if (input.event.type === "session.next.agent.switched") {
        const props = input.event.properties as Record<string, unknown> | undefined
        const sid = sessionId((props?.sessionID || props?.sessionId) as string | undefined)
        currentAgentName = normalizeAgentName(props?.agent as string)
        if (currentAgentName) sessionAgentStore.set(sid, currentAgentName)
      }

    },

    // -----------------------------------------------------------------------
    // Shell environment injection (Phase 2.6)
    // -----------------------------------------------------------------------

    "shell.env": async (input: { cwd: string; sessionID?: string }, output: { env: Record<string, string> }) => {
      const { sid, root } = activateSession(input.sessionID, worktree || directory || input.cwd)
      syncStateFromDisk(sid, root)
      const m = getMode(sid)
      const s = getFriction(sid)
      output.env.PARALLAX_MODE = m.mode
      output.env.PARALLAX_SESSION_ID = sid
      output.env.PARALLAX_FRICTION_RETRIES = String(s.retriesLeft)
    },

    // -----------------------------------------------------------------------
    // System prompt transformation: inject protocol status + mode skill
    // -----------------------------------------------------------------------

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system?: string[] },
    ) => {
      const { sid, root } = activateSession(input.sessionID || "current")
      // Synchronize exactly the OpenCode session being transformed.
      syncStateFromDisk(sid, root)
      const m = getMode(sid)
      const s = getFriction(sid)
      const p = getProtocol(sid)

      // Phase 2.5: Multi-agent protocol sharing -- carry state to new agent
      const activeAgentName = sessionAgentStore.get(sid) || (sid === "current" ? currentAgentName : null)
      if (activeAgentName) {
        const sys = output.system || (output.system = [])
        sys.push(
          `\n## PARALLAX AGENT CONTEXT\n` +
          `You are now operating as agent "${activeAgentName}". ` +
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
            "\n## HORIZON VERIFIED CHANGE LOOP\n\n" +
            "Horizon provides durable, prompt-driven supervision; it is not a background daemon or a completion guarantee.\n\n" +
            "### PREFLIGHT\n" +
            "Read repository instructions, current code/tests, and resumable state. Classify ambiguity. Ask only when an essential decision cannot be derived safely from evidence or user-only access blocks work; bundle related questions. OpenCode permission prompts are authoritative and autonomy settings do not bypass ask or deny. Complete ambiguity, invariants, and gate check-ins before project writes.\n\n" +
            "### CHANGE\n" +
            "For every atomic feature, dispatch one horizon-worker and wait; observe and persist its schema-v2 receipt ID/verdict; dispatch one read-only horizon-auditor and wait; then accept only with an observed pass plus auditor accept, otherwise use one corrective worker within the retry budget. At most one task is active: overlap, parallel dispatch, generic roles, and worker self-audit are forbidden. Keep detail in child traces and return only bounded structured summaries.\n\n" +
            "### VERIFY\n" +
            "Persist the observed schema-v2 receipt with horizon_record_verification before auditing. Only pass is passing evidence; fail, skipped, and unknown remain limitations. Self-reported scores and audit recommendations never replace receipt evidence or set readiness.\n\n" +
            "### RECEIPT\n" +
            "Persist and report changed files, acceptance status, exact checks and verdicts, receipt IDs, decisions, and residual risk. Separate completed, failed, skipped, and blocked work, and identify resumable state.\n\n" +
            "Discover tools from the current session rather than assuming an MCP or browser exists. State is under ~/.parallax/horizon/sessions/<id>/ and advances only while OpenCode is running and permissions are granted.",
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
      input: { sessionID: string },
      output: { context?: string[] },
    ) => {
      const { sid, root } = activateSession(input.sessionID)
      syncStateFromDisk(sid, root)
      const s = getFriction(sid)
      const m = getMode(sid)
      const p = getProtocol(sid)

      // Export trace to disk on compaction
      try {
        syncVerificationLedger(sid, root)
        exportTrace(sid, false, root)
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
