import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir, tmpdir } from "os"

import type { Hooks } from "@opencode-ai/plugin"
import { plugin } from "../plugin.js"
import { cleanupTrace, exportTrace, getTrace, initTrace, loadTrace } from "../trace.js"

const ROOT = join(tmpdir(), `parallax-runtime-${process.pid}`)

const client = {
  app: { log: vi.fn().mockResolvedValue(undefined) },
}

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "message-1",
    agent: "parallax",
    directory: ROOT,
    worktree: ROOT,
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  } as any
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe("session-safe runtime kernel", () => {
  it("isolates versioned state by OpenCode session and uses the mutable hook output contract", async () => {
    const launcherRoot = join(ROOT, "plugin-launcher")
    const hooks = await plugin({ client, directory: launcherRoot, worktree: launcherRoot } as any)

    // ToolContext is authoritative even when later hooks omit a directory.
    await (hooks as any).tool.parallax_checkin.execute({ step: "ambiguity" }, context("session-a"))

    const aPath = join(ROOT, ".parallax", "sessions", "session-a", "state.json")
    const bPath = join(ROOT, ".parallax", "sessions", "session-b", "state.json")
    expect(JSON.parse(readFileSync(aPath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      sessionId: "session-a",
      protocol: { ambiguityDone: true },
    })
    expect(existsSync(bPath)).toBe(false)

    // Keep this typed against OpenCode's production hook interface: mutable
    // tool arguments are supplied on output.args, not on the input object.
    const executeBefore: NonNullable<Hooks["tool.execute.before"]> =
      hooks["tool.execute.before"]!
    await expect(executeBefore(
      { tool: "write", sessionID: "session-b", callID: "call-1" },
      { args: { filePath: "src/new.ts" } },
    )).rejects.toThrow("Ambiguity Check")

    await (hooks as any).tool.parallax_checkin.execute({ step: "ambiguity" }, context("session-b"))
    await (hooks as any).tool.parallax_checkin.execute({ step: "invariants" }, context("session-b"))
    expect(JSON.parse(readFileSync(aPath, "utf8")).protocol.invariantsDone).toBe(false)
    expect(JSON.parse(readFileSync(bPath, "utf8")).protocol.invariantsDone).toBe(true)

    const output = { system: [] as string[] }
    await (hooks as any)["experimental.chat.system.transform"](
      { sessionID: "session-a", model: {} },
      output,
    )
    expect(output.system.join("\n")).toContain("[DONE] Step: Ambiguity Check")
  })

  it("tracks the active agent from OpenCode chat context for Horizon write isolation", async () => {
    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any)
    await hooks["chat.message"]!({ sessionID: "horizon-session", agent: "Horizon" }, {
      message: {} as any,
      parts: [],
    })

    const executeBefore: NonNullable<Hooks["tool.execute.before"]> =
      hooks["tool.execute.before"]!
    await expect(executeBefore(
      { tool: "write", sessionID: "horizon-session", callID: "call-h" },
      {
        args: {
          filePath: join(homedir(), ".parallax", "horizon", "sessions", "safe", "plan.json"),
        },
      },
    )).resolves.toBeUndefined()
  })

  it("atomically claims legacy current state for only one real session", async () => {
    const legacyPath = join(ROOT, ".parallax", "state.json")
    mkdirSync(join(ROOT, ".parallax"), { recursive: true })
    const legacy = {
      sessionId: "current",
      mode: "debug",
      friction: { successes: 1, trials: 2, retriesLeft: 2, lastObservation: null },
      protocol: { ambiguityDone: true },
    }
    writeFileSync(legacyPath, JSON.stringify(legacy), "utf8")
    const original = readFileSync(legacyPath, "utf8")

    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any)
    const output = { system: [] as string[] }
    await (hooks as any)["experimental.chat.system.transform"](
      { sessionID: "migrated-session", model: {} },
      output,
    )

    const migrated = JSON.parse(readFileSync(
      join(ROOT, ".parallax", "sessions", "migrated-session", "state.json"),
      "utf8",
    ))
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.sessionId).toBe("migrated-session")
    expect(existsSync(legacyPath)).toBe(false)
    expect(readFileSync(`${legacyPath}.migrated`, "utf8")).toBe(original)

    await (hooks as any)["experimental.chat.system.transform"](
      { sessionID: "unrelated-session", model: {} },
      { system: [] },
    )
    expect(existsSync(join(ROOT, ".parallax", "sessions", "unrelated-session", "state.json"))).toBe(false)
  })

  it("hydrates a resumed trace through the real plugin tool lifecycle before export", async () => {
    getTrace("resumed-session").phases.push({ phase: "summary", timestamp: "persisted", data: {} })
    exportTrace("resumed-session", false, ROOT)
    cleanupTrace("resumed-session")

    const hooks = await plugin({ client, directory: ROOT, worktree: ROOT } as any)
    const result = await (hooks as any).tool.parallax_trace_export.execute(
      { pretty: true },
      context("resumed-session"),
    )
    expect(result).toContain("Phases: 1")
    expect(loadTrace("resumed-session", ROOT)?.phases[0]?.timestamp).toBe("persisted")
  })

  it("writes session traces atomically under the supplied worktree and rejects traversal IDs", () => {
    getTrace("trace-session").phases.length = 0
    const path = exportTrace("trace-session", true, ROOT)
    expect(path).toBe(join(ROOT, ".parallax", "traces", "trace-session.json"))
    expect(loadTrace("trace-session", ROOT)?.session.id).toBe("trace-session")
    exportTrace("other-session", false, ROOT)
    expect(loadTrace("trace-session", ROOT)?.session.id).toBe("trace-session")

    getTrace("trace-session").phases.push({ phase: "summary", timestamp: "later", data: {} })
    exportTrace("trace-session", false, ROOT)
    cleanupTrace("trace-session")
    initTrace("trace-session", ROOT, null)
    expect(getTrace("trace-session").phases.map((phase) => phase.timestamp)).toContain("later")
    expect(loadTrace("other-session", ROOT)?.session.id).toBe("other-session")
    expect(() => exportTrace("../escape", false, ROOT)).toThrow("Invalid trace session ID")
    expect(existsSync(join(ROOT, "escape.json"))).toBe(false)
  })
})
