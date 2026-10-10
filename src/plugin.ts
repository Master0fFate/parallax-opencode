import { type Plugin, tool, type ToolContext } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Ambiguity, Decision, Plan, Receipt, Session } from "./types.js"
import { AGENT_NAMES, SKILLS_DIR, loadAgents } from "./agents.js"
import { gateFor, loadConfig } from "./config.js"
import * as horizon from "./horizon.js"
import { loadSession, updateSession } from "./session.js"
import { readReceipts, verify } from "./verify.js"

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"])
const MAX_STALLED_CONTINUATIONS = 6
const AMBIGUITY: Ambiguity[] = ["low", "medium", "high"]
const DECISIONS: Decision[] = ["full", "partial", "hold", "override"]

function filesFrom(args: Record<string, unknown>): string[] {
  for (const key of ["filePath", "path", "file_path"]) if (typeof args[key] === "string") return [args[key] as string]
  const patch = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm)].map((match) => match[1])
}

function short(id: string): string {
  return id.slice(0, 8)
}

function describe(receipt: Receipt): string {
  const command = receipt.command ? `${receipt.command} ${receipt.args.join(" ")}` : "no check"
  return `${receipt.verdict} · ${short(receipt.id)} · ${command} · ${receipt.durationMs}ms${receipt.reason ? ` · ${receipt.reason}` : ""}`
}

function fail(error: unknown): string {
  return `[parallax] ${error instanceof Error ? error.message : String(error)}`
}

export const plugin: Plugin = async ({ client, directory, worktree }) => {
  const root = resolve(worktree || directory)
  const parents = new Map<string, string | null>()
  const inflight = new Set<string>()
  const delegating = new Set<string>()
  const leases = new Map<string, string>()
  const stalls = new Map<string, { signature: string; count: number }>()

  const log = (level: "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "parallax", level, message } }).catch(() => {})

  const parentOf = async (sid: string): Promise<string | null> => {
    if (parents.has(sid)) return parents.get(sid)!
    let parent: string | null = null
    try {
      const result = await client.session.get({ path: { id: sid } })
      parent = result.data?.parentID ?? null
    } catch {}
    parents.set(sid, parent)
    return parent
  }

  const ownedPlan = async (sid: string): Promise<Plan | null> => {
    let current: string | null = sid
    for (let depth = 0; depth < 4 && current; depth++) {
      const plan = horizon.planForSession(current, root)
      if (plan) return plan
      current = await parentOf(current)
    }
    return null
  }

  const requirePlan = async (sid: string, id?: string): Promise<Plan> => {
    const plan = id ? horizon.readPlan(id) : await ownedPlan(sid)
    if (!plan) throw new Error(id ? `plan ${id} not found` : "this session owns no Horizon plan; use horizon_plan init or read")
    if (plan.root !== root) throw new Error(`plan ${plan.id} belongs to workspace ${plan.root}`)
    return plan
  }

  const status = async (sid: string): Promise<string[]> => {
    const session = loadSession(root, sid)
    if (!session.agent || !AGENT_NAMES.has(session.agent)) return []
    const lines = ["## Parallax"]
    try {
      const config = loadConfig(root)
      lines.push(session.preflight
        ? `Preflight done (ambiguity ${session.preflight.ambiguity}); criteria: ${session.preflight.criteria.slice(0, 200)}`
        : `Preflight pending: call parallax_preflight before editing (${config.strictness} gate)`)
    } catch (error) {
      lines.push(`Config error: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (session.pending.length) lines.push(`Unverified edits: ${session.pending.length} file(s); call parallax_verify before parallax_receipt`)
    if (session.lastFail) lines.push(`Last check failed (receipt ${short(session.lastFail.id)}); fix before continuing:\n${session.lastFail.output.slice(0, 1200)}`)
    const plan = session.agent.startsWith("horizon") ? await ownedPlan(sid) : null
    if (plan) lines.push(`Horizon plan ${plan.id}: ${horizon.nextStep(plan)}`)
    return lines
  }

  const pause = async (sid: string, kind: "permissions" | "user-cancelled", evidence: string) => {
    const plan = await ownedPlan(sid)
    if (plan && !plan.completedAt) {
      horizon.pausePlan(plan, kind, evidence)
      delegating.delete(plan.session)
    }
  }

  const resume = async (sid: string, kinds?: ("permissions" | "user-cancelled" | "structural")[]) => {
    const plan = await ownedPlan(sid)
    if (plan) horizon.resumePlan(plan, kinds)
  }

  const stalled = (plan: Plan): boolean => {
    const signature = horizon.progress(plan)
    const previous = stalls.get(plan.id)
    const count = previous?.signature === signature ? previous.count + 1 : 1
    stalls.set(plan.id, { signature, count })
    if (count <= MAX_STALLED_CONTINUATIONS) return false
    horizon.pausePlan(plan, "structural", `autopilot re-prompted ${MAX_STALLED_CONTINUATIONS} times without any feature progress; a new user message resumes the plan`)
    stalls.delete(plan.id)
    log("warn", `horizon plan ${plan.id} paused after ${MAX_STALLED_CONTINUATIONS} continuations without progress`)
    return true
  }

  const continueHorizon = async (sid: string) => {
    const plan = horizon.planForSession(sid, root)
    if (!plan || !horizon.needsContinuation(plan) || inflight.has(sid) || stalled(plan)) return
    const owner = `${process.pid}:${randomUUID()}`
    if (!horizon.acquireLease(plan, owner)) return
    leases.set(sid, owner)
    inflight.add(sid)
    try {
      await client.session.promptAsync({
        path: { id: sid },
        query: { directory: root },
        body: {
          agent: "horizon",
          parts: [{
            type: "text",
            synthetic: true,
            text: `[horizon autopilot] Plan ${plan.id} still has runnable work. Read it with horizon_plan read, then continue. Next: ${horizon.nextStep(plan)}`,
          }],
        },
        throwOnError: true,
      })
    } catch (error) {
      horizon.releaseLease(plan, owner)
      leases.delete(sid)
      log("error", `horizon continuation failed for ${sid}: ${String(error)}`)
    } finally {
      inflight.delete(sid)
    }
  }

  const agentOf = (context: ToolContext) => context.agent?.trim().toLowerCase() || null

  return {
    config: async (config) => {
      const agents = (config.agent ??= {})
      for (const [name, definition] of Object.entries(loadAgents())) {
        const user = (agents[name] ?? {}) as Record<string, unknown>
        agents[name] = {
          ...definition,
          ...user,
          permission: { ...definition.permission, ...((user.permission as Record<string, unknown>) ?? {}) },
        } as (typeof agents)[string]
      }
      const skills = ((config as Record<string, unknown>).skills ??= {}) as { paths?: string[] }
      if (!skills.paths?.includes(SKILLS_DIR)) skills.paths = [...(skills.paths ?? []), SKILLS_DIR]
    },

    tool: {
      parallax_preflight: tool({
        description: "Record the preflight before editing: ambiguity level, acceptance criteria, and the invariants that matter. Unlocks file edits for this session.",
        args: {
          ambiguity: tool.schema.enum(["low", "medium", "high"]).describe("How ambiguous the request is after reading the code"),
          criteria: tool.schema.string().min(1).describe("Measurable acceptance criteria for this change"),
          invariants: tool.schema.string().min(1).describe("State ownership, feedback paths, blast radius, and timing concerns that apply"),
        },
        async execute(args, context) {
          if (!AMBIGUITY.includes(args.ambiguity)) return "[parallax] ambiguity must be low, medium, or high"
          updateSession(root, context.sessionID, (session) => {
            session.agent ??= agentOf(context)
            session.preflight = { at: new Date().toISOString(), ambiguity: args.ambiguity, criteria: args.criteria, invariants: args.invariants }
            session.closed = null
          })
          return `[parallax] preflight recorded (ambiguity ${args.ambiguity}). Edits are unlocked; call parallax_verify after each batch of changes.`
        },
      }),

      parallax_verify: tool({
        description: "Run the project's own check (test, typecheck, lint, build, cargo check, go vet, or python compileall) on the pending edits and record a receipt. Only pass is passing evidence.",
        args: {},
        async execute(_args, context) {
          const sid = context.sessionID
          let config
          try {
            config = loadConfig(root)
          } catch (error) {
            return fail(error)
          }
          const before = loadSession(root, sid)
          const receipt = await verify({ cwd: root, session: sid, files: before.pending, timeoutMs: config.timeoutMs })
          updateSession(root, sid, (session) => {
            session.agent ??= agentOf(context)
            session.pending = session.pending.filter((file) => !receipt.files.includes(file))
            session.receipts.push(receipt.id)
            session.lastFail = receipt.verdict === "fail" ? { id: receipt.id, output: receipt.output.slice(-2000) } : null
          })
          const heading = `[parallax] ${receipt.verdict.toUpperCase()} · receipt ${receipt.id}`
          const command = receipt.command ? `${receipt.command} ${receipt.args.join(" ")}` : "no check available"
          const detail = receipt.verdict === "skipped" || receipt.verdict === "unknown" ? receipt.reason ?? "" : receipt.output.slice(-2400)
          return `${heading}\n${command} · ${receipt.durationMs}ms · exit ${receipt.exitCode ?? "none"} · ${receipt.files.length} file(s)\n${detail}`.trim()
        },
      }),

      parallax_receipt: tool({
        description: "Close the change with a commit decision and summary. Refuses while edits remain unverified. Returns the session's evidence for the handoff.",
        args: {
          decision: tool.schema.enum(["full", "partial", "hold", "override"]).describe("full: criteria met with a passing check; partial: shipped with named gaps; hold: stopped pending the user; override: user accepted the risk"),
          summary: tool.schema.string().min(1).describe("One paragraph: what changed, what was verified, what remains"),
        },
        async execute(args, context) {
          if (!DECISIONS.includes(args.decision)) return "[parallax] decision must be full, partial, hold, or override"
          const sid = context.sessionID
          let config
          try {
            config = loadConfig(root)
          } catch (error) {
            return fail(error)
          }
          const session = loadSession(root, sid)
          if (session.pending.length && config.strictness !== "relaxed") {
            return `[parallax] ${session.pending.length} unverified file(s): ${session.pending.join(", ")}. Call parallax_verify first.`
          }
          const receipts = readReceipts(root, sid)
          const last = receipts.at(-1)
          if (args.decision === "full" && receipts.length && last?.verdict !== "pass") {
            return `[parallax] the last check was '${last?.verdict}'; a full decision needs a passing receipt. Fix and verify, or choose partial, hold, or override.`
          }
          updateSession(root, sid, (current) => {
            current.agent ??= agentOf(context)
            current.closed = { at: new Date().toISOString(), decision: args.decision, summary: args.summary }
          })
          return render(sid, loadSession(root, sid), receipts)
        },
      }),

      parallax_trace: tool({
        description: "Show this session's evidence: preflight, checks with verdicts and receipt ids, unverified edits, and the closing decision. Markdown, ready for a PR comment.",
        args: {},
        async execute(_args, context) {
          const sid = context.sessionID
          return render(sid, loadSession(root, sid), readReceipts(root, sid))
        },
      }),

      horizon_plan: tool({
        description: "Horizon plan persistence. init: create a plan for a goal. write: set milestones and features (existing evidence is preserved). read: show a plan and the next step. list: plans for this workspace.",
        args: {
          action: tool.schema.enum(["init", "write", "read", "list"]),
          goal: tool.schema.string().optional().describe("init: the user's goal"),
          autonomy: tool.schema.enum(["full", "manual"]).optional().describe("init: full re-prompts automatically while work remains (default); manual stops at the end of each turn"),
          id: tool.schema.string().optional().describe("read/write: plan id; defaults to the plan this session owns. Reading another plan of this workspace adopts it."),
          milestones: tool.schema.array(tool.schema.object({
            name: tool.schema.string(),
            features: tool.schema.array(tool.schema.object({
              id: tool.schema.string().optional().describe("existing feature id to keep"),
              name: tool.schema.string(),
              criteria: tool.schema.string().describe("concrete acceptance criteria the auditor can check"),
            })),
          })).optional().describe("write: ordered milestones with atomic features"),
        },
        async execute(args, context) {
          const sid = context.sessionID
          try {
            if (args.action === "list") {
              const plans = horizon.listPlans(root)
              return plans.length
                ? plans.map((plan) => `${plan.id} · ${plan.completedAt ? "completed" : plan.pause ? `paused (${plan.pause.kind})` : "active"} · ${horizon.features(plan).filter((feature) => feature.status === "completed").length}/${horizon.features(plan).length} · ${plan.goal.slice(0, 80)}${plan.session === sid ? " · owned by this session" : ""}`).join("\n")
                : "[horizon] no plans for this workspace"
            }
            if (args.action === "init") {
              if (!args.goal) return "[horizon] init requires goal"
              const plan = horizon.initPlan(args.goal, args.autonomy ?? "full", sid, root)
              return `[horizon] plan ${plan.id} created (${plan.autonomy} autonomy). Next: horizon_plan write with milestones and atomic features.`
            }
            let plan = await requirePlan(sid, args.id)
            if (args.action === "read") {
              if (agentOf(context) === "horizon") plan = horizon.adoptPlan(plan, sid, root)
              const notes = horizon.readNotes(plan)
              return `${horizon.summarize(plan)}${notes.length ? `\nNotes: ${notes.length} (horizon_note list)` : ""}`
            }
            if (agentOf(context) !== "horizon") return "[horizon] only the horizon agent writes plans"
            if (!args.milestones) return "[horizon] write requires milestones"
            plan = horizon.writeMilestones(plan, args.milestones)
            return horizon.summarize(plan)
          } catch (error) {
            return fail(error)
          }
        },
      }),

      horizon_feature: tool({
        description: "Horizon feature evidence. receipt (horizon): bind a horizon-worker's receipt id to a feature. audit (horizon-auditor only): record accept or corrective for the feature under review; accept with a pass receipt completes it. block/unblock (horizon): typed blocker with concrete evidence.",
        args: {
          action: tool.schema.enum(["receipt", "audit", "block", "unblock"]),
          id: tool.schema.string().describe("feature id, e.g. f3"),
          plan: tool.schema.string().optional().describe("plan id; defaults to the plan this session or its parent owns"),
          receipt: tool.schema.string().optional().describe("receipt: the receipt id the worker reported"),
          summary: tool.schema.string().optional().describe("receipt/audit: bounded summary, at most 2000 characters"),
          verdict: tool.schema.enum(["accept", "corrective"]).optional().describe("audit: accept or corrective"),
          kind: tool.schema.enum(["credentials", "external-service", "platform", "framework", "structural"]).optional().describe("block: blocker kind"),
          evidence: tool.schema.string().optional().describe("block: concrete evidence that no runnable recovery remains"),
        },
        async execute(args, context) {
          const sid = context.sessionID
          const agent = agentOf(context)
          try {
            const plan = await requirePlan(sid, args.plan)
            if (args.action === "audit") {
              if (agent !== "horizon-auditor") return "[horizon] only the horizon-auditor records audits"
              if (!args.verdict || !args.summary) return "[horizon] audit requires verdict and summary"
              horizon.recordAudit(plan, args.id, sid, agent, args.verdict, args.summary)
              const feature = horizon.features(plan).find((candidate) => candidate.id === args.id)!
              return `[horizon] audit ${args.verdict} recorded for ${args.id}; status ${feature.status}`
            }
            if (agent !== "horizon") return "[horizon] only the horizon agent binds receipts and blockers"
            if (args.action === "receipt") {
              if (!args.receipt) return "[horizon] receipt requires the receipt id"
              const receipt = readReceipts(root).find((candidate) => candidate.id === args.receipt || candidate.id.startsWith(args.receipt!))
              if (!receipt) return `[horizon] receipt ${args.receipt} is not in this workspace's ledger; a worker claim is not a receipt`
              horizon.bindReceipt(plan, args.id, receipt, loadSession(root, receipt.session).agent, args.summary ?? "")
              return `[horizon] receipt ${short(receipt.id)} (${receipt.verdict}) bound to ${args.id}. ${receipt.verdict === "pass" ? "Dispatch one horizon-auditor with the feature id, criteria, and receipt id." : "Only pass is passing evidence; the auditor can only return corrective. Dispatch the auditor or start a corrective worker after it."}`
            }
            if (args.action === "block") {
              if (!args.kind || !args.evidence) return "[horizon] block requires kind and evidence"
              horizon.blockFeature(plan, args.id, args.kind, args.evidence)
              return `[horizon] ${args.id} blocked (${args.kind}). Next: ${horizon.nextStep(plan)}`
            }
            horizon.unblockFeature(plan, args.id)
            return `[horizon] ${args.id} unblocked. Next: ${horizon.nextStep(plan)}`
          } catch (error) {
            return fail(error)
          }
        },
      }),

      horizon_note: tool({
        description: "Append or list durable Horizon notes: decisions made under ambiguity and research findings, optionally tied to a feature.",
        args: {
          action: tool.schema.enum(["add", "list"]),
          kind: tool.schema.enum(["decision", "research"]).optional(),
          feature: tool.schema.string().optional(),
          text: tool.schema.string().optional(),
          plan: tool.schema.string().optional(),
        },
        async execute(args, context) {
          try {
            const plan = await requirePlan(context.sessionID, args.plan)
            if (args.action === "list") {
              const notes = horizon.readNotes(plan)
              return notes.length
                ? notes.map((note) => `${note.at.slice(0, 16)} ${note.kind}${note.feature ? ` ${note.feature}` : ""}: ${note.text}`).join("\n")
                : "[horizon] no notes"
            }
            if (!args.text || !args.kind) return "[horizon] add requires kind and text"
            horizon.addNote(plan, { kind: args.kind, feature: args.feature ?? null, text: args.text })
            return `[horizon] ${args.kind} noted`
          } catch (error) {
            return fail(error)
          }
        },
      }),
    },

    "chat.message": async (input, output) => {
      const sid = input.sessionID
      const agent = input.agent?.trim().toLowerCase()
      if (agent) {
        const current = loadSession(root, sid)
        if (current.agent !== agent) updateSession(root, sid, (session) => void (session.agent = agent))
      }
      const synthetic = output.parts.length > 0 && output.parts.every((part) => part.type === "text" && part.synthetic === true)
      if (!synthetic) await resume(sid, ["user-cancelled", "structural"])
    },

    "tool.execute.before": async (input, output) => {
      const sid = input.sessionID
      if (input.tool === "task") {
        const session = loadSession(root, sid)
        if (session.agent === "horizon") {
          if (delegating.has(sid)) throw new Error("[horizon] one delegated task at a time: wait for the active worker or auditor to finish")
          delegating.add(sid)
        }
        return
      }
      if (!WRITE_TOOLS.has(input.tool)) return
      const session = loadSession(root, sid)
      if (!session.agent || !AGENT_NAMES.has(session.agent) || session.preflight) return
      const files = filesFrom(output.args ?? {})
      if (gateFor(loadConfig(root), root, files) === "track") return
      throw new Error("[parallax] call parallax_preflight (ambiguity, acceptance criteria, invariants) before editing files")
    },

    "tool.execute.after": async (input) => {
      const sid = input.sessionID
      if (input.tool === "task") {
        delegating.delete(sid)
        return
      }
      if (!WRITE_TOOLS.has(input.tool)) return
      const files = filesFrom(input.args ?? {})
      if (!files.length) return
      const session = loadSession(root, sid)
      if (!session.agent || !AGENT_NAMES.has(session.agent)) return
      updateSession(root, sid, (current) => {
        for (const file of files) if (!current.pending.includes(file)) current.pending.push(file)
        current.closed = null
      })
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sid = event.properties.sessionID
        delegating.delete(sid)
        const owner = leases.get(sid)
        if (owner) {
          const plan = horizon.planForSession(sid, root)
          if (plan) horizon.releaseLease(plan, owner)
          leases.delete(sid)
        }
        if (loadSession(root, sid).agent === "horizon") await continueHorizon(sid)
      } else if (event.type === "session.error") {
        const sid = event.properties.sessionID
        if (sid && event.properties.error?.name === "MessageAbortedError") {
          await pause(sid, "user-cancelled", "the user cancelled the active turn; a new user message resumes the plan")
        }
      } else if (event.type === "permission.replied") {
        const { sessionID, permissionID, response } = event.properties
        if (response === "reject") await pause(sessionID, "permissions", `OpenCode permission ${permissionID} was rejected by the user`)
        else if (response === "once" || response === "always") await resume(sessionID, ["permissions"])
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const lines = await status(input.sessionID)
      if (lines.length) output.system.push(lines.join("\n"))
    },

    "experimental.session.compacting": async (input, output) => {
      const lines = await status(input.sessionID)
      if (lines.length) output.context.push(lines.join("\n"))
    },
  }
}

function render(sid: string, session: Session, receipts: Receipt[]): string {
  const lines = [`## Parallax receipt · session ${sid}`]
  if (session.preflight) {
    lines.push(`- Ambiguity: ${session.preflight.ambiguity}`, `- Criteria: ${session.preflight.criteria}`, `- Invariants: ${session.preflight.invariants}`)
  } else lines.push("- Preflight: not recorded")
  lines.push(receipts.length ? "### Checks" : "### Checks: none run")
  for (const receipt of receipts) lines.push(`- ${describe(receipt)}${receipt.files.length ? ` · ${receipt.files.join(", ")}` : ""}`)
  lines.push(session.pending.length ? `### Unverified edits\n${session.pending.map((file) => `- ${file}`).join("\n")}` : "### Unverified edits: none")
  if (session.closed) lines.push(`### Decision: ${session.closed.decision}`, session.closed.summary)
  return lines.join("\n")
}

export default plugin
