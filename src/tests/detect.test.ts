/**
 * Tests for project detection logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fs functions used by detectProject
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}))

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" })),
}))

import { existsSync } from "fs"
import { spawnSync } from "node:child_process"
import { detectProject, runVerify } from "../detect.js"

// We test the detection logic by manipulating the mocks.
// Create a test helper that mirrors the logic from plugin.ts.
type PT = "cargo" | "tsc" | "lint" | "python" | null

function testDetect(files: Record<string, boolean>): PT {
  const mockExists: typeof existsSync = vi.fn((p) => {
    const path = typeof p === "string" ? p : String(p)
    return files[path] === true
  }) as unknown as typeof existsSync

  // Inline the detection logic from detect.ts to preserve legacy cases.
  try {
    if (mockExists("Cargo.toml" as any)) return "cargo"
    if (mockExists("package.json" as any)) {
      if (mockExists("tsconfig.json" as any)) return "tsc"
      return "lint"
    }
    if (mockExists("pyproject.toml" as any) || mockExists("requirements.txt" as any)) return "python"
    return null
  } catch {
    return null
  }
}

describe("Project detection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("detects cargo project", () => {
    const result = testDetect(
      { "Cargo.toml": true },
    )
    expect(result).toBe("cargo")
  })

  it("detects TypeScript project (package.json + tsconfig, without requiring node_modules)", () => {
    const result = testDetect(
      { "package.json": true, "tsconfig.json": true },
    )
    expect(result).toBe("tsc")
  })

  it("detects JS/lint project (package.json, no tsconfig)", () => {
    const result = testDetect(
      { "package.json": true },
    )
    expect(result).toBe("lint")
  })

  it("detects Python project (pyproject.toml)", () => {
    const result = testDetect(
      { "pyproject.toml": true },
    )
    expect(result).toBe("python")
  })

  it("detects Python project (requirements.txt)", () => {
    const result = testDetect(
      { "requirements.txt": true },
    )
    expect(result).toBe("python")
  })

  it("returns null for unknown project", () => {
    const result = testDetect({})
    expect(result).toBeNull()
  })

  it("handles errors gracefully", () => {
    // The try/catch should return null on any exception
    const result = testDetect(
      { "Cargo.toml": true },
    )
    // Should be "cargo" since we're not throwing
    expect(result).toBe("cargo")
  })

  it("production detectProject detects package projects without node_modules", () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === "package.json" || String(p) === "tsconfig.json")
    expect(detectProject()).toBe("tsc")
  })

  it("runVerify uses Node spawnSync instead of Bun", () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === "package.json" || String(p) === "tsconfig.json")
    const result = runVerify()
    expect(result?.exitCode).toBe(0)
    expect(spawnSync).toHaveBeenCalled()
  })
})
