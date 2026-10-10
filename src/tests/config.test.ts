import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { DEFAULTS, gateFor, loadConfig, matches, validateConfig } from "../config.js"
import { globToRegExp } from "../fs.js"
import { remove, tempDir } from "./helpers.js"

const root = tempDir("parallax-config")
after(() => remove(root))

describe("config", () => {
  it("applies defaults and copies arrays", () => {
    const config = validateConfig({})
    assert.deepEqual(config, { ...DEFAULTS, trivialPatterns: [] as string[], highRiskPatterns: [] as string[] })
    config.trivialPatterns.push("x")
    assert.equal(DEFAULTS.trivialPatterns.length, 0)
  })

  it("rejects unknown fields and malformed values", () => {
    assert.throws(() => validateConfig({ minScore: 70 }), /unknown field: minScore/)
    assert.throws(() => validateConfig({ strictness: "loose" }), /strictness/)
    assert.throws(() => validateConfig({ trivialPatterns: ["a", 1] }), /trivialPatterns/)
    assert.throws(() => validateConfig({ timeoutMs: 10 }), /timeoutMs/)
    assert.throws(() => validateConfig([]), /JSON object/)
  })

  it("loads a project file and fails explicitly on invalid JSON", () => {
    assert.equal(loadConfig(root).strictness, "strict")
    mkdirSync(join(root, ".parallax"), { recursive: true })
    writeFileSync(join(root, ".parallax", "config.json"), '{"strictness":"standard","highRiskPatterns":["src/auth/**"],"timeoutMs":5000}')
    assert.deepEqual(loadConfig(root), { strictness: "standard", trivialPatterns: [], highRiskPatterns: ["src/auth/**"], timeoutMs: 5000 })
    writeFileSync(join(root, ".parallax", "config.json"), "{")
    assert.throws(() => loadConfig(root), /Invalid JSON/)
  })

  it("matches globs against relative paths and basenames", () => {
    assert.ok(globToRegExp("*.md").test("README.md"))
    assert.ok(!globToRegExp("*.md").test("docs/a.md"))
    assert.ok(globToRegExp("docs/**").test("docs/a/b.md"))
    assert.ok(globToRegExp("src/**/*.test.ts").test("src/tests/x.test.ts"))
    assert.ok(globToRegExp("src/**/*.test.ts").test("src/x.test.ts"))
    assert.ok(matches(["*.md"], root, join(root, "docs", "guide.md")))
    assert.ok(matches(["src/auth/**"], root, "src/auth/token.ts"))
    assert.ok(!matches(["src/auth/**"], root, "src/other.ts"))
    assert.ok(!matches([], root, "anything"))
  })

  it("scales the gate with strictness and patterns", () => {
    const base = validateConfig({ trivialPatterns: ["*.md"], highRiskPatterns: ["src/auth/**"] })
    assert.equal(gateFor(base, root, ["src/a.ts"]), "block")
    assert.equal(gateFor(base, root, ["README.md"]), "track")
    assert.equal(gateFor(base, root, ["README.md", "src/a.ts"]), "block")
    assert.equal(gateFor({ ...base, trivialPatterns: ["**"] }, root, ["src/auth/x.ts"]), "block")
    const standard = { ...base, strictness: "standard" as const }
    assert.equal(gateFor(standard, root, ["src/a.ts"]), "track")
    assert.equal(gateFor(standard, root, ["src/auth/x.ts"]), "block")
    assert.equal(gateFor({ ...base, strictness: "relaxed" }, root, ["src/auth/x.ts"]), "track")
  })
})
