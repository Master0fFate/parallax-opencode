/**
 * PARALLAX ENGINE -- Project Detection
 *
 * Detects the project type in the current working directory and returns
 * the appropriate verification command.
 *
 * License: MIT
 * Copyright (c) 2026 Master0fFate
 */

import { existsSync, statSync } from "fs"
import type { ProjectType, VerifyResult } from "./types.js"

/**
 * Detect the project type based on files present in the current directory.
 */
export function detectProject(): ProjectType {
  try {
    if (existsSync("Cargo.toml")) return "cargo"
    if (existsSync("package.json")) {
      if (existsSync("node_modules") && statSync("node_modules").isDirectory()) {
        if (existsSync("tsconfig.json")) return "tsc"
        return "lint"
      }
    }
    if (existsSync("pyproject.toml") || existsSync("requirements.txt")) return "python"
    return null
  } catch {
    return null
  }
}

/**
 * Get the shell command string for verification based on project type.
 */
export function getVerifyCommand(): string | null {
  switch (detectProject()) {
    case "cargo": return "cargo check --color=never --all-targets --all-features 2>&1"
    case "tsc": return "npx tsc --noEmit 2>&1"
    case "lint": return "npm run lint 2>&1"
    case "python": return "python -m compileall -q . 2>&1"
    default: return null
  }
}

/**
 * Run the verification command synchronously using Bun.spawnSync.
 * Returns null if no known project type is detected.
 */
export function runVerify(): VerifyResult | null {
  try {
    const cmd = getVerifyCommand()
    if (!cmd) return null
    const shell = process.platform === "win32" ? "cmd" : "sh"
    const flag = process.platform === "win32" ? "/C" : "-c"
    const proc = Bun.spawnSync([shell, flag, cmd], { cwd: process.cwd() })
    const stdout = proc.stdout.toString()
    const stderr = proc.stderr.toString()
    const combined = stderr ? `${stdout}\n${stderr}` : stdout
    return { exitCode: proc.exitCode, stdout, stderr, combined }
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: String(e), combined: String(e) }
  }
}
