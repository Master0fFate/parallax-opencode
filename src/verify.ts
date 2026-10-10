import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import type { Check, Receipt, Verdict } from "./types.js"
import { appendLine, parallaxDir, readLines } from "./fs.js"

export const MAX_OUTPUT = 16_384
const SCRIPTS = ["verify", "test", "typecheck", "check", "lint", "build"]
const MANAGERS = ["npm", "pnpm", "yarn", "bun"]
const VERDICTS: Verdict[] = ["pass", "fail", "skipped", "unknown"]

function has(root: string, name: string): boolean {
  return existsSync(join(root, name))
}

export function discoverCheck(directory: string): Check | null {
  const cwd = resolve(directory)
  if (has(cwd, "Cargo.toml")) return { command: "cargo", args: ["check", "--color=never", "--all-targets", "--all-features"], cwd }
  if (has(cwd, "package.json")) {
    let pkg: unknown
    try {
      pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))
    } catch {
      return null
    }
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return null
    const manifest = pkg as Record<string, unknown>
    const scripts = (manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {}) as Record<string, unknown>
    const script = SCRIPTS.find((name) => typeof scripts[name] === "string" && (scripts[name] as string).trim().length > 0)
    if (!script) return null
    const declared = typeof manifest.packageManager === "string" ? manifest.packageManager.split("@")[0] : ""
    const manager = MANAGERS.includes(declared) ? declared
      : has(cwd, "pnpm-lock.yaml") ? "pnpm"
        : has(cwd, "yarn.lock") ? "yarn"
          : has(cwd, "bun.lock") || has(cwd, "bun.lockb") ? "bun"
            : "npm"
    return { command: manager, args: ["run", script], cwd }
  }
  if (has(cwd, "go.mod")) return { command: "go", args: ["vet", "./..."], cwd }
  if (has(cwd, "pyproject.toml") || has(cwd, "requirements.txt")) return { command: "python", args: ["-m", "compileall", "-q", "."], cwd }
  return null
}

function executable(check: Check): { command: string; args: string[] } {
  if (process.platform === "win32" && MANAGERS.includes(check.command)) {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", check.command, ...check.args] }
  }
  return { command: check.command, args: check.args }
}

function bound(text: string): { output: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { output: text, truncated: false }
  return { output: `${text.slice(0, MAX_OUTPUT)}\n[truncated at ${MAX_OUTPUT} chars]`, truncated: true }
}

export interface RunOptions {
  cwd: string
  session: string
  files?: Iterable<string>
  timeoutMs?: number
}

export function runCheck(options: RunOptions): Promise<Receipt> {
  const cwd = resolve(options.cwd)
  const requested = options.timeoutMs
  const timeoutMs = Number.isFinite(requested) ? Math.min(2_147_483_647, Math.max(1, Math.floor(requested as number))) : 120_000
  const started = Date.now()
  const base = {
    v: 3 as const,
    id: randomUUID(),
    session: options.session,
    at: new Date(started).toISOString(),
    cwd,
    timeoutMs,
    files: [...new Set([...options.files ?? []].filter((file) => typeof file === "string" && file.length > 0))].sort(),
  }
  const check = discoverCheck(cwd)
  if (!check) {
    return Promise.resolve({
      ...base, command: null, args: [], durationMs: 0, exitCode: null, verdict: "skipped",
      output: "", truncated: false, timedOut: false, reason: "no supported project check was found",
    })
  }
  return new Promise((done) => {
    const { command, args } = executable(check)
    let out = ""
    let timedOut = false
    let failure: Error | null = null
    let settled = false
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      const { output, truncated } = bound(out)
      const verdict: Verdict = timedOut || failure || exitCode === null ? "unknown" : exitCode === 0 ? "pass" : "fail"
      done({
        ...base, command: check.command, args: check.args, durationMs: Date.now() - started, exitCode, verdict, output, truncated, timedOut,
        reason: timedOut ? `check exceeded ${timeoutMs}ms`
          : failure ? `check could not start: ${failure.message}`
            : exitCode === null ? "check ended without an exit code" : null,
      })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      failure = error as Error
      return finish(null)
    }
    const collect = (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT * 4) out += chunk.toString("utf8")
    }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    const kill = () => {
      try {
        if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        else if (child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      setTimeout(() => finish(null), 1_000).unref()
    }, timeoutMs)
    child.once("error", (error) => {
      failure = error
      clearTimeout(timer)
      finish(null)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      finish(code)
    })
  })
}

export function ledgerPath(root: string): string {
  return join(resolve(root), ".parallax", "receipts.jsonl")
}

export function isReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  const str = (key: string) => typeof r[key] === "string"
  const coherent =
    (r.verdict === "pass" && str("command") && r.exitCode === 0 && r.timedOut === false && r.reason === null) ||
    (r.verdict === "fail" && str("command") && typeof r.exitCode === "number" && r.exitCode !== 0 && r.timedOut === false && r.reason === null) ||
    (r.verdict === "skipped" && r.command === null && r.exitCode === null && str("reason")) ||
    (r.verdict === "unknown" && str("command") && str("reason"))
  return coherent && r.v === 3 && str("id") && (r.id as string).length > 0 && str("session") && str("at") && str("cwd") &&
    Array.isArray(r.args) && r.args.every((arg) => typeof arg === "string") &&
    Number.isFinite(r.timeoutMs) && Number.isFinite(r.durationMs) &&
    (r.exitCode === null || Number.isInteger(r.exitCode)) &&
    VERDICTS.includes(r.verdict as Verdict) &&
    Array.isArray(r.files) && r.files.every((file) => typeof file === "string") &&
    str("output") && typeof r.truncated === "boolean" && typeof r.timedOut === "boolean"
}

export function appendReceipt(receipt: Receipt, root = receipt.cwd): void {
  if (!isReceipt(receipt)) throw new TypeError("invalid or internally inconsistent receipt")
  parallaxDir(root)
  appendLine(ledgerPath(root), receipt)
}

export function readReceipts(root: string, session?: string): Receipt[] {
  const receipts = readLines(ledgerPath(root), isReceipt)
  return session ? receipts.filter((receipt) => receipt.session === session) : receipts
}

export async function verify(options: RunOptions): Promise<Receipt> {
  const receipt = await runCheck(options)
  appendReceipt(receipt, options.cwd)
  return receipt
}
