import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
}))

import { spawnSync } from "node:child_process"
import { plugin } from "../plugin.js"
import { getTrace } from "../trace.js"
import { computeCoherenceScore } from "../score.js"
import {
  claimVerificationChanges,
  completeVerificationClaim,
  queueVerificationChanges,
  readVerificationLedger,
  restoreVerificationClaim,
} from "../verification.js"

const ROOT = join(tmpdir(), `parallax-verification-${process.pid}`)
const client = { app: { log: vi.fn().mockResolvedValue(undefined) } }

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "m",
    agent: "parallax",
    directory: ROOT,
    worktree: ROOT,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  } as any
}

async function ready(hooks: any, sid: string): Promise<void> {
  for (const step of ["ambiguity", "invariants", "gate"]) {
    await hooks.tool.parallax_checkin.execute({ step }, context(sid))
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(join(ROOT, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(ROOT, { recursive: true, force: true })
})

describe("schema-v2 verified change loop", () => {
  it("attributes every rapid write to one automatic receipt", async () => {
    const sid = "batch-session"
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any) as any
    await ready(hooks, sid)

    await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "1", args: { filePath: "src/a.ts" } })
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: sid, callID: "2", args: { path: "src/b.ts" } })
    await hooks["tool.execute.after"]({
      tool: "apply_patch",
      sessionID: sid,
      callID: "3",
      args: { patchText: "*** Update File: src/c.ts\n*** Add File: src/d.ts\n" },
    })
    vi.advanceTimersByTime(1000)

    const receipt = getTrace(sid).verificationLedger.receipts.at(-1)!
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      source: "automatic",
      verdict: "pass",
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
    })
    expect(getTrace(sid).writes.slice(-4).map((write) => write.receiptId)).toEqual([
      receipt.id,
      receipt.id,
      receipt.id,
      receipt.id,
    ])
    expect(readVerificationLedger(ROOT).receipts.at(-1)?.id).toBe(receipt.id)
  })

  it("recovers disk-backed batches shared across OpenCode contexts", () => {
    queueVerificationChanges(ROOT, "durable-session", ["b.ts", "a.ts", "a.ts"])
    const first = claimVerificationChanges(ROOT, "durable-session")!
    expect(first.changedFiles).toEqual(["a.ts", "b.ts"])

    queueVerificationChanges(ROOT, "durable-session", ["c.ts"])
    completeVerificationClaim(first)
    const second = claimVerificationChanges(ROOT, "durable-session")!
    expect(second.changedFiles).toEqual(["c.ts"])

    restoreVerificationClaim(ROOT, "durable-session", second)
    const recovered = claimVerificationChanges(ROOT, "durable-session")!
    expect(recovered.changedFiles).toEqual(["c.ts"])
    completeVerificationClaim(recovered)
  })

  it("manual verification consumes the same batch and writes an equivalent record", async () => {
    const sid = "manual-session"
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any) as any
    await ready(hooks, sid)
    await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "1", args: { filePath: "a.ts" } })
    await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "2", args: { filePath: "b.ts" } })

    await hooks.tool.parallax_verify.execute({}, context(sid))
    vi.advanceTimersByTime(1000)

    const receipts = getTrace(sid).verificationLedger.receipts
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ source: "manual", changedFiles: ["a.ts", "b.ts"] })
    const autoShape = Object.keys({ ...receipts[0], source: "automatic" }).sort()
    expect(Object.keys(receipts[0]).sort()).toEqual(autoShape)
  })

  it("does not represent skipped verification as passing confidence", async () => {
    const sid = "skip-session"
    rmSync(join(ROOT, "package.json"))
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any) as any
    await hooks.tool.parallax_verify.execute({}, context(sid))

    const trace = getTrace(sid)
    expect(trace.verificationLedger.receipts.at(-1)?.verdict).toBe("skipped")
    expect(computeCoherenceScore(trace).verificationIntegrity).toBe(0)
  })

  it("allows a repair after failure and restores health on the later pass", async () => {
    const sid = "repair-session"
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "broken" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "healthy", stderr: "" } as never)
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any) as any
    await ready(hooks, sid)

    await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "1", args: { filePath: "broken.ts" } })
    vi.advanceTimersByTime(1000)
    let state = JSON.parse(readFileSync(join(ROOT, ".parallax", "sessions", sid, "state.json"), "utf8"))
    expect(state.friction).toMatchObject({ retriesLeft: 2, lastObservation: "broken" })

    await expect(hooks["tool.execute.before"](
      { tool: "edit", sessionID: sid, callID: "2" },
      { args: { filePath: "broken.ts" } },
    )).resolves.toBeUndefined()
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: sid, callID: "2", args: { filePath: "broken.ts" } })
    vi.advanceTimersByTime(1000)

    state = JSON.parse(readFileSync(join(ROOT, ".parallax", "sessions", sid, "state.json"), "utf8"))
    expect(state.friction).toMatchObject({ retriesLeft: 3, lastObservation: null, successes: 1, trials: 2 })
    expect(getTrace(sid).verificationLedger.receipts.slice(-2).map((r) => r.verdict)).toEqual(["fail", "pass"])
  })
})
