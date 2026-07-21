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
import type {
  ParallaxTrace,
  PhaseName,
  ScoreBreakdown,
  ScoreEntry,
  VerificationReceipt,
} from "./types.js"

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

/** A pass only carries confidence when its execution evidence agrees. */
export function isVerifiedPass(receipt: VerificationReceipt): boolean {
  return receipt.verdict === "pass" &&
    typeof receipt.command === "string" && receipt.command.length > 0 &&
    receipt.exitCode === 0 &&
    receipt.timedOut === false &&
    receipt.skipReason === null
}

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
  const receiptEvidence = trace.verificationLedger?.receipts
  if (receiptEvidence?.length) {
    const passes = receiptEvidence.filter(isVerifiedPass).length
    // Failed, skipped, unknown, and internally inconsistent receipts all stay
    // in the denominator and can never inflate confidence.
    verificationIntegrity = Math.round((passes / receiptEvidence.length) * 35)
  } else if (trace.writes.length > 0) {
    const firstPass = trace.writes.filter(
      (w) => w.verification === "pass" && w.frictionRetriesLeft >= 3,
    ).length
    verificationIntegrity = Math.round((firstPass / trace.writes.length) * 35)
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

// ---------------------------------------------------------------------------
// Analytics / Phase 5
// ---------------------------------------------------------------------------

function getISOWeek(dateStr: string): string {
  const d = new Date(dateStr)
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = utc.getUTCDay() || 7
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`
}

export function computeWeeklyReport(history: ScoreEntry[]): {
  weekStart: string
  avg: number
  count: number
  best: number
  worst: number
}[] {
  const weeks = new Map<string, ScoreEntry[]>()
  for (const entry of history) {
    const week = getISOWeek(entry.date)
    if (!weeks.has(week)) weeks.set(week, [])
    weeks.get(week)!.push(entry)
  }
  return [...weeks.entries()]
    .map(([week, entries]) => {
      const scores = entries.map((e) => e.score)
      return {
        weekStart: week,
        avg: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
        count: entries.length,
        best: Math.max(...scores),
        worst: Math.min(...scores),
      }
    })
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
}

export function detectFailurePatterns(trace: ParallaxTrace): {
  file: string
  failures: number
}[] {
  const grouped = new Map<string, number>()
  for (const w of trace.writes) {
    if (w.verification === "fail") {
      grouped.set(w.file, (grouped.get(w.file) ?? 0) + 1)
    }
  }
  return [...grouped.entries()]
    .map(([file, failures]) => ({ file, failures }))
    .sort((a, b) => b.failures - a.failures)
}

export function computePerProjectStats(history: ScoreEntry[]): {
  project: string
  sessions: number
  avgScore: number
}[] {
  const grouped = new Map<string, ScoreEntry[]>()
  for (const entry of history) {
    const key = entry.project ?? "unknown"
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(entry)
  }
  return [...grouped.entries()]
    .map(([project, entries]) => ({
      project,
      sessions: entries.length,
      avgScore: Math.round(
        entries.reduce((a, e) => a + e.score, 0) / entries.length,
      ),
    }))
    .sort((a, b) => b.sessions - a.sessions)
}
