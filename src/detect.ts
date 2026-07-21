/**
 * Project discovery and bounded verification execution.
 *
 * Discovery never evaluates package metadata or invokes a shell. Node projects
 * use a declared package script and a deterministic package-manager choice;
 * non-Node projects retain fixed, argument-separated safe commands.
 */

import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import type {
  ProjectType,
  VerificationCommand,
  VerificationReceipt,
  VerificationSource,
  VerifyResult,
} from "./types.js"

export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
export const MAX_VERIFY_OUTPUT_CHARS = 16_384
const MAX_CAPTURE_BYTES = 64 * 1024
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_REASON_CHARS = 2_048
const NODE_SCRIPT_PRIORITY = ["verify", "test", "typecheck", "check", "lint", "build"] as const
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const

type PackageManager = (typeof PACKAGE_MANAGERS)[number]

function at(root: string, name: string): string {
  return join(root, name)
}

/** Detect the broad project type without requiring installed dependencies. */
export function detectProject(directory?: string): ProjectType {
  const root = resolve(directory || process.cwd())
  try {
    if (existsSync(at(root, "Cargo.toml"))) return "cargo"
    if (existsSync(at(root, "package.json"))) {
      return existsSync(at(root, "tsconfig.json")) ? "tsc" : "lint"
    }
    if (existsSync(at(root, "pyproject.toml")) || existsSync(at(root, "requirements.txt"))) {
      return "python"
    }
    return null
  } catch {
    return null
  }
}

function readPackage(root: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(at(root, "package.json"), "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function declaredManager(pkg: Record<string, unknown>): PackageManager | null {
  if (typeof pkg.packageManager !== "string") return null
  const name = pkg.packageManager.split("@")[0]
  return PACKAGE_MANAGERS.includes(name as PackageManager) ? name as PackageManager : null
}

function detectPackageManager(root: string, pkg: Record<string, unknown>): PackageManager {
  const declared = declaredManager(pkg)
  if (declared) return declared
  // Fixed precedence makes even accidentally mixed-lockfile repositories stable.
  if (existsSync(at(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(at(root, "yarn.lock"))) return "yarn"
  if (existsSync(at(root, "bun.lock")) || existsSync(at(root, "bun.lockb"))) return "bun"
  return "npm"
}

/** Discover exactly what will be executed. Returns null when no safe check exists. */
export function discoverVerification(directory?: string): VerificationCommand | null {
  const root = resolve(directory || process.cwd())
  const projectType = detectProject(root)
  if (!projectType) return null

  if (projectType === "cargo") {
    return {
      projectType,
      packageManager: null,
      script: null,
      command: "cargo",
      args: ["check", "--color=never", "--all-targets", "--all-features"],
      cwd: root,
    }
  }
  if (projectType === "python") {
    return {
      projectType,
      packageManager: null,
      script: null,
      command: "python",
      args: ["-m", "compileall", "-q", "."],
      cwd: root,
    }
  }

  const pkg = readPackage(root)
  if (!pkg) return null
  const scripts = pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)
    ? pkg.scripts as Record<string, unknown>
    : {}
  const script = NODE_SCRIPT_PRIORITY.find((name) =>
    typeof scripts[name] === "string" && (scripts[name] as string).trim().length > 0
  )
  if (!script) return null
  const manager = detectPackageManager(root, pkg)
  return {
    projectType,
    packageManager: manager,
    script,
    command: manager,
    args: ["run", script],
    cwd: root,
  }
}

/** Human-readable compatibility helper for the discovered project command. */
export function getVerifyCommand(directory?: string): string | null {
  const plan = discoverVerification(directory)
  return plan ? [plan.command, ...plan.args].join(" ") : null
}

function bounded(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false }
  const marker = `\n[output truncated at ${max} characters]`
  return { value: value.slice(0, Math.max(0, max - marker.length)) + marker, truncated: true }
}

function boundedReason(value: string): string {
  return bounded(value, MAX_REASON_CHARS).value
}

function verificationTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VERIFY_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(value)))
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started)
}

function executable(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32" && ["npm", "pnpm", "yarn", "bun"].includes(command)) {
    // Node cannot spawn .cmd shims directly on Windows (EINVAL). Use cmd with
    // autorun disabled; every token here is selected by discovery, not user input.
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    }
  }
  return { command, args }
}

export interface RunVerificationOptions {
  directory?: string
  sessionId: string
  source: VerificationSource
  changedFiles?: Iterable<string>
  timeoutMs?: number
}

/**
 * Execute one bounded verification and always return a schema-v2 receipt.
 * Missing/invalid projects are explicit skipped receipts, never synthetic pass.
 */
export function runVerification(options: RunVerificationOptions): VerificationReceipt {
  const cwd = resolve(options.directory || process.cwd())
  const timeoutMs = verificationTimeout(options.timeoutMs)
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const changedFiles = [...new Set([...options.changedFiles || []].map(String))].sort()
  const base = {
    schemaVersion: 2 as const,
    id: randomUUID(),
    sessionId: options.sessionId,
    source: options.source,
    startedAt,
    cwd,
    timeoutMs,
    changedFiles,
  }

  let plan: VerificationCommand | null = null
  try {
    plan = discoverVerification(cwd)
  } catch {
    // Discovery errors are represented below as a skip, not a pass.
  }
  if (!plan) {
    return {
      ...base,
      command: null,
      args: [],
      durationMs: elapsed(started),
      exitCode: null,
      verdict: "skipped",
      stdout: "",
      stderr: "",
      combined: "",
      outputTruncated: false,
      timedOut: false,
      skipReason: detectProject(cwd)
        ? "No declared safe verification script could be discovered"
        : "Unsupported or unknown project type",
    }
  }

  try {
    const invocation = executable(plan.command, plan.args)
    const proc = spawnSync(invocation.command, invocation.args, {
      cwd: plan.cwd,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
    })
    const rawStdout = String(proc.stdout ?? "")
    const rawStderr = String(proc.stderr ?? "")
    const stdout = bounded(rawStdout, MAX_VERIFY_OUTPUT_CHARS / 2)
    const stderr = bounded(rawStderr, MAX_VERIFY_OUTPUT_CHARS / 2)
    const combined = bounded(rawStderr ? `${rawStdout}${rawStdout && !rawStdout.endsWith("\n") ? "\n" : ""}${rawStderr}` : rawStdout, MAX_VERIFY_OUTPUT_CHARS)
    const timedOut = proc.error?.name === "ETIMEDOUT" || (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
    const executionError = Boolean(proc.error) && !timedOut
    const exitCode = typeof proc.status === "number" ? proc.status : null
    const missingExitCode = exitCode === null
    return {
      ...base,
      command: plan.command,
      args: [...plan.args],
      durationMs: elapsed(started),
      exitCode,
      verdict: timedOut || executionError || missingExitCode ? "unknown" : exitCode === 0 ? "pass" : "fail",
      stdout: stdout.value,
      stderr: stderr.value,
      combined: combined.value,
      outputTruncated: stdout.truncated || stderr.truncated || combined.truncated,
      timedOut,
      skipReason: timedOut
        ? `Verification exceeded its ${timeoutMs}ms timeout`
        : executionError
          ? boundedReason(`Verification could not execute: ${proc.error?.message || "unknown spawn error"}`)
          : missingExitCode
            ? "Verification terminated without an exit code"
            : null,
    }
  } catch (error) {
    return {
      ...base,
      command: plan.command,
      args: [...plan.args],
      durationMs: elapsed(started),
      exitCode: null,
      verdict: "unknown",
      stdout: "",
      stderr: "",
      combined: "",
      outputTruncated: false,
      timedOut: false,
      skipReason: boundedReason(`Verification engine error: ${String(error)}`),
    }
  }
}

/** Legacy adapter. New code should use runVerification so skips are retained. */
export function runVerify(directory?: string): VerifyResult | null {
  const receipt = runVerification({
    directory,
    sessionId: "legacy",
    source: "manual",
  })
  if (receipt.verdict === "skipped") return null
  return {
    exitCode: receipt.exitCode ?? -1,
    stdout: receipt.stdout,
    stderr: receipt.stderr || receipt.skipReason || "",
    combined: receipt.combined || receipt.skipReason || "",
  }
}
