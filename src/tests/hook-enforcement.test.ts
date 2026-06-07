/**
 * Integration tests for actual plugin hook enforcement behavior.
 *
 * These tests exercise the REAL plugin hooks (tool.execute.before, system.transform)
 * by importing the plugin and calling its hooks directly. This validates that
 * cross-context state synchronization works correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// We test the plugin's hook behavior by simulating the hooks directly.
// The plugin exports a factory function that returns hooks + tools.

const TEST_DIR = join(tmpdir(), "parallax-hook-test-" + Date.now())
const STATE_FILE = join(TEST_DIR, ".parallax", "state.json")

// Minimal mock of the OpenCode client
function createMockClient() {
  return {
    app: {
      log: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe("Hook Enforcement Integration", () => {
  let originalCwd: string

  beforeEach(() => {
    originalCwd = process.cwd()
    // Create test directory structure
    mkdirSync(join(TEST_DIR, ".parallax"), { recursive: true })
    // Change to test directory so relative paths work
    process.chdir(TEST_DIR)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    // Clean up
    try {
      rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {}
  })

  describe("syncStateFromDisk behavior", () => {
    it("should sync protocol state from disk to in-memory stores", async () => {
      // Write a state file with ambiguityDone: true
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: true,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      // Import the plugin factory and create an instance
      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // Simulate system.transform hook which reads state
      const output: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({}, output)

      // The system prompt should contain the actual protocol status
      const systemPrompt = (output.system || []).join("\n")
      expect(systemPrompt).toContain("[DONE] Step: Ambiguity Check")
      expect(systemPrompt).toContain("[PENDING] Step: 4 Invariants")
    })

    it("should sync mode from disk to in-memory stores", async () => {
      // Write a state file with mode: "horizon"
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "horizon",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: true,
          invariantsDone: true,
          gateDone: true,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      const output: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({}, output)

      const systemPrompt = (output.system || []).join("\n")
      // Should show HORIZON MODE since mode is horizon
      expect(systemPrompt).toContain("HORIZON MODE")
    })

    it("should show all PENDING when state file has all steps pending", async () => {
      // Write state with all steps pending (realistic scenario)
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: false,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      const output: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({}, output)

      const systemPrompt = (output.system || []).join("\n")
      expect(systemPrompt).toContain("[PENDING] Step: Ambiguity Check")
      expect(systemPrompt).toContain("[PENDING] Step: 4 Invariants")
      expect(systemPrompt).toContain("[PENDING] Step: Verification Gate")
    })
  })

  describe("tool.execute.before enforcement", () => {
    it("should block writes when ambiguity check is not done", async () => {
      // Write state with all steps pending
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: false,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // Attempt a write without ambiguity checkin
      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "write",
          args: { filePath: "test.ts" },
        })
      ).rejects.toThrow("Ambiguity Check")
    })

    it("should block writes until invariants and gate are complete in strict mode", async () => {
      // Write state with ambiguity done only
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: true,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "write",
          args: { filePath: "test.ts" },
        })
      ).rejects.toThrow("strict mode")
    })

    it("should allow writes after ambiguity, invariants, and gate checkins", async () => {
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: true,
          invariantsDone: true,
          gateDone: true,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "write",
          args: { filePath: "test.ts" },
        })
      ).resolves.toBeUndefined()
    })

    it("should exempt Horizon writes to .parallax/horizon/", async () => {
      // Write state with all steps pending (would normally block)
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "horizon",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: false,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      await (hooks as any).event({
        event: { type: "session.next.agent.switched", properties: { agent: "Horizon" } },
      })

      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "write",
          args: { filePath: ".parallax/horizon/sessions/test/plan.json" },
        })
      ).resolves.toBeUndefined()
    })

    it("should not exempt traversal paths that merely contain .parallax/horizon", async () => {
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "horizon",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: false,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)
      await (hooks as any).event({
        event: { type: "session.next.agent.switched", properties: { agent: "horizon" } },
      })

      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "write",
          args: { filePath: "outside/.parallax/horizon/../../escape.json" },
        })
      ).rejects.toThrow("PROTOCOL VIOLATION")
    })

    it("should not block non-write tools", async () => {
      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // read, grep, glob should pass through
      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "read",
          args: { filePath: "test.ts" },
        })
      ).resolves.toBeUndefined()

      await expect(
        (hooks as any)["tool.execute.before"]({
          tool: "grep",
          args: { pattern: "test" },
        })
      ).resolves.toBeUndefined()
    })
  })

  describe("Agent name normalization", () => {
    it("should handle case-insensitive agent names in system prompt", async () => {
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: false,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // Simulate session.created event with capitalized agent name
      await (hooks as any).event({
        event: {
          type: "session.created",
          properties: {
            info: { id: "test-session", agent: "Horizon" },
          },
        },
      })

      // Now system.transform should show the agent context
      const output: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({}, output)

      const systemPrompt = (output.system || []).join("\n")
      // Should show agent context with normalized name
      expect(systemPrompt).toContain("PARALLAX AGENT CONTEXT")
    })
  })

  describe("Cross-context state sync (Rec-2)", () => {
    it("should persist checkin changes to disk via flushState", async () => {
      // Start with empty state
      const initialState = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: false,
          invariantsDone: false,
          gateDone: false,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // Call parallax_checkin tool to mark ambiguity done
      const checkinResult = await (hooks as any).tool.parallax_checkin.execute({
        step: "ambiguity",
      })
      expect(checkinResult).toContain("Step 1/6")

      // flushState is called by writeState(true) which is called by checkin
      // Read the state file to verify it was persisted
      const persistedState = JSON.parse(readFileSync(STATE_FILE, "utf8"))
      expect(persistedState.protocol.ambiguityDone).toBe(true)
      expect(persistedState.protocol.invariantsDone).toBe(false)
    })

    it("should reflect disk state in system.prompt after tool context writes", async () => {
      // Start with ambiguity done on disk
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 0, trials: 0, retriesLeft: 3, lastObservation: null },
        protocol: {
          ambiguityDone: true,
          invariantsDone: true,
          gateDone: true,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // system.transform should show DONE for steps 1-3
      const output: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({}, output)

      const systemPrompt = (output.system || []).join("\n")
      expect(systemPrompt).toContain("[DONE] Step: Ambiguity Check")
      expect(systemPrompt).toContain("[DONE] Step: 4 Invariants")
      expect(systemPrompt).toContain("[DONE] Step: Verification Gate")
      expect(systemPrompt).toContain("[PENDING] Step: Design Doc")
    })

    it("should preserve friction state across hook calls", async () => {
      const state = {
        sessionId: "current",
        sessionStart: new Date().toISOString(),
        mode: "free",
        friction: { successes: 5, trials: 10, retriesLeft: 2, lastObservation: "test error" },
        protocol: {
          ambiguityDone: true,
          invariantsDone: true,
          gateDone: true,
          designDone: false,
          commitDone: false,
          summaryDone: false,
          writesBeforeGate: 0,
          gateBlocked: false,
        },
      }
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")

      const { plugin } = await import("../plugin.js")
      const client = createMockClient()
      const hooks = await plugin({ client } as any)

      // system.transform should show friction state
      const output: { system?: string[] } = {}
      await (hooks as any)["experimental.chat.system.transform"]({}, output)

      const systemPrompt = (output.system || []).join("\n")
      expect(systemPrompt).toContain("2 retries remaining")
      expect(systemPrompt).toContain("test error")
    })
  })
})
