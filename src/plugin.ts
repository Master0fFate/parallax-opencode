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

import { type PluginModule, tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

import type {
  AgentMode,
  ProtocolStep,
  FrictionState,
  ModeState,
  ProtocolState,
} from "./types"
import { detectProject, runVerify } from "./detect"
import {
  initTrace,
  addPhase,
  addWrite,
  exportTrace,
  getTrace,
} from "./trace"
import { computeCoherenceScore } from "./score"
import { initDiscordRpc, getDiscordRpc, destroyDiscordRpc, resolveAgent } from "./discord-rpc"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FRICTION_RETRIES = 3
// ## BROKEN -- Discord RPC never shows presence. See src/discord-rpc.ts
const DISCORD_RPC_ENABLED = process.env.PARALLAX_DISCORD_RPC !== "false"
const CHECK_DEBOUNCE_MS = 1000
const CONFIG_DIR = join(homedir(), ".config", "opencode")

// ---------------------------------------------------------------------------
// Module-level stores
// ---------------------------------------------------------------------------

const frictionStore = new Map<string, FrictionState>()
const modeStore = new Map<string, ModeState>()
const protocolStore = new Map<string, ProtocolState>()
let currentSessionId: string | null = null
let currentAgentName: string | null = null

function sessionId(): string {
  return currentSessionId || "default"
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
      commitDone: false,
      summaryDone: false,
      writesBeforeGate: 0,
      gateBlocked: false,
    })
  }
  return protocolStore.get(s)!
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
  commit: "Commit Decision",
  summary: "Summarize",
}

interface ModeMeta {
  skill: string | null
  label: string | null
}

const MODE_META: Record<AgentMode, ModeMeta> = {
  free:  { skill: null,                    label: null },
  build: { skill: null,                    label: "PARALLAX BUILD MODE" },
  plan:  { skill: "parallax-plan",         label: "PARALLAX PLAN MODE" },
  debug: { skill: "parallax-debug",        label: "PARALLAX DEBUG MODE" },
}

// ---------------------------------------------------------------------------
// Debounce timer
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: "parallax-engine",
  server: async ({ client }) => {
    if (DISCORD_RPC_ENABLED) {
      initDiscordRpc().catch(() => {})
    }

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
            "The protocol step to mark complete: ambiguity, invariants, gate, commit, summary",
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

          // Enforce ordering
          if (step === "ambiguity" && !p.ambiguityDone) {
            p.ambiguityDone = true
            addPhase(sid, "ambiguity_check")
            return "[parallax] Step 1/6: Ambiguity Check marked complete."
          }
          if (step === "invariants") {
            if (!p.ambiguityDone) {
              return "[parallax] ERROR: Complete Ambiguity Check first (Step 1)."
            }
            p.invariantsDone = true
            addPhase(sid, "four_invariants")
            return "[parallax] Step 2/6: 4 Invariants marked complete."
          }
          if (step === "gate") {
            if (!p.invariantsDone) {
              return "[parallax] ERROR: Complete 4 Invariants first (Step 2)."
            }
            p.gateDone = true
            addPhase(sid, "verification_gate")
            return "[parallax] Step 3/6: Verification Gate marked complete."
          }
          if (step === "commit") {
            p.commitDone = true
            addPhase(sid, "commit_decision")
            return "[parallax] Step 5/6: Commit Decision marked complete."
          }
          if (step === "summary") {
            p.summaryDone = true
            addPhase(sid, "summary")
            return "[parallax] Step 6/6: Summary marked complete. Protocol finished."
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
          return (
            "[parallax] DEBUG mode activated. Universal Auditor skill loaded. " +
            "Run a full audit pass."
          )
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
    },

    // -----------------------------------------------------------------------
    // Pre-write enforcement: protocol ordering + friction block
    // -----------------------------------------------------------------------

    "tool.execute.before": async (input: { tool: string }) => {
      if (!["write", "edit", "apply_patch"].includes(input.tool)) return

      if (DISCORD_RPC_ENABLED) {
        const rpc = getDiscordRpc()
        if (rpc.connected) {
          rpc.updatePresence({
            status: "coding",
            mode: getMode().mode,
            agent: resolveAgent(currentAgentName),
          }).catch(() => {})
        }
      }

      const p = getProtocol()

      // Enforce ambiguity check before any write
      if (!p.ambiguityDone) {
        throw new Error(
          `[parallax] PROTOCOL VIOLATION: Ambiguity Check (Step 1) not completed.\n` +
          `You MUST state HIGH/MEDIUM/LOW and ask clarifying questions ` +
          `before writing code.\n` +
          `Use parallax_checkin({ step: "ambiguity" }) after completing it.`,
        )
      }

      // Warn after 3 writes without invariants checkin
      if (!p.invariantsDone) {
        p.writesBeforeGate++
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

      if (DISCORD_RPC_ENABLED) {
        const rpc = getDiscordRpc()
        if (rpc.connected) {
          rpc.updatePresence({
            status: "coding",
            mode: getMode().mode,
            agent: resolveAgent(currentAgentName),
          }).catch(() => {})
        }
      }

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
        currentSessionId =
          (info.id as string) ||
          (props.sessionID as string) ||
          (info.sessionID as string) ||
          null

        // Agent name lives in Session.agent (v2 SDK types.gen.d.ts:590)
        currentAgentName =
          (info.agent as string) ||
          (props.agent as string) ||
          null

        // Initialize trace with session info
        if (currentSessionId) {
          initTrace(currentSessionId, process.cwd(), detectProject())
        }
      }

      // Track agent switches (TAB to change agent in OpenCode TUI)
      if (input.event.type === "session.next.agent.switched") {
        const props = input.event.properties as Record<string, unknown> | undefined
        currentAgentName = (props?.agent as string) || null
      }

      // Discord RPC: track session lifecycle
      if (DISCORD_RPC_ENABLED) {
        const rpc = getDiscordRpc()
        const agent = resolveAgent(currentAgentName)
        switch (input.event.type) {
          case "session.created": {
            rpc.startSession()
            rpc.updatePresence({
              status: "coding",
              mode: getMode().mode,
              agent,
            }).catch(() => {})
            break
          }
          case "session.status": {
            const props = input.event.properties as
              | { status?: { type?: string } }
              | undefined
            const statusType = props?.status?.type
            if (statusType === "busy") {
              rpc.updatePresence({
                status: "coding",
                mode: getMode().mode,
                agent,
              }).catch(() => {})
            } else if (statusType === "idle") {
              rpc.updatePresence({
                status: "waiting",
                mode: getMode().mode,
                agent,
              }).catch(() => {})
            }
            break
          }
          case "session.deleted": {
            rpc.clearPresence().catch(() => {})
            rpc.clearSession()
            break
          }
          case "session.idle": {
            rpc.updatePresence({
              status: "idle",
              mode: getMode().mode,
              agent,
            }).catch(() => {})
            break
          }
          case "message.part.updated": {
            rpc.updatePresence({
              status: "thinking",
              mode: getMode().mode,
              agent,
            }).catch(() => {})
            break
          }
        }
      }
    },

    // -----------------------------------------------------------------------
    // Chat hooks: detect model for Discord RPC
    // -----------------------------------------------------------------------

    "chat.message": async (input: {
      sessionID: string
      agent?: string
      model?: { modelID?: string }
    }) => {
      if (!DISCORD_RPC_ENABLED) return
      const rpc = getDiscordRpc()
      if (!rpc.connected) return

      // Agent name comes directly from the hook input (v2 SDK)
      if (input.agent) currentAgentName = input.agent

      let modelName: string | undefined
      if (input.model?.modelID) {
        modelName = input.model.modelID
          .replace(/-\d{4}-\d{2}-\d{2}$/, "")
          .replace(/-\d{8}$/, "")
      }

      rpc.updatePresence({
        status: "thinking",
        modelName,
        mode: getMode().mode,
        agent: resolveAgent(currentAgentName),
      }).catch(() => {})
    },

    "chat.params": async (input: {
      sessionID: string
      agent: string
      model: { id: string }
    }) => {
      if (!DISCORD_RPC_ENABLED) return
      const rpc = getDiscordRpc()
      if (!rpc.connected) return

      // Agent name is required in chat.params
      currentAgentName = input.agent

      let modelName: string | undefined
      if (input.model?.id) {
        modelName = input.model.id
          .replace(/-\d{4}-\d{2}-\d{2}$/, "")
          .replace(/-\d{8}$/, "")
      }

      rpc.updatePresence({
        status: "thinking",
        modelName,
        mode: getMode().mode,
        agent: resolveAgent(currentAgentName),
      }).catch(() => {})
    },

    // -----------------------------------------------------------------------
    // System prompt transformation: inject protocol status + mode skill
    // -----------------------------------------------------------------------

    "experimental.chat.system.transform": async (
      _input: unknown,
      output: { system?: string[] },
    ) => {
      const m = getMode()
      const s = getFriction()
      const p = getProtocol()

      // Build protocol status block
      const statusLines: string[] = []
      const steps: ProtocolStep[] = [
        "ambiguity",
        "invariants",
        "gate",
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
      ctx.push(
        `## PARALLAX SESSION STATE\n` +
          `- Mode: ${m.mode}\n` +
          `- Ambiguity: ${p.ambiguityDone}, Invariants: ${p.invariantsDone}, ` +
          `Gate: ${p.gateDone}\n` +
          `- Friction: ${s.successes} ok / ${s.trials} trials, ` +
          `Retries: ${s.retriesLeft}`,
      )
    },
  }
}
} satisfies PluginModule
