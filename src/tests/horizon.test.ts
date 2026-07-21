/**
 * Tests for Horizon agent persistence module.
 *
 * Tests session initialization, plan/state/decision read/write,
 * feature updates with stat recalculation, milestone updates,
 * skill management, trace archiving, and session listing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renameSync, writeFileSync } from "fs"

// In-memory mock filesystem
const mockFs: { exists: Record<string, boolean>; files: Record<string, string> } = {
  exists: {},
  files: {},
}
vi.mock("fs", () => {
  // Normalize path separators for in-memory lookup consistency
  const norm = (p: string) => p.replace(/\\/g, "/")

  return {
    existsSync: vi.fn((p: string) => mockFs.exists[norm(p)] === true),
    mkdirSync: vi.fn((p: string, opts?: any) => {
      const key = norm(p)
      mockFs.exists[key] = true
      // Simulate { recursive: true } by creating all parent directories
      if (opts?.recursive) {
        const parts = key.split("/")
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/")
          if (parent) mockFs.exists[parent] = true
        }
      }
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      const key = norm(p)
      mockFs.files[key] = data
      mockFs.exists[key] = true
    }),
    readFileSync: vi.fn((p: string) => {
      const key = norm(p)
      if (mockFs.files[key] !== undefined) return mockFs.files[key]
      throw new Error(`File not found: ${key}`)
    }),
    readdirSync: vi.fn((p: string) => {
      const dir = norm(p)
      const prefix = dir.endsWith("/") ? dir : dir + "/"
      return Object.keys(mockFs.exists)
        .filter((k) => k.startsWith(prefix) && k !== prefix)
        .map((k) => k.slice(prefix.length).split("/")[0])
        .filter((v, i, a) => a.indexOf(v) === i)
    }),
    appendFileSync: vi.fn((p: string, data: string) => {
      const key = norm(p)
      mockFs.files[key] = (mockFs.files[key] || "") + data
      mockFs.exists[key] = true
    }),
    renameSync: vi.fn((src: string, dst: string) => {
      const srcKey = norm(src)
      const dstKey = norm(dst)
      mockFs.files[dstKey] = mockFs.files[srcKey] || ""
      mockFs.exists[dstKey] = true
      delete mockFs.files[srcKey]
      delete mockFs.exists[srcKey]
    }),
  }
})

vi.mock("os", () => ({
  homedir: () => "/mock-home",
}))

import * as horizon from "../horizon"
import type {
  HorizonPlan,
  HorizonFeature,
  HorizonMilestone,
  HorizonState,
  HorizonDecision,
  VerificationReceipt,
} from "../types"

beforeEach(() => {
  mockFs.exists = {}
  mockFs.files = {}
})

function makeSamplePlan(sessionId: string): HorizonPlan {
  return {
    schemaVersion: "1.0",
    sessionId,
    goal: "Test goal",
    autonomyLevel: "full",
    status: "executing",
    createdAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    milestones: [
      {
        id: "m1",
        name: "Milestone One",
        description: "First milestone",
        status: "in_progress",
        order: 1,
        requiresApproval: false,
        features: [
          {
            id: "f1",
            name: "Feature One",
            description: "First feature",
            acceptanceCriteria: "It works",
            protocolLevel: "full",
            status: "in_progress",
            order: 1,
            subAgentSessionId: null,
            attempts: 1,
            maxAttempts: 3,
            verification: { passed: false, testResults: null, issues: [], score: null },
            skillsRequired: [],
            skillsGenerated: [],
          },
          {
            id: "f2",
            name: "Feature Two",
            description: "Second feature",
            acceptanceCriteria: "It also works",
            protocolLevel: "full",
            status: "pending",
            order: 2,
            subAgentSessionId: null,
            attempts: 0,
            maxAttempts: 3,
            verification: { passed: false, testResults: null, issues: [], score: null },
            skillsRequired: [],
            skillsGenerated: [],
          },
        ],
      },
    ],
    skills: { global: [], sessionScoped: [] },
    stats: { totalFeatures: 2, completedFeatures: 0, failedFeatures: 0, totalRetries: 1, estimatedCost: null },
  }
}

describe("Horizon Config", () => {
  it("loads default config when no file exists", () => {
    const config = horizon.loadHorizonConfig()
    expect(config.autonomyLevel).toBe("full")
    expect(config.maxRetryCycles).toBe(3)
    expect(config.testCommand).toBe("npm test")
  })

  it("rejects malformed and out-of-range config", () => {
    expect(() => horizon.validateHorizonConfig(null)).toThrow("JSON object")
    expect(() => horizon.validateHorizonConfig([])).toThrow("JSON object")
    expect(() => horizon.saveHorizonConfig({
      ...horizon.loadHorizonConfig(),
      maxRetryCycles: 0,
    })).toThrow("maxRetryCycles")
    expect(() => horizon.validateHorizonConfig({
      ...horizon.loadHorizonConfig(),
      decisionConfidenceThreshold: 2,
    })).toThrow("decisionConfidenceThreshold")
    expect(() => horizon.validateHorizonConfig({
      ...horizon.loadHorizonConfig(),
      unexpected: true,
    })).toThrow("Unknown config field")

    const configPath = "/mock-home/.parallax/horizon/config.json"
    mockFs.exists[configPath] = true
    mockFs.files[configPath] = "{not-json"
    expect(() => horizon.loadHorizonConfig()).toThrow("not valid JSON")
  })

  it("saves and loads config", () => {
    horizon.saveHorizonConfig({
      autonomyLevel: "semi",
      autoApproveMilestones: false,
      maxRetryCycles: 5,
      decisionConfidenceThreshold: 0.8,
      pauseOnCriticalFailure: true,
      testCommand: "pnpm test",
      lintCommand: "pnpm lint",
    })
    const config = horizon.loadHorizonConfig()
    expect(config.autonomyLevel).toBe("semi")
    expect(config.maxRetryCycles).toBe(5)
    expect(config.testCommand).toBe("pnpm test")
  })
})

describe("Horizon Session Init", () => {
  it("creates full directory tree", () => {
    horizon.initHorizonSession("test-session", "Test goal", "full")

    // Verify plan.json exists
    const plan = horizon.readHorizonPlan("test-session")
    expect(plan).not.toBeNull()
    expect(plan!.goal).toBe("Test goal")
    expect(plan!.autonomyLevel).toBe("full")
    expect(plan!.status).toBe("planning")
    expect(plan!.milestones).toEqual([])

    // Verify state.json exists
    const state = horizon.readHorizonState("test-session")
    expect(state).not.toBeNull()
    expect(state!.currentPhase).toBe("research")
    expect(state!.pausedAt).toBeNull()

    // Verify index.json was updated
    const sessions = horizon.listHorizonSessions()
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe("test-session")
    expect(sessions[0].meta.status).toBe("planning")
  })

  it("rejects invalid autonomy levels gracefully (type-enforced)", () => {
    // TypeScript enforces this at compile time, but ensure runtime doesn't crash
    horizon.initHorizonSession("test-session-2", "Test", "full")
    const plan = horizon.readHorizonPlan("test-session-2")
    expect(plan).not.toBeNull()
  })

  it("rejects traversal session IDs", () => {
    expect(() => horizon.initHorizonSession("../escape", "Test", "full")).toThrow("Invalid sessionId")
  })
})

describe("Horizon Plan Read/Write", () => {
  it("writes and reads a plan", () => {
    const plan = makeSamplePlan("test-session")
    horizon.writeHorizonPlan("test-session", plan)

    const read = horizon.readHorizonPlan("test-session")
    expect(read).not.toBeNull()
    expect(read!.goal).toBe("Test goal")
    expect(read!.milestones.length).toBe(1)
    expect(read!.milestones[0].features.length).toBe(2)
    expect(read!.stats.totalFeatures).toBe(2)
  })

  it("returns null for missing plan", () => {
    const plan = horizon.readHorizonPlan("nonexistent")
    expect(plan).toBeNull()
  })

  it("updates index status on write", () => {
    horizon.initHorizonSession("test-session", "Test", "full")
    const plan = makeSamplePlan("test-session")
    plan.status = "completed"
    horizon.writeHorizonPlan("test-session", plan)

    const sessions = horizon.listHorizonSessions()
    const s = sessions.find((s) => s.id === "test-session")
    expect(s).not.toBeUndefined()
    expect(s!.meta.status).toBe("completed")
  })
})

describe("Horizon Feature Updates", () => {
  it("updates a failed feature status and recalculates stats", () => {
    const plan = makeSamplePlan("test-session")
    horizon.writeHorizonPlan("test-session", plan)

    const result = horizon.updateHorizonFeature("test-session", "f1", { status: "failed" })

    expect(result).not.toBeNull()
    expect(result!.stats.failedFeatures).toBe(1)
    expect(result!.stats.totalFeatures).toBe(2)
    expect(result!.milestones[0].features[0].status).toBe("failed")
  })

  it("starts exactly one new worker session and increments attempts", () => {
    const plan = makeSamplePlan("test-session")
    plan.milestones[0].features[0].status = "failed"
    horizon.writeHorizonPlan("test-session", plan)

    horizon.updateHorizonFeature("test-session", "f2", {
      status: "in_progress",
      subAgentSessionId: "worker-1",
    })

    const read = horizon.readHorizonPlan("test-session")
    const f2 = read!.milestones[0].features.find((f) => f.id === "f2")
    expect(f2!.attempts).toBe(1)
    expect(f2!.status).toBe("in_progress")
    expect(f2!.subAgentSessionId).toBe("worker-1")
  })

  it("rejects overlapping, missing, and reused worker sessions", () => {
    const plan = makeSamplePlan("test-session")
    plan.milestones[0].features[0].subAgentSessionId = "worker-1"
    horizon.writeHorizonPlan("test-session", plan)

    expect(() => horizon.updateHorizonFeature("test-session", "f2", {
      status: "in_progress",
      subAgentSessionId: "worker-2",
    })).toThrow("only one in-progress feature")

    plan.milestones[0].features[0].status = "failed"
    horizon.writeHorizonPlan("test-session", plan)
    expect(() => horizon.updateHorizonFeature("test-session", "f2", {
      status: "in_progress",
    })).toThrow("requires its child session ID")
    expect(() => horizon.updateHorizonFeature("test-session", "f2", {
      status: "in_progress",
      subAgentSessionId: "worker-1",
    })).toThrow("new child session")
  })

  it("returns null for nonexistent feature", () => {
    const plan = makeSamplePlan("test-session")
    horizon.writeHorizonPlan("test-session", plan)

    const result = horizon.updateHorizonFeature("test-session", "nonexistent", { status: "completed" } as any)
    expect(result).toBeNull()
  })
})

describe("Horizon Milestone Updates", () => {
  it("updates milestone status", () => {
    const plan = makeSamplePlan("test-session")
    horizon.writeHorizonPlan("test-session", plan)

    const result = horizon.updateHorizonMilestone("test-session", "m1", "completed")
    expect(result).not.toBeNull()
    expect(result!.milestones[0].status).toBe("completed")
  })

  it("returns null for nonexistent milestone", () => {
    const plan = makeSamplePlan("test-session")
    horizon.writeHorizonPlan("test-session", plan)

    const result = horizon.updateHorizonMilestone("test-session", "nonexistent", "completed")
    expect(result).toBeNull()
  })
})

describe("Horizon State Read/Write", () => {
  it("writes and reads state", () => {
    const state: HorizonState = {
      sessionId: "test-session",
      currentPhase: "execute",
      activeSubAgents: ["agent-1"],
      currentMilestoneId: "m1",
      currentFeatureId: "f1",
      lastCheckpoint: null,
      pausedAt: null,
      pauseReason: null,
    }
    horizon.writeHorizonState("test-session", state)

    const read = horizon.readHorizonState("test-session")
    expect(read).not.toBeNull()
    expect(read!.currentPhase).toBe("execute")
    expect(read!.activeSubAgents).toEqual(["agent-1"])
    expect(read!.currentMilestoneId).toBe("m1")
  })

  it("sets lastCheckpoint on write", () => {
    const state: HorizonState = {
      sessionId: "test-session",
      currentPhase: "research",
      activeSubAgents: [],
      currentMilestoneId: null,
      currentFeatureId: null,
      lastCheckpoint: null,
      pausedAt: null,
      pauseReason: null,
    }
    horizon.writeHorizonState("test-session", state)

    const read = horizon.readHorizonState("test-session")
    expect(read!.lastCheckpoint).not.toBeNull()
    // Should be an ISO timestamp
    expect(new Date(read!.lastCheckpoint!).toISOString()).toBe(read!.lastCheckpoint)
  })

  it("returns null for missing state", () => {
    const state = horizon.readHorizonState("nonexistent")
    expect(state).toBeNull()
  })

  it("rejects overlapping delegated tasks", () => {
    expect(() => horizon.writeHorizonState("test-session", {
      sessionId: "test-session",
      currentPhase: "execute",
      activeSubAgents: ["worker-1", "auditor-1"],
      currentMilestoneId: "m1",
      currentFeatureId: "f1",
      lastCheckpoint: null,
      pausedAt: null,
      pauseReason: null,
    })).toThrow("at most one active sub-agent")
  })
})

describe("Horizon sequential evidence pipeline", () => {
  const receipt = (verdict: VerificationReceipt["verdict"]): VerificationReceipt => ({
    schemaVersion: 2,
    id: `receipt-${verdict}`,
    sessionId: "worker-1",
    source: "manual",
    startedAt: "2026-01-01T00:00:00Z",
    command: verdict === "skipped" ? null : "npm",
    args: verdict === "skipped" ? [] : ["test"],
    cwd: "/workspace",
    timeoutMs: 1000,
    durationMs: 10,
    exitCode: verdict === "pass" ? 0 : verdict === "fail" ? 1 : null,
    verdict,
    changedFiles: ["src/a.ts"],
    stdout: "",
    stderr: "",
    combined: "",
    outputTruncated: false,
    timedOut: false,
    skipReason: verdict === "skipped" ? "no check" : verdict === "unknown" ? "interrupted" : null,
  })

  it("does not let an evaluator score set verification passed or readiness", () => {
    const plan = makeSamplePlan("test-session")
    plan.milestones[0].features[0].subAgentSessionId = "worker-1"
    horizon.writeHorizonPlan("test-session", plan)
    horizon.recordHorizonEvaluationScore("test-session", "f1", 100)
    const feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(feature.verification).toMatchObject({ passed: false, score: 100 })
    expect(feature.verification.receiptId).toBeUndefined()
    expect(horizon.horizonFeatureIsReady(feature)).toBe(false)
  })

  it("requires worker then receipt then independent auditor before readiness", () => {
    const plan = makeSamplePlan("test-session")
    plan.milestones[0].features[0].subAgentSessionId = "worker-1"
    horizon.writeHorizonPlan("test-session", plan)

    expect(() => horizon.recordHorizonAudit(
      "test-session", "f1", "accept", "auditor-1", "looks good",
    )).toThrow("requires the current worker's observed schema-v2 receipt")

    horizon.recordHorizonVerificationReceipt("test-session", "f1", receipt("pass"), "changed src/a.ts")
    let feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(feature.verification).toMatchObject({ passed: true, receiptId: "receipt-pass", verdict: "pass" })
    expect(horizon.horizonFeatureIsReady(feature)).toBe(false)
    expect(() => horizon.recordHorizonVerificationReceipt(
      "test-session", "f1", receipt("pass"),
    )).toThrow("already persisted")

    expect(() => horizon.updateHorizonFeature(
      "test-session", "f1", { status: "completed" },
    )).toThrow("Completion requires")
    expect(() => horizon.recordHorizonAudit(
      "test-session", "f1", "accept", "worker-1", "self audit",
    )).toThrow("independent")
    horizon.recordHorizonAudit("test-session", "f1", "accept", "auditor-1", "accepted", "audit-trace")
    feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(horizon.horizonFeatureIsReady(feature)).toBe(true)
    expect(() => horizon.recordHorizonAudit(
      "test-session", "f1", "accept", "auditor-2", "duplicate",
    )).toThrow("already persisted")

    const completed = horizon.updateHorizonFeature("test-session", "f1", { status: "completed" })!
    expect(completed.milestones[0].features[0]).toMatchObject({
      status: "completed",
      subAgentSessionId: "worker-1",
      verification: { receiptId: "receipt-pass", verdict: "pass", passed: true },
      audit: { verdict: "accept", subAgentSessionId: "auditor-1" },
    })
  })

  it("persists non-pass verdict evidence and bounds child summaries", () => {
    const plan = makeSamplePlan("test-session")
    plan.milestones[0].features[0].subAgentSessionId = "worker-1"
    horizon.writeHorizonPlan("test-session", plan)
    expect(() => horizon.recordHorizonVerificationReceipt(
      "test-session", "f1", receipt("unknown"), "x".repeat(2001),
    )).toThrow("Worker summary exceeds 2000")
    expect(() => horizon.recordHorizonVerificationReceipt(
      "test-session", "f1", { ...receipt("unknown"), sessionId: "other-worker" },
    )).toThrow("does not belong")
    horizon.recordHorizonVerificationReceipt("test-session", "f1", receipt("unknown"))
    let feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(feature.verification).toMatchObject({ passed: false, receiptId: "receipt-unknown", verdict: "unknown" })
    expect(() => horizon.recordHorizonAudit(
      "test-session", "f1", "accept", "auditor-1", "no finding",
    )).toThrow("cannot accept a non-pass")
    expect(() => horizon.recordHorizonAudit(
      "test-session", "f1", "corrective-worker", "auditor-2", "x".repeat(2001),
    )).toThrow("exceeds 2000")
    horizon.recordHorizonAudit("test-session", "f1", "corrective-worker", "auditor-1", "verification unavailable")
    feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(feature.status).toBe("pending")
    expect(horizon.horizonFeatureIsReady(feature)).toBe(false)
  })

  it("invalidates old receipt and audit evidence when a corrective worker starts", () => {
    const plan = makeSamplePlan("test-session")
    plan.milestones[0].features[0].subAgentSessionId = "worker-1"
    horizon.writeHorizonPlan("test-session", plan)
    horizon.recordHorizonVerificationReceipt("test-session", "f1", receipt("pass"))
    horizon.recordHorizonAudit("test-session", "f1", "corrective-worker", "auditor-1", "fix edge case")
    let feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(feature.status).toBe("pending")

    horizon.updateHorizonFeature("test-session", "f1", {
      status: "in_progress",
      subAgentSessionId: "worker-2",
    })
    feature = horizon.readHorizonPlan("test-session")!.milestones[0].features[0]
    expect(feature.verification).toMatchObject({ passed: false, receiptId: null, verdict: null })
    expect(feature.audit).toBeNull()
    expect(feature.subAgentSessionId).toBe("worker-2")
  })
})

describe("Horizon Decision Log", () => {
  it("appends and reads decisions", () => {
    const decision: HorizonDecision = {
      timestamp: "2026-01-01T00:00:00Z",
      feature: "f1",
      ambiguity: "Which library?",
      researchResult: "Library X is standard",
      decision: "Use Library X",
      rationale: "Industry standard",
      confidence: "high",
    }
    horizon.appendHorizonDecision("test-session", decision)

    const decisions = horizon.readHorizonDecisions("test-session")
    expect(decisions.length).toBe(1)
    expect(decisions[0].feature).toBe("f1")
    expect(decisions[0].confidence).toBe("high")
  })

  it("appends multiple decisions in order", () => {
    horizon.appendHorizonDecision("test-session", {
      timestamp: "2026-01-01T00:00:00Z",
      feature: "f1",
      ambiguity: "Q1",
      researchResult: "R1",
      decision: "D1",
      rationale: "R1",
      confidence: "high",
    })
    horizon.appendHorizonDecision("test-session", {
      timestamp: "2026-01-02T00:00:00Z",
      feature: "f2",
      ambiguity: "Q2",
      researchResult: "R2",
      decision: "D2",
      rationale: "R2",
      confidence: "medium",
    })

    const decisions = horizon.readHorizonDecisions("test-session")
    expect(decisions.length).toBe(2)
    expect(decisions[0].feature).toBe("f1")
    expect(decisions[1].feature).toBe("f2")
  })

  it("returns empty array for missing file", () => {
    const decisions = horizon.readHorizonDecisions("nonexistent")
    expect(decisions).toEqual([])
  })
})

describe("Horizon Research Cache", () => {
  it("writes and reads research", () => {
    horizon.writeHorizonResearch("test-session", "# Findings\nTest content", {
      "source1": "https://example.com",
    })

    const research = horizon.readHorizonResearch("test-session")
    expect(research.findings).toBe("# Findings\nTest content")
    expect(research.sources["source1"]).toBe("https://example.com")
  })

  it("returns empty for missing research", () => {
    const research = horizon.readHorizonResearch("nonexistent")
    expect(research.findings).toBeNull()
    expect(research.sources).toEqual({})
  })
})

describe("Horizon Skills", () => {
  it("creates and lists skills", () => {
    horizon.createHorizonSkill("test-session", "my-skill", "A test skill", "# My Skill\nContent")
    const skills = horizon.listHorizonSkills("test-session")
    expect(skills).toContain("my-skill")
  })

  it("registers skill in plan.json", () => {
    // Init session first
    horizon.initHorizonSession("test-session", "Test", "full")

    horizon.createHorizonSkill("test-session", "react-patterns", "React patterns", "# React\nContent")
    const plan = horizon.readHorizonPlan("test-session")
    expect(plan!.skills.sessionScoped).toContain("react-patterns")
  })

  it("rejects traversal skill names", () => {
    expect(() => horizon.createHorizonSkill("test-session", "../escape", "Bad", "Bad")).toThrow("Invalid skill name")
  })
})

describe("Horizon Traces", () => {
  it("saves and lists traces", () => {
    horizon.saveHorizonSubAgentTrace("test-session", "sub-agent-1", '{"test": true}')
    const traces = horizon.listHorizonTraces("test-session")
    expect(traces).toContain("sub-agent-1")
  })

  it("rejects traversal trace IDs", () => {
    expect(() => horizon.saveHorizonSubAgentTrace("test-session", "../escape", "{}")).toThrow("Invalid subAgentSessionId")
  })
})

describe("Horizon Session Listing", () => {
  it("lists sessions from index", () => {
    horizon.initHorizonSession("session-a", "Goal A", "full")
    horizon.initHorizonSession("session-b", "Goal B", "semi")

    const sessions = horizon.listHorizonSessions()
    expect(sessions.length).toBe(2)
    expect(sessions.map((s) => s.id)).toContain("session-a")
    expect(sessions.map((s) => s.id)).toContain("session-b")
  })

  it("returns empty array when no sessions exist", () => {
    const sessions = horizon.listHorizonSessions()
    expect(sessions).toEqual([])
  })
})

describe("Horizon Session Archive", () => {
  it("finalizes and moves durable session data into the archive", () => {
    horizon.initHorizonSession("test-session", "Test", "full")

    expect(horizon.archiveHorizonSession("test-session")).toBe(true)
    expect(mockFs.exists["/mock-home/.parallax/horizon/sessions/test-session"]).toBeFalsy()
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/sessions[\\/]test-session$/),
      expect.stringMatching(/sessions[\\/]test-session\.archived$/),
    )

    const durableWrites = vi.mocked(writeFileSync).mock.calls.map((call) => String(call[1]))
    expect(durableWrites.some((value) =>
      value.includes('"status": "completed"') && !value.includes('"completedAt": null'),
    )).toBe(true)
    expect(durableWrites.some((value) =>
      value.includes('"currentPhase": "complete"') && value.includes('"activeSubAgents": []'),
    )).toBe(true)
    expect(horizon.listHorizonSessions()[0].meta.status).toBe("completed")
  })
})

describe("Horizon Session Status", () => {
  it("returns comprehensive status for complete session", () => {
    horizon.initHorizonSession("test-session", "Test", "full")

    // Add some data
    const plan = makeSamplePlan("test-session")
    horizon.writeHorizonPlan("test-session", plan)
    horizon.writeHorizonState("test-session", {
      sessionId: "test-session",
      currentPhase: "execute",
      activeSubAgents: [],
      currentMilestoneId: "m1",
      currentFeatureId: "f1",
      lastCheckpoint: null,
      pausedAt: null,
      pauseReason: null,
    })
    horizon.appendHorizonDecision("test-session", {
      timestamp: "2026-01-01T00:00:00Z",
      feature: "f1",
      ambiguity: "Q",
      researchResult: "R",
      decision: "D",
      rationale: "R",
      confidence: "high",
    })
    horizon.createHorizonSkill("test-session", "test-skill", "A skill", "Content")

    const status = horizon.getHorizonSessionStatus("test-session")
    expect(status.plan).not.toBeNull()
    expect(status.state).not.toBeNull()
    expect(status.decisions.length).toBe(1)
    expect(status.skills).toContain("test-skill")
    expect(status.research.findings).toBeNull() // No research written
  })
})
