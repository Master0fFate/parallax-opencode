import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
}))

import { spawnSync } from "node:child_process"
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_OUTPUT_CHARS,
  detectProject,
  discoverVerification,
  runVerification,
  runVerify,
} from "../detect.js"

let root: string

function file(name: string, contents = ""): void {
  writeFileSync(join(root, name), contents, "utf8")
}

function packageJson(value: Record<string, unknown>): void {
  file("package.json", JSON.stringify(value))
}

describe("production verification discovery and execution", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    root = mkdtempSync(join(tmpdir(), "parallax-detect-"))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("detects supported projects without requiring installed dependencies", () => {
    file("Cargo.toml")
    expect(detectProject(root)).toBe("cargo")
    rmSync(join(root, "Cargo.toml"))
    packageJson({ scripts: { test: "vitest run" } })
    file("tsconfig.json")
    expect(detectProject(root)).toBe("tsc")
    rmSync(join(root, "package.json"))
    rmSync(join(root, "tsconfig.json"))
    file("pyproject.toml")
    expect(detectProject(root)).toBe("python")
  })

  it("chooses a declared script and package manager deterministically", () => {
    packageJson({
      packageManager: "pnpm@9.15.0",
      scripts: { lint: "eslint .", test: "vitest run", verify: "npm test && npm run lint" },
    })
    file("package-lock.json")
    const plan = discoverVerification(root)
    expect(plan).toMatchObject({
      packageManager: "pnpm",
      script: "verify",
      command: "pnpm",
      args: ["run", "verify"],
      cwd: root,
    })
  })

  it("uses fixed safe commands for non-Node projects", () => {
    file("Cargo.toml")
    expect(discoverVerification(root)).toMatchObject({
      command: "cargo",
      args: ["check", "--color=never", "--all-targets", "--all-features"],
    })
  })

  it("returns an explicit skipped receipt rather than passing unknown projects", () => {
    const receipt = runVerification({ directory: root, sessionId: "s", source: "manual" })
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      verdict: "skipped",
      exitCode: null,
      command: null,
      args: [],
      cwd: root,
    })
    expect(receipt.skipReason).toBeTruthy()
  })

  it("records complete bounded execution evidence", () => {
    packageJson({ scripts: { test: "vitest run" } })
    const receipt = runVerification({
      directory: root,
      sessionId: "session-1",
      source: "automatic",
      changedFiles: ["b.ts", "a.ts", "a.ts"],
      timeoutMs: 3210,
    })
    expect(receipt).toMatchObject({
      schemaVersion: 2,
      sessionId: "session-1",
      source: "automatic",
      command: "npm",
      args: ["run", "test"],
      cwd: root,
      timeoutMs: 3210,
      exitCode: 0,
      verdict: "pass",
      changedFiles: ["a.ts", "b.ts"],
      stdout: "ok",
      skipReason: null,
    })
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0)
    const expectedCommand = process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe"
      : "npm"
    const expectedArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "run", "test"]
      : ["run", "test"]
    expect(spawnSync).toHaveBeenCalledWith(
      expectedCommand,
      expectedArgs,
      expect.objectContaining({ cwd: root, timeout: 3210, shell: false }),
    )
  })

  it("bounds command output and marks truncation", () => {
    packageJson({ scripts: { test: "test" } })
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: 1,
      stdout: "x".repeat(MAX_VERIFY_OUTPUT_CHARS * 2),
      stderr: "y".repeat(MAX_VERIFY_OUTPUT_CHARS * 2),
    } as never)
    const receipt = runVerification({ directory: root, sessionId: "s", source: "manual" })
    expect(receipt.verdict).toBe("fail")
    expect(receipt.combined.length).toBeLessThanOrEqual(MAX_VERIFY_OUTPUT_CHARS)
    expect(receipt.outputTruncated).toBe(true)
  })

  it("records timeouts and missing exit codes as unknown rather than pass", () => {
    packageJson({ scripts: { test: "test" } })
    const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      stdout: "partial",
      stderr: "",
      error: timeout,
    } as never)
    const timedOut = runVerification({
      directory: root,
      sessionId: "s",
      source: "automatic",
      timeoutMs: Number.NaN,
    })
    expect(timedOut).toMatchObject({
      verdict: "unknown",
      timedOut: true,
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
      exitCode: null,
    })
    expect(timedOut.skipReason).toContain("timeout")

    vi.mocked(spawnSync).mockReturnValueOnce({ status: null, stdout: "", stderr: "" } as never)
    const terminated = runVerification({ directory: root, sessionId: "s", source: "manual" })
    expect(terminated).toMatchObject({
      verdict: "unknown",
      exitCode: null,
      skipReason: "Verification terminated without an exit code",
    })
  })

  it("keeps the legacy adapter without losing non-pass semantics", () => {
    packageJson({ scripts: { test: "test" } })
    expect(runVerify(root)?.exitCode).toBe(0)
    rmSync(join(root, "package.json"))
    expect(runVerify(root)).toBeNull()
  })
})
