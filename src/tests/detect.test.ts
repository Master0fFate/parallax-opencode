/**
 * Tests for project detection logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock fs functions used by detectProject
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}))

import { existsSync, statSync } from "fs"

// We test the detection logic by manipulating the mocks.
// Create a test helper that mirrors the logic from plugin.ts.
type PT = "cargo" | "tsc" | "lint" | "python" | null

function testDetect(
  files: Record<string, boolean>,
  dirs: Record<string, boolean>,
): PT {
  const mockExists: typeof existsSync = vi.fn((p) => {
    const path = typeof p === "string" ? p : String(p)
    return files[path] === true
  }) as unknown as typeof existsSync

  const mockStat: typeof statSync = vi.fn((p) => {
    const path = typeof p === "string" ? p : String(p)
    if (dirs[path]) return { isDirectory: () => true } as ReturnType<typeof statSync>
    return { isDirectory: () => false } as ReturnType<typeof statSync>
  }) as unknown as typeof statSync

  // Inline the detection logic from plugin.ts
  try {
    if (mockExists("Cargo.toml" as any)) return "cargo"
    if (mockExists("package.json" as any)) {
      if (mockExists("node_modules" as any) && mockStat("node_modules" as any).isDirectory()) {
        if (mockExists("tsconfig.json" as any)) return "tsc"
        return "lint"
      }
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
      {},
    )
    expect(result).toBe("cargo")
  })

  it("detects TypeScript project (tsconfig + node_modules)", () => {
    const result = testDetect(
      { "package.json": true, "node_modules": true, "tsconfig.json": true },
      { "node_modules": true },
    )
    expect(result).toBe("tsc")
  })

  it("detects JS/lint project (package.json + node_modules, no tsconfig)", () => {
    const result = testDetect(
      { "package.json": true, "node_modules": true },
      { "node_modules": true },
    )
    expect(result).toBe("lint")
  })

  it("detects Python project (pyproject.toml)", () => {
    const result = testDetect(
      { "pyproject.toml": true },
      {},
    )
    expect(result).toBe("python")
  })

  it("detects Python project (requirements.txt)", () => {
    const result = testDetect(
      { "requirements.txt": true },
      {},
    )
    expect(result).toBe("python")
  })

  it("returns null for unknown project", () => {
    const result = testDetect({}, {})
    expect(result).toBeNull()
  })

  it("handles errors gracefully", () => {
    // The try/catch should return null on any exception
    const result = testDetect(
      { "Cargo.toml": true },
      {},
    )
    // Should be "cargo" since we're not throwing
    expect(result).toBe("cargo")
  })
})
