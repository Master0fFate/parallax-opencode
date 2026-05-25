#!/usr/bin/env node

/**
 * PARALLAX ENGINE -- CLI Entry Point
 *
 * Provides the `parallax` CLI command for trace management, scoring,
 * and project initialization.
 *
 * Commands:
 *   parallax init              - Create .parallax/ config directory
 *   parallax trace list        - List all traces
 *   parallax trace show <id>   - Show a trace
 *   parallax trace score <id>  - Show coherence score breakdown
 *   parallax trace export <id> - Export trace to JSON
 *   parallax trace trend       - Show score trend
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import {
  listTraceFiles,
  loadTrace,
  exportTrace,
} from "./trace"
import {
  computeCoherenceScore,
  formatScoreBreakdown,
  readScoreHistory,
  sparkline,
  scoreToGrade,
  recordScore,
  computeWeeklyReport,
  detectFailurePatterns,
  computePerProjectStats,
} from "./score"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARALLAX_DIR = ".parallax"

// ---------------------------------------------------------------------------
// Help & version
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`Parallax Engine CLI v0.2.0`)
  console.log(``)
  console.log(`Usage: parallax <command> [options]`)
  console.log(``)
  console.log(`Commands:`)
  console.log(`  init                  Create .parallax/ directory with defaults`)
  console.log(`  trace list            List all traces`)
  console.log(`  trace show <id>       Show full trace`)
  console.log(`  trace score <id>      Show coherence score`)
  console.log(`  trace export <id>     Export trace to JSON file`)
  console.log(`  trace trend           Show score trend over time`)
  console.log(`  trace report --week   Show weekly score report`)
  console.log(`  trace compare <a> <b> Side-by-side comparison of two traces`)
  console.log(`  trace compliance <id> Protocol compliance report`)
  console.log(`  gate [--session <id>] [--last] [--min-score <n>]  Gate by coherence score`)
  console.log(`  pre-commit            Pre-commit hook (runs gate --last --min-score 70)`)
  console.log(`  help                  Show this help`)
}

function showVersion(): void {
  console.log("0.2.0")
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdInit(): Promise<number> {
  const dir = join(process.cwd(), PARALLAX_DIR)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`Created ${PARALLAX_DIR}/`)
  } else {
    console.log(`${PARALLAX_DIR}/ already exists`)
  }

  const gitignorePath = join(dir, ".gitignore")
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n", "utf8")
    console.log(`Created ${PARALLAX_DIR}/.gitignore`)
  }

  // Create traces subdirectory
  const tracesDir = join(dir, "traces")
  if (!existsSync(tracesDir)) {
    mkdirSync(tracesDir, { recursive: true })
    console.log(`Created ${PARALLAX_DIR}/traces/`)
  }

  console.log(`\nParallax initialized. Traces will be stored in ${PARALLAX_DIR}/traces/`)
  return 0
}

async function cmdTraceList(): Promise<number> {
  const files = listTraceFiles()
  if (files.length === 0) {
    console.log("No traces found.")
    return 0
  }

  console.log(`Found ${files.length} trace(s):\n`)
  for (const f of files) {
    const trace = loadTrace(f.sessionId)
    const score = trace ? computeCoherenceScore(trace) : null
    const phases = trace ? trace.phases.length : 0
    const writes = trace ? trace.writes.length : 0
    const scoreStr = score ? `${score.total}/100 (${scoreToGrade(score.total)})` : "N/A"
    console.log(
      `  ${f.sessionId.padEnd(20)}  ` +
        `${writes} writes, ${phases} phases  ` +
        `Score: ${scoreStr}`,
    )
  }
  return 0
}

async function cmdTraceShow(id: string): Promise<number> {
  const trace = loadTrace(id)
  if (!trace) {
    console.error(`Trace not found: ${id}`)
    return 1
  }

  console.log(`Session: ${trace.session.id}`)
  console.log(`Started: ${trace.session.startedAt}`)
  console.log(`Ended:   ${trace.session.endedAt || "in progress"}`)
  console.log(`Project: ${trace.session.project || "unknown"}`)
  console.log(`Type:    ${trace.session.projectType || "unknown"}`)
  console.log(``)
  console.log(`Phases (${trace.phases.length}):`)
  for (const p of trace.phases) {
    console.log(`  [${p.phase}] ${p.timestamp}`)
    if (Object.keys(p.data).length > 0) {
      console.log(`    Data: ${JSON.stringify(p.data)}`)
    }
  }
  console.log(``)
  console.log(`Writes (${trace.writes.length}):`)
  for (const w of trace.writes) {
    const status = w.verification === "pass" ? "OK" : w.verification === "fail" ? "FAIL" : w.verification
    console.log(`  [${status}] ${w.file} (retries: ${3 - w.frictionRetriesLeft})`)
  }
  return 0
}

async function cmdTraceScore(id: string): Promise<number> {
  const trace = loadTrace(id)
  if (!trace) {
    console.error(`Trace not found: ${id}`)
    return 1
  }

  const breakdown = computeCoherenceScore(trace)
  console.log(formatScoreBreakdown(breakdown))

  // Optionally record the score
  const entry = {
    sessionId: id,
    date: new Date().toISOString(),
    score: breakdown.total,
    project: trace.session.project,
  }
  recordScore(entry)
  return 0
}

async function cmdTraceExport(id: string): Promise<number> {
  const trace = loadTrace(id)
  if (!trace) {
    console.error(`Trace not found: ${id}`)
    return 1
  }

  const filePath = exportTrace(id, true)
  console.log(`Trace exported to: ${filePath}`)
  return 0
}

async function cmdTraceTrend(): Promise<number> {
  const history = readScoreHistory()
  if (history.length === 0) {
    console.log("No score history found.")
    return 0
  }

  const scores = history.map((e) => e.score)
  const line = sparkline(scores)
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)

  console.log(`Score trend (${history.length} entries, avg: ${avg}/100):`)
  console.log(`  ${line}`)
  console.log(``)
  for (const entry of history) {
    const date = entry.date.slice(0, 10)
    console.log(`  ${date}  ${entry.score}/100  [${entry.sessionId.slice(0, 8)}]  ${entry.project || ""}`)
  }
  return 0
}

async function cmdTraceReport(): Promise<number> {
  const history = readScoreHistory()
  if (history.length === 0) {
    console.log("No score history found.")
    return 0
  }

  const weeks = computeWeeklyReport(history)
  console.log(`Weekly Report (${weeks.length} weeks):`)
  for (const w of weeks) {
    console.log(`  ${w.weekStart}: avg ${w.avg}/100 (${w.count} sessions, best: ${w.best}, worst: ${w.worst})`)
  }
  return 0
}

async function cmdTraceCompare(a: string, b: string): Promise<number> {
  const traceA = loadTrace(a)
  const traceB = loadTrace(b)

  if (!traceA) {
    console.error(`Trace not found: ${a}`)
    return 1
  }
  if (!traceB) {
    console.error(`Trace not found: ${b}`)
    return 1
  }

  const scoreA = computeCoherenceScore(traceA)
  const scoreB = computeCoherenceScore(traceB)

  const passRate = (trace: typeof traceA): string => {
    const known = trace.writes.filter((w) => w.verification !== "unknown")
    if (known.length === 0) return "N/A"
    const passes = known.filter((w) => w.verification === "pass").length
    return `${Math.round((passes / known.length) * 100)}%`
  }

  const frictionRetries = (trace: typeof traceA): number =>
    trace.writes.reduce((sum, w) => sum + (3 - w.frictionRetriesLeft), 0)

  const rows: [string, string, string, string][] = [
    [
      "Coherence Score",
      `${scoreA.total}/100 (${scoreToGrade(scoreA.total)})`,
      `${scoreB.total}/100 (${scoreToGrade(scoreB.total)})`,
      `${scoreB.total - scoreA.total >= 0 ? "+" : ""}${scoreB.total - scoreA.total}`,
    ],
    [
      "Protocol Coverage",
      `${scoreA.protocolCoverage}/30`,
      `${scoreB.protocolCoverage}/30`,
      `${scoreB.protocolCoverage - scoreA.protocolCoverage >= 0 ? "+" : ""}${scoreB.protocolCoverage - scoreA.protocolCoverage}`,
    ],
    [
      "Verification Pass %",
      passRate(traceA),
      passRate(traceB),
      "",
    ],
    [
      "Writes",
      `${traceA.writes.length}`,
      `${traceB.writes.length}`,
      `${traceB.writes.length - traceA.writes.length >= 0 ? "+" : ""}${traceB.writes.length - traceA.writes.length}`,
    ],
    [
      "Friction Retries",
      `${frictionRetries(traceA)}`,
      `${frictionRetries(traceB)}`,
      `${frictionRetries(traceB) - frictionRetries(traceA) >= 0 ? "+" : ""}${frictionRetries(traceB) - frictionRetries(traceA)}`,
    ],
  ]

  const colWidths = [22, 17, 17, 7]
  const pad = (text: string, width: number) => text.padEnd(width)

  console.log("Trace Comparison:")
  console.log(
    `  ${pad("Metric", colWidths[0])} | ${pad("Session A", colWidths[1])} | ${pad("Session B", colWidths[2])} | Delta`,
  )
  console.log(
    `  ${"-".repeat(colWidths[0])}-+-${"-".repeat(colWidths[1])}-+-${"-".repeat(colWidths[2])}-+-------`,
  )
  for (const row of rows) {
    console.log(
      `  ${pad(row[0], colWidths[0])} | ${pad(row[1], colWidths[1])} | ${pad(row[2], colWidths[2])} | ${row[3]}`,
    )
  }
  return 0
}

async function cmdTraceCompliance(id: string): Promise<number> {
  const trace = loadTrace(id)
  if (!trace) {
    console.error(`Trace not found: ${id}`)
    return 1
  }

  const REQUIRED_PHASES = [
    "ambiguity_check",
    "four_invariants",
    "verification_gate",
    "commit_decision",
    "summary",
  ] as const

  const DISPLAY_NAMES: Record<string, string> = {
    ambiguity_check: "Ambiguity Check",
    four_invariants: "4 Invariants",
    verification_gate: "Verification Gate",
    commit_decision: "Commit Decision",
    summary: "Summary",
  }

  const phaseByName = new Map(
    trace.phases.map((p) => [p.phase, p]),
  )

  const invariantsPhase = phaseByName.get("four_invariants")

  // Detect violations: writes before invariants completed
  const violations: string[] = []
  if (invariantsPhase) {
    const invariantsTime = new Date(invariantsPhase.timestamp).getTime()
    const writesBefore = trace.writes.filter(
      (w) => new Date(w.timestamp).getTime() < invariantsTime,
    )
    if (writesBefore.length > 0) {
      const fileList = writesBefore.map((w) => w.file).join(", ")
      violations.push(
        `${writesBefore.length} writes without invariants checkin (files: ${fileList})`,
      )
    }
  } else {
    violations.push(
      `${trace.writes.length} writes without invariants checkin (files: ${trace.writes.map((w) => w.file).join(", ")})`,
    )
  }

  console.log(`Protocol Compliance: ${id}`)
  for (const phase of REQUIRED_PHASES) {
    const record = phaseByName.get(phase)
    const name = DISPLAY_NAMES[phase] ?? phase
    if (record) {
      console.log(`  [PASS] ${name.padEnd(20)} - completed at ${record.timestamp}`)
    } else {
      console.log(`  [FAIL] ${name.padEnd(20)} - not completed`)
    }
  }

  if (violations.length > 0) {
    console.log("")
    console.log("  Violations:")
    for (const v of violations) {
      console.log(`  - ${v}`)
    }
  }
  return 0
}

async function cmdGate(): Promise<number> {
  const args = process.argv.slice(2)

  let minScore = 70
  let sessionId: string | null = null

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--min-score" && args[i + 1]) {
      const val = parseInt(args[i + 1], 10)
      if (!isNaN(val) && val >= 0 && val <= 100) {
        minScore = val
        i++
      }
    } else if (args[i] === "--session" && args[i + 1]) {
      sessionId = args[i + 1]
      i++
    } else if (args[i] === "--last") {
      // --last is the default behavior
    }
  }

  if (sessionId) {
    const trace = loadTrace(sessionId)
    if (!trace) {
      console.error(`Trace not found: ${sessionId}`)
      return 1
    }
    const score = computeCoherenceScore(trace)
    console.log(`Session: ${sessionId}`)
    console.log(`Coherence Score: ${score.total}/100 (${scoreToGrade(score.total)})`)
    console.log(`Threshold: ${minScore}/100`)
    if (score.total >= minScore) {
      console.log(`Result: PASS`)
      return 0
    }
    console.log(`Result: FAIL`)
    return 1
  }

  const files = listTraceFiles()
  if (files.length === 0) {
    console.error("No traces found")
    return 2
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const mostRecent = files[0]
  const trace = loadTrace(mostRecent.sessionId)
  if (!trace) {
    console.error(`Failed to load trace: ${mostRecent.sessionId}`)
    return 1
  }

  const score = computeCoherenceScore(trace)
  console.log(`Session: ${mostRecent.sessionId}`)
  console.log(`Coherence Score: ${score.total}/100 (${scoreToGrade(score.total)})`)
  console.log(`Threshold: ${minScore}/100`)

  if (score.total >= minScore) {
    console.log(`Result: PASS`)
    return 0
  }
  console.log(`Result: FAIL`)
  return 1
}

async function cmdPreCommit(): Promise<number> {
  const gitDir = join(process.cwd(), ".git")
  if (!existsSync(gitDir)) {
    console.log("Parallax pre-commit: skipped (not in a git repository)")
    return 0
  }

  const files = listTraceFiles()
  if (files.length === 0) {
    console.log("Parallax pre-commit: skipped (no traces found)")
    return 0
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
  const mostRecent = files[0]
  const trace = loadTrace(mostRecent.sessionId)
  if (!trace) {
    console.log("Parallax pre-commit: skipped (failed to load trace)")
    return 0
  }

  const score = computeCoherenceScore(trace)
  const pass = score.total >= 70

  console.log(`Parallax gate: score ${score.total}/100 (${pass ? "PASS" : "FAIL"})`)

  return pass ? 0 : 1
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    showHelp()
    return 0
  }

  const cmd = args[0]

  switch (cmd) {
    case "help":
      showHelp()
      return 0

    case "version":
    case "--version":
    case "-v":
      showVersion()
      return 0

    case "init":
      return cmdInit()

    case "trace": {
      const sub = args[1]
      switch (sub) {
        case "list":
          return cmdTraceList()
        case "show":
          if (!args[2]) {
            console.error("Usage: parallax trace show <session-id>")
            return 1
          }
          return cmdTraceShow(args[2])
        case "score":
          if (!args[2]) {
            console.error("Usage: parallax trace score <session-id>")
            return 1
          }
          return cmdTraceScore(args[2])
        case "export":
          if (!args[2]) {
            console.error("Usage: parallax trace export <session-id>")
            return 1
          }
          return cmdTraceExport(args[2])
        case "trend":
          return cmdTraceTrend()
        case "report":
          return cmdTraceReport()
        case "compare":
          if (!args[2] || !args[3]) {
            console.error("Usage: parallax trace compare <session-a> <session-b>")
            return 1
          }
          return cmdTraceCompare(args[2], args[3])
        case "compliance":
          if (!args[2]) {
            console.error("Usage: parallax trace compliance <session-id>")
            return 1
          }
          return cmdTraceCompliance(args[2])
        default:
          console.error(`Unknown trace command: ${sub}`)
          console.error("Usage: parallax trace <list|show|score|export|trend|report|compare|compliance>")
          return 1
      }
    }

    case "gate":
      return cmdGate()

    case "pre-commit":
      return cmdPreCommit()

    default:
      console.error(`Unknown command: ${cmd}`)
      console.error("Run 'parallax help' for usage.")
      return 1
  }
}

// Run the CLI if this is the entry point
// Detected by checking if process.argv[1] ends with cli.ts or cli.js
const isMain =
  process.argv[1]?.endsWith("cli.ts") ||
  process.argv[1]?.endsWith("cli.js") ||
  process.argv[1]?.endsWith("parallax-engine") ||
  process.argv[1]?.endsWith("parallax-engine.js")

if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
