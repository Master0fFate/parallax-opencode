import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { effectiveParallaxConfig, loadEffectiveParallaxConfig, validateParallaxConfig } from "../config.js"

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("effective Parallax configuration", () => {
  it("applies validated defaults without sharing arrays", () => {
    const first = effectiveParallaxConfig({ strictness: "relaxed", minScore: 80 })
    const second = effectiveParallaxConfig()
    expect(first).toMatchObject({ strictness: "relaxed", minScore: 80, designDocRequired: false })
    first.trivialPatterns.push("*.md")
    expect(second.trivialPatterns).toEqual([])
  })

  it("rejects malformed values", () => {
    expect(() => validateParallaxConfig({ strictness: "fast" })).toThrow("strictness")
    expect(() => validateParallaxConfig({ minScore: -1 })).toThrow("minScore")
    expect(() => validateParallaxConfig({ highRiskPatterns: [42] })).toThrow("array of strings")
    expect(() => validateParallaxConfig({ strictness: { toString: () => "strict" } })).toThrow("strictness")
    expect(() => validateParallaxConfig({ minSore: 80 })).toThrow("unknown field")
  })

  it("loads a project config and fails explicitly on invalid JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "parallax-config-")); roots.push(root)
    mkdirSync(join(root, ".parallax"))
    writeFileSync(join(root, ".parallax", "config.json"), JSON.stringify({ designDocRequired: true }))
    expect(loadEffectiveParallaxConfig(root).designDocRequired).toBe(true)
    writeFileSync(join(root, ".parallax", "config.json"), "{oops")
    expect(() => loadEffectiveParallaxConfig(root)).toThrow("Invalid JSON")
  })
})
