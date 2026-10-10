import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import type { Plan, Receipt } from "../types.js"
import * as horizon from "../horizon.js"
import { remove, tempDir } from "./helpers.js"

const home = tempDir("parallax-horizon-home")
const root = tempDir("parallax-horizon-root")
before(() => {
  process.env.PARALLAX_HOME = home
})
after(() => {
  remove(home)
  remove(root)
})

function receipt(session: string, verdict: Receipt["verdict"] = "pass", id = `r-${session}-${verdict}`): Receipt {
  return {
    v: 3, id, session, at: new Date().toISOString(), cwd: root, command: verdict === "skipped" ? null : "npm", args: ["run", "test"],
    timeoutMs: 1000, durationMs: 1, exitCode: verdict === "pass" ? 0 : verdict === "fail" ? 1 : null, verdict, files: [], output: "",
    truncated: false, timedOut: false, reason: verdict === "pass" || verdict === "fail" ? null : "reason",
  }
}

function planned(session = `s-${Math.random()}`): Plan {
  const plan = horizon.initPlan("Ship the thing", "full", session, root)
  return horizon.writeMilestones(plan, [
    { name: "Core", features: [{ name: "Schema", criteria: "migration applies" }, { name: "API", criteria: "endpoint returns 200" }] },
    { name: "Release", features: [{ name: "Publish", criteria: "tag pushed" }] },
  ])
}

describe("plans", () => {
  it("initializes, lists per workspace, and resolves ownership", () => {
    const plan = planned("owner-1")
    assert.equal(plan.autonomy, "full")
    assert.equal(horizon.features(plan).length, 3)
    assert.deepEqual(horizon.features(plan).map((feature) => feature.id), ["f1", "f2", "f3"])
    assert.equal(horizon.planForSession("owner-1", root)?.id, plan.id)
    assert.equal(horizon.planForSession("owner-1", tempDir("other")), null)
    assert.ok(horizon.listPlans(root).some((entry) => entry.id === plan.id))
    assert.throws(() => horizon.initPlan("again", "full", "owner-1", root), /already owns/)
    assert.throws(() => horizon.initPlan("", "full", "x", root), /goal/)
  })

  it("merges rewritten milestones while preserving evidence-bearing features", () => {
    const plan = planned()
    horizon.bindReceipt(plan, "f1", receipt("w1"), "horizon-worker", "done")
    const rewritten = horizon.writeMilestones(plan, [
      { name: "Core", features: [{ id: "f1", name: "Schema renamed", criteria: "changed" }, { name: "API", criteria: "new criteria" }] },
    ])
    const [f1, f2] = horizon.features(rewritten)
    assert.equal(f1.name, "Schema")
    assert.equal(f1.status, "review")
    assert.equal(f2.id, "f2")
    assert.equal(f2.criteria, "new criteria")
    assert.equal(horizon.features(rewritten).length, 2)
    const dropped = horizon.writeMilestones(rewritten, [{ name: "Only new", features: [{ name: "Fresh", criteria: "x" }] }])
    assert.deepEqual(horizon.features(dropped).map((feature) => feature.id), ["f4", "f1"])
    assert.equal(dropped.milestones.at(-1)?.name, "Carried over")
    assert.throws(() => horizon.writeMilestones(dropped, []), /at least one/)
    assert.throws(() => horizon.writeMilestones(dropped, [{ name: "x", features: [{ name: "", criteria: "c" }] }]), /name and acceptance/)
  })

  it("adopts plans within the same workspace only", () => {
    const plan = planned("first")
    horizon.adoptPlan(plan, "second", root)
    assert.equal(horizon.readPlan(plan.id)?.session, "second")
    assert.throws(() => horizon.adoptPlan(plan, "third", tempDir("elsewhere")), /belongs to workspace/)
  })
})

describe("evidence pipeline", () => {
  it("requires a worker receipt, then an independent audit, then completes", () => {
    const plan = planned("sup")
    assert.throws(() => horizon.bindReceipt(plan, "f1", receipt("sup"), "horizon", "x"), /supervisor session cannot verify/)
    assert.throws(() => horizon.bindReceipt(plan, "f1", receipt("w1"), "parallax", "x"), /not horizon-worker/)
    assert.throws(() => horizon.bindReceipt(plan, "f1", { ...receipt("w1"), cwd: "/elsewhere" }, "horizon-worker", "x"), /different workspace/)
    horizon.bindReceipt(plan, "f1", receipt("w1"), "horizon-worker", "implemented")
    assert.equal(horizon.features(plan)[0].status, "review")
    assert.throws(() => horizon.bindReceipt(plan, "f1", receipt("w2"), "horizon-worker", "x"), /awaiting audit/)
    assert.throws(() => horizon.bindReceipt(plan, "f2", receipt("w1", "pass", "other"), "horizon-worker", "x"), /already produced evidence/)
    assert.throws(() => horizon.recordAudit(plan, "f1", "w1", "horizon-auditor", "accept", "x"), /independent/)
    assert.throws(() => horizon.recordAudit(plan, "f1", "a1", "horizon", "accept", "x"), /horizon-auditor session itself/)
    horizon.recordAudit(plan, "f1", "a1", "horizon-auditor", "accept", "looks right")
    assert.equal(horizon.features(plan)[0].status, "completed")
    assert.throws(() => horizon.bindReceipt(plan, "f1", receipt("w3"), "horizon-worker", "x"), /already completed/)
    assert.throws(() => horizon.bindReceipt(plan, "f2", receipt("w9", "pass", "r-w1-pass"), "horizon-worker", "x"), /already bound/)
  })

  it("never accepts a non-pass receipt and reopens on corrective audits with rotating strategies", () => {
    const plan = planned("sup2")
    horizon.bindReceipt(plan, "f1", receipt("w1", "fail"), "horizon-worker", "")
    assert.throws(() => horizon.recordAudit(plan, "f1", "a1", "horizon-auditor", "accept", "x"), /only pass is passing evidence/)
    horizon.recordAudit(plan, "f1", "a1", "horizon-auditor", "corrective", "fix the test")
    let feature = horizon.features(plan)[0]
    assert.equal(feature.status, "pending")
    assert.equal(horizon.failedAttempts(feature), 1)
    assert.match(horizon.nextStep(plan), /attempt 2, strategy correct/)
    assert.throws(() => horizon.recordAudit(plan, "f1", "a2", "horizon-auditor", "corrective", "x"), /no receipt awaiting audit/)
    horizon.bindReceipt(plan, "f1", receipt("w2", "skipped"), "horizon-worker", "")
    assert.throws(() => horizon.recordAudit(plan, "f1", "a1", "horizon-auditor", "corrective", "x"), /fresh auditor/)
    horizon.recordAudit(plan, "f1", "a2", "horizon-auditor", "corrective", "still wrong")
    feature = horizon.features(plan)[0]
    assert.equal(horizon.failedAttempts(feature), 2)
    assert.match(horizon.nextStep(plan), /strategy replan/)
    assert.equal(horizon.strategyFor(4).strategy, "research")
    assert.equal(horizon.strategyFor(6).strategy, "decompose")
    assert.equal(horizon.strategyFor(8).strategy, "correct")
  })

  it("blocks only with typed concrete evidence and pauses on trusted events", () => {
    const plan = planned("sup3")
    assert.throws(() => horizon.blockFeature(plan, "f1", "permissions", "x".repeat(30)), /blocker kind/)
    assert.throws(() => horizon.blockFeature(plan, "f1", "credentials", "short"), /20 to 4000/)
    horizon.blockFeature(plan, "f1", "credentials", "NPM_TOKEN is not set and publish requires it")
    assert.equal(horizon.features(plan)[0].status, "blocked")
    assert.ok(horizon.needsContinuation(plan))
    assert.match(horizon.nextStep(plan), /f2 API/)
    horizon.unblockFeature(plan, "f1")
    assert.equal(horizon.features(plan)[0].status, "pending")
    horizon.pausePlan(plan, "user-cancelled", "user pressed escape")
    assert.ok(!horizon.needsContinuation(plan))
    horizon.resumePlan(plan, ["permissions"])
    assert.ok(plan.pause)
    horizon.resumePlan(plan, ["user-cancelled"])
    assert.equal(plan.pause, null)
    assert.ok(horizon.needsContinuation(plan))
  })

  it("stops continuation when complete or manual and summarizes", () => {
    const plan = horizon.initPlan("goal", "manual", "sup4", root)
    assert.ok(!horizon.needsContinuation(plan))
    const empty = horizon.initPlan("goal", "full", "sup5", root)
    assert.ok(horizon.needsContinuation(empty))
    assert.match(horizon.nextStep(empty), /horizon_plan write/)
    const done = horizon.writeMilestones(empty, [{ name: "m", features: [{ name: "f", criteria: "c" }] }])
    horizon.bindReceipt(done, "f1", receipt("w1"), "horizon-worker", "")
    horizon.recordAudit(done, "f1", "a1", "horizon-auditor", "accept", "")
    assert.ok(done.completedAt)
    assert.ok(!horizon.needsContinuation(done))
    assert.match(horizon.summarize(done), /1\/1 features complete/)
    assert.match(horizon.summarize(done), /f1 \[completed\] f \(1 attempts\) · receipt r-w1-pas pass · audit accept/)
    assert.throws(() => horizon.writeMilestones(done, [{ name: "m", features: [{ name: "f", criteria: "c" }] }]), /completed plan/)
  })

  it("keeps notes and an exclusive continuation lease", () => {
    const plan = planned("sup6")
    horizon.addNote(plan, { kind: "decision", feature: "f1", text: "use uuid v7" })
    assert.throws(() => horizon.addNote(plan, { kind: "research", feature: "f9", text: "x" }), /not in plan/)
    assert.throws(() => horizon.addNote(plan, { kind: "research", feature: null, text: "  " }), /text/)
    assert.equal(horizon.readNotes(plan)[0].text, "use uuid v7")
    assert.ok(horizon.acquireLease(plan, "a"))
    assert.ok(!horizon.acquireLease(plan, "b"))
    horizon.releaseLease(plan, "b")
    assert.ok(!horizon.acquireLease(plan, "b"))
    horizon.releaseLease(plan, "a")
    assert.ok(horizon.acquireLease(plan, "b"))
  })
})
