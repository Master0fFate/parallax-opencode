import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const paths = vi.hoisted(() => ({
  home: `${process.cwd()}/.tmp-horizon-home-${process.pid}`,
}))

vi.mock("os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("os")>()),
  homedir: () => paths.home,
}))

import { plugin } from "../plugin.js"
import * as horizon from "../horizon.js"

const ROOT = join(tmpdir(), `parallax-horizon-autopilot-${process.pid}`)

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "message-1",
    agent: "horizon",
    directory: ROOT,
    worktree: ROOT,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  } as any
}

function planJson(sessionId: string) {
  return JSON.stringify({
    schemaVersion: "1.1",
    sessionId,
    goal: "Complete one verified feature",
    autonomyLevel: "full",
    status: "executing",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    milestones: [{
      id: "m1",
      name: "Milestone",
      description: "Test milestone",
      status: "in_progress",
      order: 1,
      requiresApproval: false,
      features: [{
        id: "f1",
        name: "Feature",
        description: "Test feature",
        acceptanceCriteria: "Pass",
        protocolLevel: "full",
        status: "pending",
        order: 1,
        subAgentSessionId: null,
        attempts: 0,
        verification: { passed: false, testResults: null, issues: [], score: null },
        skillsRequired: [],
        skillsGenerated: [],
      }],
    }],
    skills: { global: [], sessionScoped: [] },
    stats: { totalFeatures: 1, completedFeatures: 0, failedFeatures: 0, totalRetries: 0, estimatedCost: null },
  })
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(paths.home, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(paths.home, { recursive: true, force: true })
})

describe("Horizon full-autonomy liveness hook", () => {
  it("continues an owned runnable plan, honors cancellation, and rejects cross-session fallback", async () => {
    const promptAsync = vi.fn().mockResolvedValue(undefined)
    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: { promptAsync },
    }
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any)
    const sessionID = "open-code-session"

    await hooks["chat.message"]!(
      { sessionID, agent: "Horizon" },
      { message: {} as any, parts: [{ type: "text", text: "start" } as any] },
    )
    await (hooks as any).tool.horizon_init_session.execute(
      { sessionId: "durable-session", goal: "Complete one verified feature", autonomyLevel: "full" },
      context(sessionID),
    )
    await (hooks as any).tool.horizon_write_plan.execute({
      sessionId: "durable-session",
      planJson: planJson("durable-session"),
    })

    const ownedPlan = horizon.readHorizonPlan("durable-session")!
    expect(ownedPlan).toMatchObject({ openCodeSessionId: sessionID, workspaceRoot: ROOT })

    await expect(hooks["tool.execute.before"]!(
      { tool: "horizon_read_plan", sessionID: "foreign-session", callID: "foreign-call" },
      { args: { sessionId: "durable-session" } },
    )).rejects.toThrow("belongs to another OpenCode session or workspace")
    const forgedBlocker = await (hooks as any).tool.horizon_update_feature.execute({
      sessionId: "durable-session",
      featureId: "f1",
      status: "blocked",
      blockerKind: "permissions",
      blockerEvidence: "Pretend the user denied a permission even though no trusted event exists.",
    })
    expect(forgedBlocker).toContain("only by trusted OpenCode events")

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as any)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0][0]).toMatchObject({
      path: { id: sessionID },
      body: { agent: "horizon", parts: [{ synthetic: true }] },
      throwOnError: true,
    })

    await hooks.event!({
      event: {
        type: "session.error",
        properties: { sessionID, error: { name: "MessageAbortedError", data: { message: "Stopped by user" } } },
      },
    } as any)
    expect(horizon.readHorizonState("durable-session")?.blocker?.kind).toBe("user-cancelled")
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as any)
    expect(promptAsync).toHaveBeenCalledTimes(1)

    await hooks["chat.message"]!(
      { sessionID, agent: "Horizon" },
      { message: {} as any, parts: [{ type: "text", text: "resume" } as any] },
    )
    expect(horizon.readHorizonState("durable-session")?.pausedAt).toBeNull()
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as any)
    expect(promptAsync).toHaveBeenCalledTimes(2)

    await hooks.event!({
      event: { type: "permission.replied", properties: { sessionID, permissionID: "bash-1", response: "reject" } },
    } as any)
    expect(horizon.readHorizonState("durable-session")?.blocker).toMatchObject({
      kind: "permissions",
      source: "permission-event",
    })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as any)
    expect(promptAsync).toHaveBeenCalledTimes(2)
    await hooks.event!({
      event: { type: "permission.replied", properties: { sessionID, permissionID: "bash-1", response: "once" } },
    } as any)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } } as any)
    expect(promptAsync).toHaveBeenCalledTimes(3)

    const otherSession = "unrelated-session"
    await hooks["chat.message"]!(
      { sessionID: otherSession, agent: "Horizon" },
      { message: {} as any, parts: [{ type: "text", text: "other" } as any] },
    )
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: otherSession } } } as any)
    expect(promptAsync).toHaveBeenCalledTimes(3)
  })

  it("uses an exclusive continuation lease and preserves foreign ownership", () => {
    horizon.initHorizonSession("lease-session", "Lease test", "full")
    expect(horizon.acquireHorizonContinuationLease("lease-session", "owner-1")).toBe(true)
    expect(horizon.acquireHorizonContinuationLease("lease-session", "owner-2")).toBe(false)
    horizon.releaseHorizonContinuationLease("lease-session", "owner-2")
    expect(horizon.acquireHorizonContinuationLease("lease-session", "owner-2")).toBe(false)
    horizon.releaseHorizonContinuationLease("lease-session", "owner-1")
    expect(horizon.acquireHorizonContinuationLease("lease-session", "owner-2")).toBe(true)
  })

  it("migrates maxRetryCycles through the public config tool", async () => {
    const client = {
      app: { log: vi.fn().mockResolvedValue(undefined) },
      session: { promptAsync: vi.fn().mockResolvedValue(undefined) },
    }
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any)
    const result = await (hooks as any).tool.horizon_config.execute({
      configJson: JSON.stringify({ maxRetryCycles: 9, autonomyLevel: "semi" }),
    })
    expect(result).toContain("recoveryEscalationInterval: 9")
    expect(horizon.loadHorizonConfig().recoveryEscalationInterval).toBe(9)
    await (hooks as any).tool.horizon_init_session.execute(
      { goal: "Respect configured autonomy" },
      context("configured-session"),
    )
    expect(horizon.readHorizonPlan("configured-session")?.autonomyLevel).toBe("semi")
    await (hooks as any).tool.horizon_write_plan.execute({
      sessionId: "configured-session",
      planJson: planJson("configured-session"),
    })
    expect(horizon.readHorizonPlan("configured-session")?.autonomyLevel).toBe("semi")
  })
})
