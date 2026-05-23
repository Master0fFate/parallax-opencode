/**
 * Tests for coherence score computation.
 */
import { describe, it, expect } from "vitest"

// Types matching what the score module will use
interface PhaseRecord {
  phase: string
  timestamp: string
  data: Record<string, unknown>
}

interface WriteRecord {
  file: string
  timestamp: string
  verification: "pass" | "fail" | "skipped" | "unknown"
  frictionRetriesLeft: number
}

interface ParallaxTrace {
  schemaVersion: "1.0"
  session: {
    id: string | null
    agent: "parallax"
    agentVersion: string
    startedAt: string
    endedAt: string | null
  }
  phases: PhaseRecord[]
  writes: WriteRecord[]
  coherenceScore: number | null
}

function computeCoherenceScore(trace: ParallaxTrace): number {
  // 1. Protocol Coverage (30 points max)
  const required = ["ambiguity_check", "four_invariants", "verification_gate", "commit_decision", "summary"]
  const phaseNames = new Set(trace.phases.map((p) => p.phase))
  const completed = required.filter((r) => phaseNames.has(r)).length
  const protocolScore = (completed / required.length) * 30

  // 2. Verification Integrity (35 points max)
  let integrityScore = 0
  if (trace.writes.length > 0) {
    const firstPass = trace.writes.filter(
      (w) => w.verification === "pass" && w.frictionRetriesLeft === 3,
    ).length
    integrityScore = (firstPass / trace.writes.length) * 35
  }

  // 3. Edge Case Coverage (20 points max)
  // For now, check if analyze phases recorded edge categories
  const analyzePhases = trace.phases.filter((p) => p.phase === "mode_switch" && p.data.analysisTopic)
  const edgeScore = Math.min(analyzePhases.length / 3, 1) * 20

  // 4. Timing Discipline (15 points max)
  const order = ["ambiguity_check", "four_invariants", "verification_gate", "commit_decision", "summary"]
  let inOrder = 0
  let lastIdx = -1
  for (const phase of trace.phases) {
    const idx = order.indexOf(phase.phase)
    if (idx > lastIdx) {
      inOrder++
      lastIdx = idx
    }
  }
  // Normalize to 5 possible
  const timingScore = Math.min(inOrder / order.length, 1) * 15

  return Math.round(protocolScore + integrityScore + edgeScore + timingScore)
}

function makeTrace(phases: string[], writes: WriteRecord[]): ParallaxTrace {
  return {
    schemaVersion: "1.0",
    session: {
      id: "test",
      agent: "parallax",
      agentVersion: "0.2.0",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T01:00:00.000Z",
    },
    phases: phases.map((p) => ({
      phase: p,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {},
    })),
    writes,
    coherenceScore: null,
  }
}

describe("Coherence score", () => {
  it("returns 0 for empty trace", () => {
    const trace = makeTrace([], [])
    const score = computeCoherenceScore(trace)
    expect(score).toBe(0)
  })

  it("returns near-perfect for complete protocol with all passes", () => {
    const trace = makeTrace(
      ["ambiguity_check", "four_invariants", "verification_gate", "commit_decision", "summary"],
      [
        { file: "a.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
        { file: "b.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
        { file: "c.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
      ],
    )
    const score = computeCoherenceScore(trace)
    // Protocol coverage: 5/5 * 30 = 30
    // Integrity: 3/3 * 35 = 35
    // Edge: 0/3 * 20 = 0 (no analyze phases)
    // Timing: 5/5 * 15 = 15
    // Total: 80
    expect(score).toBe(80)
  })

  it("penalizes verification failures", () => {
    const trace = makeTrace(
      ["ambiguity_check", "four_invariants", "verification_gate", "commit_decision", "summary"],
      [
        { file: "a.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
        { file: "b.ts", timestamp: "", verification: "fail", frictionRetriesLeft: 2 },
      ],
    )
    const score = computeCoherenceScore(trace)
    // Protocol: 5/5 * 30 = 30
    // Integrity: 1/2 * 35 = 17.5
    // Edge: 0
    // Timing: 5/5 * 15 = 15
    // Total: 62.5 -> 63
    expect(score).toBe(63)
  })

  it("penalizes missing protocol steps", () => {
    const trace = makeTrace(
      ["ambiguity_check", "verification_gate"],
      [
        { file: "a.ts", timestamp: "", verification: "pass", frictionRetriesLeft: 3 },
      ],
    )
    const score = computeCoherenceScore(trace)
    // Protocol: 2/5 * 30 = 12
    // Integrity: 1/1 * 35 = 35
    // Edge: 0
    // Timing: inOrder starts with ambiguity (idx 0), then verification_gate (idx 2) -> 2
    // 2/5 * 15 = 6
    // Total: 53
    expect(score).toBe(53)
  })

  it("handles partial trace without crashing", () => {
    const trace = makeTrace([], [])
    // Should not crash
    expect(() => computeCoherenceScore(trace)).not.toThrow()
  })
})
