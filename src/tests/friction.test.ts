/**
 * Tests for friction loop state machine.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const MAX_FRICTION_RETRIES = 3

interface FrictionTestState {
  successes: number
  trials: number
  retriesLeft: number
  lastObservation: string | null
}

function createState(): FrictionTestState {
  return {
    successes: 0,
    trials: 0,
    retriesLeft: MAX_FRICTION_RETRIES,
    lastObservation: null,
  }
}

function recordSuccess(state: FrictionTestState): void {
  state.successes++
  state.trials++
  state.retriesLeft = MAX_FRICTION_RETRIES
  state.lastObservation = null
}

function recordFailure(state: FrictionTestState, msg: string): void {
  state.trials++
  state.retriesLeft--
  state.lastObservation = msg
}

// Helper for debounce-like behavior
function simulateTimeout(): void {
  vi.advanceTimersByTime(1000)
}

describe("Friction loop state machine", () => {
  let state: FrictionTestState

  beforeEach(() => {
    state = createState()
    vi.useFakeTimers()
  })

  it("starts with full retries and no observation", () => {
    expect(state.successes).toBe(0)
    expect(state.trials).toBe(0)
    expect(state.retriesLeft).toBe(3)
    expect(state.lastObservation).toBeNull()
  })

  it("resets retries on success", () => {
    recordSuccess(state)
    expect(state.successes).toBe(1)
    expect(state.trials).toBe(1)
    expect(state.retriesLeft).toBe(3)
    expect(state.lastObservation).toBeNull()
  })

  it("decrements retries on failure", () => {
    recordFailure(state, "error: syntax error")
    expect(state.successes).toBe(0)
    expect(state.trials).toBe(1)
    expect(state.retriesLeft).toBe(2)
    expect(state.lastObservation).toBe("error: syntax error")
  })

  it("blocks after 3 consecutive failures", () => {
    recordFailure(state, "fail 1")
    expect(state.retriesLeft).toBe(2)
    recordFailure(state, "fail 2")
    expect(state.retriesLeft).toBe(1)
    recordFailure(state, "fail 3")
    expect(state.retriesLeft).toBe(0)
    expect(state.lastObservation).toBe("fail 3")
  })

  it("recovers after success following failures", () => {
    recordFailure(state, "fail 1")
    recordFailure(state, "fail 2")
    expect(state.retriesLeft).toBe(1)
    recordSuccess(state)
    expect(state.retriesLeft).toBe(3)
    expect(state.successes).toBe(1)
  })

  it("accumulates trials correctly", () => {
    recordSuccess(state)
    recordSuccess(state)
    recordFailure(state, "an error")
    recordSuccess(state)
    expect(state.trials).toBe(4)
    expect(state.successes).toBe(3)
  })

  it("isolates state per session", () => {
    const state2 = createState()
    recordFailure(state, "session A error")
    expect(state.retriesLeft).toBe(2)
    expect(state2.retriesLeft).toBe(3)
    expect(state2.lastObservation).toBeNull()
  })
})
