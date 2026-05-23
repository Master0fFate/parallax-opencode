/**
 * Tests for trace recording and export.
 */
import { describe, it, expect, beforeEach } from "vitest"

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

function createTrace(): ParallaxTrace {
  return {
    schemaVersion: "1.0",
    session: {
      id: "test-session",
      agent: "parallax",
      agentVersion: "0.2.0",
      startedAt: new Date().toISOString(),
      endedAt: null,
    },
    phases: [],
    writes: [],
    coherenceScore: null,
  }
}

function addPhase(trace: ParallaxTrace, phase: string, data: Record<string, unknown> = {}): void {
  trace.phases.push({ phase, timestamp: new Date().toISOString(), data })
}

function addWrite(
  trace: ParallaxTrace,
  file: string,
  verdict: WriteRecord["verification"],
  retries: number,
): void {
  trace.writes.push({
    file,
    timestamp: new Date().toISOString(),
    verification: verdict,
    frictionRetriesLeft: retries,
  })
}

function computeMetrics(trace: ParallaxTrace) {
  const totalWrites = trace.writes.length
  const passes = trace.writes.filter((w) => w.verification === "pass").length
  const firstPass = trace.writes.filter(
    (w) => w.verification === "pass" && w.frictionRetriesLeft === 3,
  ).length
  const phaseNames = new Set(trace.phases.map((p) => p.phase))
  const required = [
    "ambiguity_check",
    "four_invariants",
    "verification_gate",
    "commit_decision",
    "summary",
  ]
  const completed = required.filter((r) => phaseNames.has(r)).length
  return {
    totalWrites,
    verificationPassRate: totalWrites > 0 ? passes / totalWrites : 0,
    firstAttemptPassRate: totalWrites > 0 ? firstPass / totalWrites : 0,
    protocolStepsCompleted: completed,
  }
}

describe("Trace recording", () => {
  let trace: ParallaxTrace

  beforeEach(() => {
    trace = createTrace()
  })

  it("creates an empty trace with correct schema", () => {
    expect(trace.schemaVersion).toBe("1.0")
    expect(trace.session.id).toBe("test-session")
    expect(trace.phases).toHaveLength(0)
    expect(trace.writes).toHaveLength(0)
  })

  it("records phases in order", () => {
    addPhase(trace, "ambiguity_check", { level: "LOW" })
    addPhase(trace, "four_invariants")
    addPhase(trace, "verification_gate")

    expect(trace.phases).toHaveLength(3)
    expect(trace.phases[0].phase).toBe("ambiguity_check")
    expect(trace.phases[1].phase).toBe("four_invariants")
    expect(trace.phases[2].phase).toBe("verification_gate")
    expect(trace.phases[0].data.level).toBe("LOW")
  })

  it("records writes with verification status", () => {
    addWrite(trace, "src/main.ts", "pass", 3)
    addWrite(trace, "src/lib.ts", "fail", 2)
    addWrite(trace, "src/utils.ts", "pass", 3)

    expect(trace.writes).toHaveLength(3)
    expect(trace.writes[0].file).toBe("src/main.ts")
    expect(trace.writes[1].verification).toBe("fail")
    expect(trace.writes[2].frictionRetriesLeft).toBe(3)
  })

  it("computes metrics from trace data", () => {
    addPhase(trace, "ambiguity_check")
    addPhase(trace, "four_invariants")
    addPhase(trace, "verification_gate")
    addPhase(trace, "commit_decision")
    addPhase(trace, "summary")

    addWrite(trace, "a.ts", "pass", 3)
    addWrite(trace, "b.ts", "pass", 3)
    addWrite(trace, "c.ts", "fail", 1)
    addWrite(trace, "d.ts", "pass", 3)

    const metrics = computeMetrics(trace)
    expect(metrics.totalWrites).toBe(4)
    expect(metrics.verificationPassRate).toBe(0.75)
    expect(metrics.firstAttemptPassRate).toBe(0.75) // 3 out of 4 passed on first attempt
    expect(metrics.protocolStepsCompleted).toBe(5)
  })

  it("handles empty trace metrics", () => {
    const metrics = computeMetrics(trace)
    expect(metrics.totalWrites).toBe(0)
    expect(metrics.verificationPassRate).toBe(0)
    expect(metrics.protocolStepsCompleted).toBe(0)
  })

  it("isolates traces by session", () => {
    const trace2 = createTrace()
    addPhase(trace, "ambiguity_check")
    expect(trace.phases).toHaveLength(1)
    expect(trace2.phases).toHaveLength(0)
  })
})
