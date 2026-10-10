import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { SKILLS_DIR } from "../agents.js"
import { loadSession } from "../session.js"
import { readReceipts } from "../verify.js"
import { FAIL, PASS, call, ctx, edit, event, fakeClient, load, message, project, receiptId, remove, system, tempDir } from "./helpers.js"

const home = tempDir("parallax-plugin-home")
const root = tempDir("parallax-plugin-root")
before(() => {
  process.env.PARALLAX_HOME = home
  project(root, PASS)
})
after(() => {
  remove(home)
  remove(root)
})

describe("config hook", () => {
  it("injects packaged agents and skills while preserving user overrides", async () => {
    const hooks = await load(root, fakeClient().client)
    const config = { agent: { horizon: { model: "p/m", permission: { bash: "allow" } } } } as Record<string, any>
    await hooks.config!(config as never)
    assert.deepEqual(Object.keys(config.agent).sort(), ["horizon", "horizon-auditor", "horizon-worker", "parallax"])
    assert.equal(config.agent.horizon.model, "p/m")
    assert.equal(config.agent.horizon.permission.bash, "allow")
    assert.equal(config.agent.horizon.permission.edit, "deny")
    assert.deepEqual(config.agent.horizon.permission.task, { "*": "deny", "horizon-worker": "allow", "horizon-auditor": "allow" })
    assert.match(config.agent.parallax.prompt, /parallax_preflight/)
    assert.equal(config.agent["horizon-auditor"].mode, "subagent")
    assert.deepEqual(config.skills.paths, [SKILLS_DIR])
    await hooks.config!(config as never)
    assert.deepEqual(config.skills.paths, [SKILLS_DIR])
  })
})

describe("verified change loop", () => {
  it("gates edits for Parallax agents only, until a preflight is recorded", async () => {
    const hooks = await load(root, fakeClient().client)
    await message(hooks, "other", "build")
    await edit(hooks, "other", "src/free.ts")
    assert.deepEqual(loadSession(root, "other").pending, [])
    await message(hooks, "p1", "Parallax")
    assert.equal(loadSession(root, "p1").agent, "parallax")
    await assert.rejects(edit(hooks, "p1", "src/a.ts"), /parallax_preflight/)
    assert.match(await system(hooks, "p1"), /Preflight pending/)
    assert.equal(await system(hooks, "other"), "")
    const out = await call(hooks, "parallax_preflight", { ambiguity: "low", criteria: "adds x", invariants: "none" }, ctx("p1", "parallax", root))
    assert.match(out, /unlocked/)
    await edit(hooks, "p1", "src/a.ts")
    await edit(hooks, "p1", "src/a.ts")
    await edit(hooks, "p1", "src/b.ts")
    assert.deepEqual(loadSession(root, "p1").pending, ["src/a.ts", "src/b.ts"])
    assert.match(await system(hooks, "p1"), /Unverified edits: 2 file/)
  })

  it("refuses to close with unverified edits, then verifies and closes with evidence", async () => {
    const hooks = await load(root, fakeClient().client)
    const context = ctx("p2", "parallax", root)
    await message(hooks, "p2", "parallax")
    await call(hooks, "parallax_preflight", { ambiguity: "medium", criteria: "c", invariants: "i" }, context)
    await edit(hooks, "p2", "src/x.ts")
    assert.match(await call(hooks, "parallax_receipt", { decision: "full", summary: "s" }, context), /1 unverified file/)
    const verified = await call(hooks, "parallax_verify", {}, context)
    assert.match(verified, /^\[parallax\] PASS · receipt/)
    const id = receiptId(verified)
    const session = loadSession(root, "p2")
    assert.deepEqual(session.pending, [])
    assert.deepEqual(session.receipts, [id])
    assert.deepEqual(readReceipts(root, "p2")[0].files, ["src/x.ts"])
    const closed = await call(hooks, "parallax_receipt", { decision: "full", summary: "shipped" }, context)
    assert.match(closed, /### Decision: full/)
    assert.match(closed, /pass · /)
    assert.match(await call(hooks, "parallax_trace", {}, context), /Criteria: c/)
    await edit(hooks, "p2", "src/y.ts")
    assert.equal(loadSession(root, "p2").closed, null)
  })

  it("surfaces failures in the system prompt and blocks a full decision after a failed check", async () => {
    const failing = tempDir("parallax-plugin-fail")
    try {
      project(failing, FAIL)
      const hooks = await load(failing, fakeClient().client)
      const context = ctx("p3", "parallax", failing)
      await message(hooks, "p3", "parallax")
      await call(hooks, "parallax_preflight", { ambiguity: "low", criteria: "c", invariants: "i" }, context)
      await edit(hooks, "p3", "src/x.ts")
      const result = await call(hooks, "parallax_verify", {}, context)
      assert.match(result, /FAIL/)
      assert.match(result, /boom/)
      assert.match(await system(hooks, "p3"), /Last check failed/)
      assert.match(await call(hooks, "parallax_receipt", { decision: "full", summary: "s" }, context), /needs a passing receipt/)
      assert.match(await call(hooks, "parallax_receipt", { decision: "partial", summary: "gaps" }, context), /Decision: partial/)
      const compact = { context: [] as string[] }
      await hooks["experimental.session.compacting"]!({ sessionID: "p3" }, compact)
      assert.match(compact.context[0], /Preflight done/)
    } finally {
      remove(failing)
    }
  })

  it("honors trivial patterns and relaxed strictness", async () => {
    const relaxed = tempDir("parallax-plugin-relaxed")
    try {
      project(relaxed)
      mkdirSync(join(relaxed, ".parallax"))
      writeFileSync(join(relaxed, ".parallax", "config.json"), '{"trivialPatterns":["*.md"]}')
      const hooks = await load(relaxed, fakeClient().client)
      await message(hooks, "p4", "parallax")
      await edit(hooks, "p4", "docs/notes.md")
      await assert.rejects(edit(hooks, "p4", "src/a.ts"), /parallax_preflight/)
      writeFileSync(join(relaxed, ".parallax", "config.json"), '{"strictness":"relaxed"}')
      await edit(hooks, "p4", "src/a.ts")
      assert.match(await call(hooks, "parallax_receipt", { decision: "hold", summary: "waiting" }, ctx("p4", "parallax", relaxed)), /Decision: hold/)
      writeFileSync(join(relaxed, ".parallax", "config.json"), '{"nope":1}')
      await assert.rejects(edit(hooks, "p4", "src/b.ts"), /unknown field/)
      assert.match(await system(hooks, "p4"), /Config error/)
      assert.match(await call(hooks, "parallax_verify", {}, ctx("p4", "parallax", relaxed)), /unknown field/)
    } finally {
      remove(relaxed)
    }
  })

  it("tracks apply_patch files and skips edits without a path", async () => {
    const hooks = await load(root, fakeClient().client)
    await message(hooks, "p5", "parallax")
    await call(hooks, "parallax_preflight", { ambiguity: "low", criteria: "c", invariants: "i" }, ctx("p5", "parallax", root))
    const patch = "*** Begin Patch\n*** Update File: src/one.ts\n+x\n*** Add File: src/two.ts\n+y\n*** End Patch"
    await hooks["tool.execute.after"]!({ tool: "apply_patch", sessionID: "p5", callID: "c", args: { patchText: patch } }, { title: "", output: "", metadata: {} })
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "p5", callID: "c", args: {} }, { title: "", output: "", metadata: {} })
    assert.deepEqual(loadSession(root, "p5").pending, ["src/one.ts", "src/two.ts"])
  })
})

describe("horizon supervision", () => {
  it("runs the worker, receipt, auditor pipeline through the tools and completes the plan", async () => {
    const fake = fakeClient()
    const hooks = await load(root, fake.client)
    const sup = ctx("h1", "horizon", root)
    await message(hooks, "h1", "horizon")
    assert.match(await call(hooks, "horizon_plan", { action: "list" }, sup), /no plans/)
    assert.match(await call(hooks, "horizon_plan", { action: "init", goal: "Deliver feature" }, sup), /created/)
    assert.match(await call(hooks, "horizon_plan", { action: "init", goal: "again" }, sup), /already owns/)
    const written = await call(hooks, "horizon_plan", { action: "write", milestones: [{ name: "M", features: [{ name: "Thing", criteria: "works" }] }] }, sup)
    assert.match(written, /f1 \[pending\] Thing/)
    assert.match(await system(hooks, "h1"), /Horizon plan .*dispatch one horizon-worker \(attempt 1, strategy correct\)/)

    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "h1", callID: "t" }, { args: {} })
    await assert.rejects(hooks["tool.execute.before"]!({ tool: "task", sessionID: "h1", callID: "t" }, { args: {} }), /one delegated task/)
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "h1", callID: "t", args: {} }, { title: "", output: "", metadata: {} })
    await hooks["tool.execute.before"]!({ tool: "task", sessionID: "h1", callID: "t" }, { args: {} })
    await hooks["tool.execute.after"]!({ tool: "task", sessionID: "h1", callID: "t", args: {} }, { title: "", output: "", metadata: {} })

    const worker = ctx("w1", "horizon-worker", root)
    fake.parents.set("w1", "h1")
    await message(hooks, "w1", "horizon-worker")
    await call(hooks, "parallax_preflight", { ambiguity: "low", criteria: "works", invariants: "i" }, worker)
    await edit(hooks, "w1", "src/thing.ts")
    const id = receiptId(await call(hooks, "parallax_verify", {}, worker))
    assert.match(await call(hooks, "horizon_feature", { action: "receipt", id: "f1", receipt: "nope" }, sup), /not in this workspace's ledger/)
    assert.match(await call(hooks, "horizon_feature", { action: "receipt", id: "f1", receipt: id.slice(0, 8), summary: "done" }, sup), /bound to f1.*Dispatch one horizon-auditor/)
    assert.match(await call(hooks, "horizon_feature", { action: "audit", id: "f1", verdict: "accept", summary: "x" }, sup), /only the horizon-auditor/)

    const auditor = ctx("a1", "horizon-auditor", root)
    fake.parents.set("a1", "h1")
    await message(hooks, "a1", "horizon-auditor")
    assert.match(await call(hooks, "horizon_plan", { action: "read" }, auditor), /f1 \[review\]/)
    assert.match(await call(hooks, "horizon_feature", { action: "receipt", id: "f1", receipt: id }, auditor), /only the horizon agent/)
    assert.match(await call(hooks, "horizon_feature", { action: "audit", id: "f1", verdict: "accept", summary: "criteria met" }, auditor), /status completed/)
    assert.match(await call(hooks, "horizon_note", { action: "add", kind: "decision", feature: "f1", text: "kept it simple" }, sup), /noted/)
    assert.match(await call(hooks, "horizon_note", { action: "list" }, sup), /decision f1: kept it simple/)
    const summary = await call(hooks, "horizon_plan", { action: "read" }, sup)
    assert.match(summary, /1\/1 features complete/)
    assert.match(summary, /Notes: 1/)
    await event(hooks, "session.idle", { sessionID: "h1" })
    assert.equal(fake.prompts.length, 0)
  })

  it("re-prompts owned runnable plans on idle and pauses on cancellation and denied permissions", async () => {
    const fake = fakeClient()
    const hooks = await load(root, fake.client)
    const sup = ctx("h2", "horizon", root)
    await message(hooks, "h2", "horizon")
    await call(hooks, "horizon_plan", { action: "init", goal: "Long goal" }, sup)
    await call(hooks, "horizon_plan", { action: "write", milestones: [{ name: "M", features: [{ name: "A", criteria: "a" }] }] }, sup)
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 1)
    const body = fake.prompts[0].body as { agent: string; parts: Array<{ synthetic: boolean; text: string }> }
    assert.equal(body.agent, "horizon")
    assert.equal(body.parts[0].synthetic, true)
    assert.match(body.parts[0].text, /horizon autopilot/)
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 2)

    await event(hooks, "session.error", { sessionID: "h2", error: { name: "MessageAbortedError", data: { message: "aborted" } } })
    assert.match(await call(hooks, "horizon_plan", { action: "read" }, sup), /paused \(user-cancelled\)/)
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 2)
    await message(hooks, "h2", "horizon", true)
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 2)
    await message(hooks, "h2", "horizon")
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 3)

    fake.parents.set("w2", "h2")
    await event(hooks, "permission.replied", { sessionID: "w2", permissionID: "perm-1", response: "reject" })
    assert.match(await call(hooks, "horizon_plan", { action: "read" }, sup), /paused \(permissions\): OpenCode permission perm-1/)
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 3)
    await event(hooks, "permission.replied", { sessionID: "w2", permissionID: "perm-1", response: "once" })
    await event(hooks, "session.idle", { sessionID: "h2" })
    assert.equal(fake.prompts.length, 4)

    await message(hooks, "stranger", "parallax")
    await event(hooks, "session.idle", { sessionID: "stranger" })
    assert.equal(fake.prompts.length, 4)
  })

  it("keeps manual plans quiet and adopts a workspace plan on read", async () => {
    const fake = fakeClient()
    const hooks = await load(root, fake.client)
    const first = ctx("h3", "horizon", root)
    await message(hooks, "h3", "horizon")
    const created = await call(hooks, "horizon_plan", { action: "init", goal: "Manual goal", autonomy: "manual" }, first)
    const id = created.match(/plan (\w+) created/)![1]
    await event(hooks, "session.idle", { sessionID: "h3" })
    assert.equal(fake.prompts.length, 0)
    const second = ctx("h4", "horizon", root)
    await message(hooks, "h4", "horizon")
    assert.match(await call(hooks, "horizon_plan", { action: "read" }, second), /owns no Horizon plan/)
    assert.match(await call(hooks, "horizon_plan", { action: "read", id }, second), /Manual goal/)
    assert.match(await call(hooks, "horizon_plan", { action: "list" }, second), new RegExp(`${id} · active · 0/0 .* owned by this session`))
    assert.match(await call(hooks, "horizon_plan", { action: "read", id: "missing" }, second), /not found/)
    assert.match(await call(hooks, "horizon_feature", { action: "block", id: "f1", kind: "platform", evidence: "x".repeat(30) }, second), /not in plan/)
  })
})

describe("autopilot stall guard", () => {
  it("pauses a plan after repeated continuations without progress and resumes on a real message", async () => {
    const fake = fakeClient()
    const hooks = await load(root, fake.client)
    const sup = ctx("h5", "horizon", root)
    await message(hooks, "h5", "horizon")
    await call(hooks, "horizon_plan", { action: "init", goal: "Stalling goal" }, sup)
    for (let i = 0; i < 6; i++) await event(hooks, "session.idle", { sessionID: "h5" })
    assert.equal(fake.prompts.length, 6)
    await event(hooks, "session.idle", { sessionID: "h5" })
    assert.equal(fake.prompts.length, 6)
    assert.match(await call(hooks, "horizon_plan", { action: "read" }, sup), /paused \(structural\): autopilot re-prompted 6 times/)
    await message(hooks, "h5", "horizon")
    await event(hooks, "session.idle", { sessionID: "h5" })
    assert.equal(fake.prompts.length, 7)
    await call(hooks, "horizon_plan", { action: "write", milestones: [{ name: "M", features: [{ name: "A", criteria: "a" }] }] }, sup)
    for (let i = 0; i < 7; i++) await event(hooks, "session.idle", { sessionID: "h5" })
    assert.equal(fake.prompts.length, 13)
  })
})
