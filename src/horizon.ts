import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type {
  Attempt, Autonomy, BlockerKind, Feature, FeatureInput, MilestoneInput, Note, Plan, Receipt, Strategy,
} from "./types.js"
import { appendLine, readJson, readLines, safeId, writeJson } from "./fs.js"

const AGENT_BLOCKERS: BlockerKind[] = ["credentials", "external-service", "platform", "framework", "structural"]
const STRATEGIES: Strategy[] = ["correct", "replan", "research", "decompose"]
const DIRECTIVES: Record<Strategy, string> = {
  correct: "Give the next worker the exact receipt output and audit findings and ask for a focused correction; do not repeat an unchanged brief.",
  replan: "Re-read the workspace and the criteria, explain why the corrections failed, and brief a materially different implementation.",
  research: "Have the worker inspect framework docs, source, and proven nearby patterns before implementing again.",
  decompose: "Split the brief into smaller independently verifiable features, solve the first root constraint, then re-integrate.",
}
const ESCALATE_EVERY = 2
const LEASE_MS = 30_000

export function horizonDir(): string {
  return join(process.env.PARALLAX_HOME || join(homedir(), ".parallax"), "horizon")
}

function planDir(id: string): string {
  return join(horizonDir(), safeId(id))
}

function now(): string {
  return new Date().toISOString()
}

export function features(plan: Plan): Feature[] {
  return plan.milestones.flatMap((milestone) => milestone.features)
}

export function readPlan(id: string): Plan | null {
  const plan = readJson<Plan>(join(planDir(id), "plan.json"))
  return plan && plan.v === 2 ? plan : null
}

export function writePlan(plan: Plan): Plan {
  const all = features(plan)
  plan.completedAt = all.length > 0 && all.every((feature) => feature.status === "completed") ? plan.completedAt ?? now() : null
  writeJson(join(planDir(plan.id), "plan.json"), plan)
  return plan
}

export function listPlans(root?: string): Plan[] {
  const dir = horizonDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readPlan(entry.name))
    .filter((plan): plan is Plan => Boolean(plan) && (!root || plan!.root === resolve(root)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function planForSession(session: string, root: string): Plan | null {
  return listPlans(root).find((plan) => plan.session === session) ?? null
}

export function initPlan(goal: string, autonomy: Autonomy, session: string, root: string): Plan {
  if (!goal.trim()) throw new Error("goal is required")
  const existing = planForSession(session, root)
  if (existing && !existing.completedAt) throw new Error(`session already owns plan ${existing.id}`)
  const plan: Plan = {
    v: 2, id: randomUUID().slice(0, 8), session, root: resolve(root), goal: goal.trim(), autonomy,
    createdAt: now(), completedAt: null, pause: null, seq: 0, milestones: [],
  }
  return writePlan(plan)
}

export function adoptPlan(plan: Plan, session: string, root: string): Plan {
  if (plan.root !== resolve(root)) throw new Error(`plan ${plan.id} belongs to workspace ${plan.root}`)
  if (plan.session !== session) {
    plan.session = session
    writePlan(plan)
  }
  return plan
}

export function writeMilestones(plan: Plan, input: MilestoneInput[]): Plan {
  if (plan.completedAt) throw new Error("a completed plan cannot be rewritten")
  if (input.length === 0) throw new Error("at least one milestone is required")
  const prior = new Map(features(plan).map((feature) => [feature.id, feature] as const))
  const used = new Set<string>()
  const milestones = input.map((milestone, index) => {
    if (!milestone.name.trim()) throw new Error("milestone name is required")
    return {
      id: `m${index + 1}`,
      name: milestone.name.trim(),
      features: milestone.features.map((feature: FeatureInput) => {
        if (!feature.name.trim() || !feature.criteria.trim()) throw new Error("every feature needs a name and acceptance criteria")
        const old = feature.id ? prior.get(feature.id) : [...prior.values()].find((candidate) => candidate.name === feature.name.trim())
        const id = old?.id ?? `f${++plan.seq}`
        if (used.has(id)) throw new Error(`feature ${id} appears twice`)
        used.add(id)
        if (old && (old.attempts.length > 0 || old.status !== "pending")) return old
        return { id, name: feature.name.trim(), criteria: feature.criteria.trim(), status: "pending" as const, attempts: [], blocker: null }
      }),
    }
  })
  const dropped = [...prior.values()].filter((feature) => !used.has(feature.id) && (feature.attempts.length > 0 || feature.status !== "pending"))
  if (dropped.length) milestones.push({ id: `m${milestones.length + 1}`, name: "Carried over", features: dropped })
  plan.milestones = milestones
  return writePlan(plan)
}

export function strategyFor(failed: number): { strategy: Strategy; directive: string } {
  const strategy = STRATEGIES[Math.floor(failed / ESCALATE_EVERY) % STRATEGIES.length]
  return { strategy, directive: DIRECTIVES[strategy] }
}

export function failedAttempts(feature: Feature): number {
  return feature.attempts.filter((attempt) => attempt.verdict !== "pass" || attempt.audit === "corrective").length
}

function feature(plan: Plan, id: string): Feature {
  const found = features(plan).find((candidate) => candidate.id === id)
  if (!found) throw new Error(`feature ${id} is not in plan ${plan.id}`)
  return found
}

export function bindReceipt(plan: Plan, id: string, receipt: Receipt, workerAgent: string | null, summary: string): Plan {
  const target = feature(plan, id)
  if (target.status === "completed") throw new Error(`feature ${id} is already completed`)
  if (target.status === "review") throw new Error(`feature ${id} already has receipt ${target.attempts.at(-1)!.receipt} awaiting audit`)
  if (receipt.session === plan.session) throw new Error("the supervisor session cannot verify its own features; receipts come from a horizon-worker")
  if (workerAgent !== "horizon-worker") throw new Error(`receipt ${receipt.id} was produced by agent '${workerAgent ?? "unknown"}', not horizon-worker`)
  if (receipt.cwd !== plan.root) throw new Error("receipt belongs to a different workspace")
  for (const other of features(plan)) {
    for (const attempt of other.attempts) {
      if (attempt.receipt === receipt.id) throw new Error(`receipt ${receipt.id} is already bound to ${other.id}`)
      if (attempt.worker === receipt.session) throw new Error(`worker session ${receipt.session} already produced evidence for ${other.id}; each brief needs a fresh worker`)
    }
  }
  if (summary.length > 2000) throw new Error("summary exceeds 2000 characters")
  const attempt: Attempt = { worker: receipt.session, receipt: receipt.id, verdict: receipt.verdict, summary, auditor: null, audit: null, auditSummary: null }
  target.attempts.push(attempt)
  target.status = "review"
  target.blocker = null
  return writePlan(plan)
}

export function recordAudit(plan: Plan, id: string, auditor: string, auditorAgent: string | null, verdict: "accept" | "corrective", summary: string): Plan {
  const target = feature(plan, id)
  const attempt = target.attempts.at(-1)
  if (target.status !== "review" || !attempt) throw new Error(`feature ${id} has no receipt awaiting audit`)
  if (attempt.audit) throw new Error(`attempt ${target.attempts.length} of ${id} is already audited`)
  if (auditorAgent !== "horizon-auditor") throw new Error("audits are recorded by the horizon-auditor session itself")
  if (auditor === attempt.worker || auditor === plan.session) throw new Error("the auditor must be an independent session")
  if (features(plan).some((other) => other.attempts.some((candidate) => candidate.auditor === auditor))) throw new Error("each audit needs a fresh auditor session")
  if (verdict === "accept" && attempt.verdict !== "pass") throw new Error(`cannot accept a '${attempt.verdict}' receipt; only pass is passing evidence`)
  if (summary.length > 2000) throw new Error("summary exceeds 2000 characters")
  attempt.auditor = auditor
  attempt.audit = verdict
  attempt.auditSummary = summary
  target.status = verdict === "accept" ? "completed" : "pending"
  return writePlan(plan)
}

export function blockFeature(plan: Plan, id: string, kind: BlockerKind, evidence: string): Plan {
  const target = feature(plan, id)
  if (target.status === "completed") throw new Error(`feature ${id} is already completed`)
  if (!AGENT_BLOCKERS.includes(kind)) throw new Error(`blocker kind must be one of ${AGENT_BLOCKERS.join(", ")}`)
  if (evidence.trim().length < 20 || evidence.length > 4000) throw new Error("blocker evidence must be 20 to 4000 characters of concrete evidence")
  target.status = "blocked"
  target.blocker = { kind, evidence: evidence.trim(), at: now(), source: "agent" }
  return writePlan(plan)
}

export function unblockFeature(plan: Plan, id: string): Plan {
  const target = feature(plan, id)
  if (target.status !== "blocked") throw new Error(`feature ${id} is not blocked`)
  target.status = "pending"
  target.blocker = null
  return writePlan(plan)
}

export function pausePlan(plan: Plan, kind: BlockerKind, evidence: string): Plan {
  plan.pause = { kind, evidence, at: now(), source: "event" }
  return writePlan(plan)
}

export function resumePlan(plan: Plan, kinds?: BlockerKind[]): Plan {
  if (!plan.pause || plan.pause.source !== "event" || (kinds && !kinds.includes(plan.pause.kind))) return plan
  plan.pause = null
  return writePlan(plan)
}

export function progress(plan: Plan): string {
  return features(plan).map((feature) => `${feature.id}:${feature.status}:${feature.attempts.length}:${feature.attempts.at(-1)?.audit ?? ""}`).join("|")
}

export function runnable(plan: Plan): Feature[] {
  return features(plan).filter((feature) => feature.status === "pending" || feature.status === "review")
}

export function needsContinuation(plan: Plan): boolean {
  return plan.autonomy === "full" && !plan.completedAt && !plan.pause && (features(plan).length === 0 || runnable(plan).length > 0)
}

export function nextStep(plan: Plan): string {
  if (plan.completedAt) return "plan complete: write the final handoff"
  if (plan.pause) return `paused (${plan.pause.kind}): ${plan.pause.evidence}`
  if (features(plan).length === 0) return "write milestones and features with horizon_plan write"
  const current = runnable(plan)[0]
  if (!current) return "every remaining feature is blocked: report blockers with their evidence"
  if (current.status === "review") return `${current.id} has receipt ${current.attempts.at(-1)!.receipt} (${current.attempts.at(-1)!.verdict}): dispatch one horizon-auditor`
  const failed = failedAttempts(current)
  const { strategy, directive } = strategyFor(failed)
  return `${current.id} ${current.name}: dispatch one horizon-worker (attempt ${current.attempts.length + 1}, strategy ${strategy}). ${directive}`
}

export function summarize(plan: Plan): string {
  const all = features(plan)
  const done = all.filter((feature) => feature.status === "completed").length
  const lines = [`Plan ${plan.id} · ${plan.autonomy} autonomy · ${done}/${all.length} features complete`, `Goal: ${plan.goal}`]
  for (const milestone of plan.milestones) {
    lines.push(`${milestone.id} ${milestone.name}`)
    for (const feature of milestone.features) {
      const last = feature.attempts.at(-1)
      const evidence = last ? ` · receipt ${last.receipt.slice(0, 8)} ${last.verdict}${last.audit ? ` · audit ${last.audit}` : ""}` : ""
      const blocker = feature.blocker ? ` · ${feature.blocker.kind}: ${feature.blocker.evidence.slice(0, 120)}` : ""
      lines.push(`  ${feature.id} [${feature.status}] ${feature.name} (${feature.attempts.length} attempts)${evidence}${blocker}`)
      lines.push(`      criteria: ${feature.criteria}`)
    }
  }
  lines.push(`Next: ${nextStep(plan)}`)
  return lines.join("\n")
}

export function addNote(plan: Plan, note: Omit<Note, "at">): Note {
  if (!note.text.trim()) throw new Error("note text is required")
  if (note.feature) feature(plan, note.feature)
  const stored: Note = { at: now(), ...note, text: note.text.trim() }
  appendLine(join(planDir(plan.id), "notes.jsonl"), stored)
  return stored
}

export function readNotes(plan: Plan): Note[] {
  return readLines(join(planDir(plan.id), "notes.jsonl"), (value): value is Note =>
    Boolean(value) && typeof value === "object" && typeof (value as Note).text === "string" && typeof (value as Note).at === "string")
}

function dropLock(path: string): void {
  const stale = `${path}.${process.pid}.${randomUUID()}.stale`
  try {
    renameSync(path, stale)
    unlinkSync(stale)
  } catch {}
}

export function acquireLease(plan: Plan, owner: string): boolean {
  const path = join(planDir(plan.id), "autopilot.lock")
  const write = () => {
    try {
      writeFileSync(path, JSON.stringify({ owner, expiresAt: Date.now() + LEASE_MS }), { encoding: "utf8", flag: "wx" })
      return true
    } catch {
      return false
    }
  }
  if (write()) return true
  const current = readJson<{ expiresAt?: number }>(path)
  if (current && typeof current.expiresAt === "number" && current.expiresAt > Date.now()) return false
  dropLock(path)
  return write()
}

export function releaseLease(plan: Plan, owner: string): void {
  const path = join(planDir(plan.id), "autopilot.lock")
  let current: { owner?: string } | null = null
  try {
    current = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return
  }
  if (current?.owner === owner) dropLock(path)
}
