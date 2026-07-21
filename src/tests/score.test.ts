import { describe, expect, it } from "vitest"
import { computeCoherenceScore, isVerifiedPass } from "../score.js"
import type {
  ParallaxTrace,
  PhaseName,
  VerificationReceipt,
  WriteRecord,
} from "../types.js"

function makeTrace(phases: PhaseName[], writes: WriteRecord[] = []): ParallaxTrace {
  return {
    schemaVersion: "1.0",
    session: {
      id: "test",
      agent: "parallax",
      agentVersion: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      project: null,
      projectType: null,
    },
    phases: phases.map((phase) => ({ phase, timestamp: "2026-01-01T00:00:00.000Z", data: {} })),
    writes,
    verificationLedger: { schemaVersion: 2, receipts: [] },
    metrics: null,
    coherenceScore: null,
  }
}

function receipt(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    schemaVersion: 2,
    id: "receipt",
    sessionId: "test",
    source: "automatic",
    startedAt: "2026-01-01T00:00:00.000Z",
    command: "npm",
    args: ["run", "test"],
    cwd: "/project",
    timeoutMs: 120_000,
    durationMs: 10,
    exitCode: 0,
    verdict: "pass",
    changedFiles: ["src/a.ts"],
    stdout: "ok",
    stderr: "",
    combined: "ok",
    outputTruncated: false,
    timedOut: false,
    skipReason: null,
    ...overrides,
  }
}

const completePhases: PhaseName[] = [
  "ambiguity_check",
  "four_invariants",
  "verification_gate",
  "commit_decision",
  "summary",
]

describe("production coherence score", () => {
  it("returns zero for an empty trace", () => {
    expect(computeCoherenceScore(makeTrace([])).total).toBe(0)
  })

  it("scores complete protocol and verified writes", () => {
    const trace = makeTrace(completePhases, [
      { file: "a.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
      { file: "b.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
    ])
    expect(computeCoherenceScore(trace).total).toBe(80)
  })

  it("penalizes failures and missing protocol steps", () => {
    const trace = makeTrace(["ambiguity_check", "verification_gate"], [
      { file: "a.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
      { file: "b.ts", timestamp: "", verification: "fail", frictionRetriesLeft: 2 },
    ])
    expect(computeCoherenceScore(trace).verificationIntegrity).toBe(18)
    expect(computeCoherenceScore(trace).protocolCoverage).toBe(12)
  })

  it("keeps skipped and unknown receipts in the confidence denominator", () => {
    const trace = makeTrace([])
    trace.verificationLedger.receipts = [
      receipt(),
      receipt({ id: "skip", command: null, args: [], exitCode: null, verdict: "skipped", skipReason: "unsupported" }),
      receipt({ id: "unknown", exitCode: null, verdict: "unknown", timedOut: true, skipReason: "timeout" }),
    ]
    expect(computeCoherenceScore(trace).verificationIntegrity).toBe(12)
  })

  it("does not trust a pass verdict whose execution evidence disagrees", () => {
    const inconsistent = receipt({ exitCode: null })
    expect(isVerifiedPass(inconsistent)).toBe(false)
    const trace = makeTrace([])
    trace.verificationLedger.receipts = [inconsistent]
    expect(computeCoherenceScore(trace).verificationIntegrity).toBe(0)
  })
})
