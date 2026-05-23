/**
 * PARALLAX ENGINE -- Coherence Score Computation
 *
 * Computes an evidence-based quality score (0-100) from a Parallax trace.
 * Measures how well the agent followed the methodology.
 *
 * Score components:
 *   - Protocol Coverage (30%): Did all 5 protocol phases execute?
 *   - Verification Integrity (35%): Pass rate on first attempt?
 *   - Edge Case Coverage (20%): How many edge categories analyzed?
 *   - Timing Discipline (15%): Were phases in correct order?
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import { join } from "path"
import { existsSync, appendFileSync, readFileSync, mkdirSync } from "fs"
import type { ParallaxTrace, PhaseName, ScoreBreakdown, ScoreEntry } from "./types"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_PHASES: PhaseName[] = [
  "ambiguity_check",
  "four_invariants",
  "verification_gate",
  "commit_decision",
  "summary",
]

const PHASE_ORDER: PhaseName[] = [
  "ambiguity_check",
  "four_invariants",
  "verification_gate",
  "mode_switch",
  "execution",
  "commit_decision",
  "summary",
]

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute the coherence score (0-100) from a trace.
 * Handles missing data and partial traces gracefully.
 */
export function computeCoherenceScore(trace: ParallaxTrace): ScoreBreakdown {
  // 1. Protocol Coverage (30 points max)
  const phaseNames = new Set(trace.phases.map((p) => p.phase))
  const completed = REQUIRED_PHASES.filter((r) => phaseNames.has(r)).length
  const protocolCoverage = Math.round((completed / REQUIRED_PHASES.length) * 30)

  // 2. Verification Integrity (35 points max)
  let verificationIntegrity = 0
  const writesWithData = trace.writes.filter((w) => w.verification !== "unknown")
  if (writesWithData.length > 0) {
    const firstPass = writesWithData.filter(
      (w) => w.verification === "pass" && w.frictionRetriesLeft >= 3,
    ).length
    verificationIntegrity = Math.round((firstPass / writesWithData.length) * 35)
  }

  // 3. Edge Case Coverage (20 points max)
  // Count unique edge categories from analyze phases
  const analyzePhases = trace.phases.filter(
    (p) => p.phase === "mode_switch" && p.data && typeof p.data.analysisTopic === "string",
  )
  // Each unique analysis topic counts as an edge category
  const edgeCategories = new Set(
    analyzePhases.map((p) => p.data.analysisTopic as string),
  )
  const edgeCaseCoverage = Math.min(Math.round((edgeCategories.size / 7) * 20), 20)

  // 4. Timing Discipline (15 points max)
  let inOrder = 0
  let lastIdx = -1
  for (const phase of trace.phases) {
    const idx = PHASE_ORDER.indexOf(phase.phase)
    if (idx > lastIdx) {
      inOrder++
      lastIdx = idx
    }
  }
  const timingDiscipline = Math.min(
    Math.round((inOrder / REQUIRED_PHASES.length) * 15),
    15,
  )

  const total = Math.min(protocolCoverage + verificationIntegrity + edgeCaseCoverage + timingDiscipline, 100)

  return {
    total,
    protocolCoverage,
    verificationIntegrity,
    edgeCaseCoverage,
    timingDiscipline,
  }
}

// ---------------------------------------------------------------------------
// Score display helpers
// ---------------------------------------------------------------------------

/**
 * Get a human-readable grade for a score.
 */
export function scoreToGrade(score: number): string {
  if (score >= 90) return "S"
  if (score >= 80) return "A"
  if (score >= 70) return "B"
  if (score >= 60) return "C"
  if (score >= 40) return "D"
  return "F"
}

/**
 * Format score breakdown for display.
 */
export function formatScoreBreakdown(breakdown: ScoreBreakdown): string {
  return [
    `Coherence Score: ${breakdown.total}/100 (${scoreToGrade(breakdown.total)})`,
    ``,
    `  Protocol Coverage:     ${breakdown.protocolCoverage}/30  (phases completed)`,
    `  Verification Integrity: ${breakdown.verificationIntegrity}/35  (first-pass rate)`,
    `  Edge Case Coverage:    ${breakdown.edgeCaseCoverage}/20  (categories analyzed)`,
    `  Timing Discipline:     ${breakdown.timingDiscipline}/15  (phase ordering)`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Trend tracking
// ---------------------------------------------------------------------------

const SCORES_DIR = ".parallax"
const SCORES_FILE = join(SCORES_DIR, "scores.jsonl")

function getScoresFilePath(): string {
  return join(process.cwd(), SCORES_FILE)
}

/**
 * Record a score entry to the append-only scores file.
 */
export function recordScore(entry: ScoreEntry): void {
  const filePath = getScoresFilePath()
  const dir = join(process.cwd(), SCORES_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8")
}

/**
 * Read all score entries from the scores file.
 */
export function readScoreHistory(): ScoreEntry[] {
  const filePath = getScoresFilePath()
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, "utf8")
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ScoreEntry)
  } catch {
    return []
  }
}

/**
 * Compute a simple sparkline representation of scores over time.
 */
export function sparkline(scores: number[]): string {
  if (scores.length === 0) return ""
  const chars = ["_", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const max = Math.max(...scores, 1)
  return scores.map((s) => chars[Math.min(Math.floor((s / max) * (chars.length - 1)), chars.length - 1)]).join("")
}
