import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { appendReceipt, discoverCheck, isReceipt, readReceipts, runCheck, verify } from "../verify.js"
import { FAIL, PASS, project, remove, tempDir } from "./helpers.js"

const dirs: string[] = []
const fresh = () => {
  const dir = tempDir("parallax-verify")
  dirs.push(dir)
  return dir
}
after(() => dirs.forEach(remove))

describe("check discovery", () => {
  it("prefers declared node scripts in priority order with the lockfile manager", () => {
    const root = fresh()
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "x", lint: "y", typecheck: "z" } }))
    writeFileSync(join(root, "pnpm-lock.yaml"), "")
    assert.deepEqual(discoverCheck(root), { command: "pnpm", args: ["run", "typecheck"], cwd: root })
    writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.2.0", scripts: { test: "t", verify: "v" } }))
    assert.deepEqual(discoverCheck(root)?.command, "bun")
    assert.deepEqual(discoverCheck(root)?.args, ["run", "verify"])
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { start: "node ." } }))
    assert.equal(discoverCheck(root), null)
    writeFileSync(join(root, "package.json"), "{")
    assert.equal(discoverCheck(root), null)
  })

  it("uses fixed argument-separated commands for other ecosystems", () => {
    const cargo = fresh()
    writeFileSync(join(cargo, "Cargo.toml"), "")
    assert.equal(discoverCheck(cargo)?.command, "cargo")
    const go = fresh()
    writeFileSync(join(go, "go.mod"), "module x")
    assert.deepEqual(discoverCheck(go)?.args, ["vet", "./..."])
    const py = fresh()
    writeFileSync(join(py, "pyproject.toml"), "")
    assert.equal(discoverCheck(py)?.command, "python")
    assert.equal(discoverCheck(fresh()), null)
  })
})

describe("bounded execution", () => {
  it("records a pass with the command, duration, files, and exit code", async () => {
    const root = fresh()
    project(root, PASS)
    const receipt = await runCheck({ cwd: root, session: "s1", files: ["b.ts", "a.ts", "a.ts"] })
    assert.equal(receipt.verdict, "pass")
    assert.equal(receipt.exitCode, 0)
    assert.deepEqual(receipt.files, ["a.ts", "b.ts"])
    assert.equal(receipt.command, "npm")
    assert.ok(receipt.durationMs >= 0)
    assert.ok(isReceipt(receipt))
  })

  it("records a fail with captured output", async () => {
    const root = fresh()
    project(root, FAIL)
    const receipt = await runCheck({ cwd: root, session: "s1" })
    assert.equal(receipt.verdict, "fail")
    assert.equal(receipt.exitCode, 1)
    assert.match(receipt.output, /boom/)
  })

  it("skips unsupported projects explicitly instead of passing", async () => {
    const receipt = await runCheck({ cwd: fresh(), session: "s1" })
    assert.equal(receipt.verdict, "skipped")
    assert.equal(receipt.command, null)
    assert.match(receipt.reason ?? "", /no supported project check/)
  })

  it("marks timeouts as unknown and kills the process tree", async () => {
    const root = fresh()
    project(root, 'node -e "setTimeout(() => {}, 20000)"')
    const receipt = await runCheck({ cwd: root, session: "s1", timeoutMs: 1500 })
    assert.equal(receipt.verdict, "unknown")
    assert.equal(receipt.timedOut, true)
    assert.match(receipt.reason ?? "", /exceeded 1500ms/)
  })

  it("marks spawn failures as unknown", async () => {
    const root = fresh()
    writeFileSync(join(root, "go.mod"), "module x")
    const original = process.env.PATH
    process.env.PATH = root
    try {
      const receipt = await runCheck({ cwd: root, session: "s1" })
      assert.equal(receipt.verdict, "unknown")
      assert.match(receipt.reason ?? "", /could not start/)
    } finally {
      process.env.PATH = original
    }
  })
})

describe("ledger", () => {
  it("appends only coherent receipts and reads them back per session", async () => {
    const root = fresh()
    project(root, PASS)
    const receipt = await verify({ cwd: root, session: "s1" })
    await verify({ cwd: root, session: "s2" })
    assert.equal(readReceipts(root).length, 2)
    assert.deepEqual(readReceipts(root, "s1").map((entry) => entry.id), [receipt.id])
    assert.equal(readFileSync(join(root, ".parallax", ".gitignore"), "utf8"), "*\n")
    assert.throws(() => appendReceipt({ ...receipt, verdict: "pass", exitCode: 1 }), /inconsistent/)
    assert.throws(() => appendReceipt({ ...receipt, verdict: "skipped" }), /inconsistent/)
    assert.ok(!isReceipt({ ...receipt, v: 2 }))
  })

  it("ignores torn lines", () => {
    const root = fresh()
    mkdirSync(join(root, ".parallax"))
    writeFileSync(join(root, ".parallax", "receipts.jsonl"), '{"v":3,"id":"x"\n{"bad json\n')
    assert.deepEqual(readReceipts(root), [])
    assert.ok(!existsSync(join(root, ".parallax", "sessions")))
  })
})
