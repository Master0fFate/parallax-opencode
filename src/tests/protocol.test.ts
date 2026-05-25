/**
 * Tests for protocol step ordering and enforcement.
 */
import { describe, it, expect, beforeEach } from "vitest"

interface ProtocolTestState {
  ambiguityDone: boolean
  invariantsDone: boolean
  gateDone: boolean
  designDone: boolean
  commitDone: boolean
  summaryDone: boolean
  writesBeforeGate: number
  gateBlocked: boolean
}

const STEP_LABELS: Record<string, string> = {
  ambiguity: "Ambiguity Check",
  invariants: "4 Invariants",
  gate: "Verification Gate",
  commit: "Commit Decision",
  summary: "Summarize",
}

function createProtocol(): ProtocolTestState {
  return {
    ambiguityDone: false,
    invariantsDone: false,
    gateDone: false,
    designDone: false,
    commitDone: false,
    summaryDone: false,
    writesBeforeGate: 0,
    gateBlocked: false,
  }
}

function checkin(p: ProtocolTestState, step: string): string {
  if (step === "ambiguity" && !p.ambiguityDone) {
    p.ambiguityDone = true
    return "[parallax] Step 1/6: Ambiguity Check marked complete."
  }
  if (step === "invariants") {
    if (!p.ambiguityDone) return "[parallax] ERROR: Complete Ambiguity Check first (Step 1)."
    p.invariantsDone = true
    return "[parallax] Step 2/6: 4 Invariants marked complete."
  }
  if (step === "gate") {
    if (!p.invariantsDone) return "[parallax] ERROR: Complete 4 Invariants first (Step 2)."
    p.gateDone = true
    return "[parallax] Step 3/6: Verification Gate marked complete."
  }
  if (step === "commit") {
    p.commitDone = true
    return "[parallax] Step 5/6: Commit Decision marked complete."
  }
  if (step === "summary") {
    p.summaryDone = true
    return "[parallax] Step 6/6: Summary marked complete. Protocol finished."
  }
  return `[parallax] Unknown step "${step}".`
}

describe("Protocol step enforcement", () => {
  let p: ProtocolTestState

  beforeEach(() => {
    p = createProtocol()
  })

  it("enforces correct order: ambiguity -> invariants -> gate", () => {
    expect(checkin(p, "ambiguity")).toContain("Step 1/6")
    expect(checkin(p, "invariants")).toContain("Step 2/6")
    expect(checkin(p, "gate")).toContain("Step 3/6")
  })

  it("blocks invariants before ambiguity", () => {
    expect(checkin(p, "invariants")).toContain("ERROR")
    expect(p.invariantsDone).toBe(false)
  })

  it("blocks gate before invariants", () => {
    checkin(p, "ambiguity")
    expect(checkin(p, "gate")).toContain("ERROR")
    expect(p.gateDone).toBe(false)
  })

  it("allows commit and summary at any time after gate", () => {
    checkin(p, "ambiguity")
    checkin(p, "invariants")
    checkin(p, "gate")
    expect(checkin(p, "commit")).toContain("Step 5/6")
    expect(checkin(p, "summary")).toContain("Step 6/6")
    expect(p.summaryDone).toBe(true)
  })

  it("rejects unknown steps", () => {
    expect(checkin(p, "bogus")).toContain("Unknown step")
  })
})
