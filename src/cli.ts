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
        default:
          console.error(`Unknown trace command: ${sub}`)
          console.error("Usage: parallax trace <list|show|score|export|trend>")
          return 1
      }
    }

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
