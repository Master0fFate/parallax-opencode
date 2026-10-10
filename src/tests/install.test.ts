import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, describe, it } from "node:test"
import { remove, tempDir } from "./helpers.js"

const installer = fileURLToPath(new URL("../../scripts/install.mjs", import.meta.url))
const dirs: string[] = []
const fresh = () => {
  const dir = tempDir("parallax-install")
  dirs.push(dir)
  return dir
}
after(() => dirs.forEach(remove))

function run(args: string[], cwd = process.cwd()) {
  const result = spawnSync(process.execPath, [installer, ...args], { encoding: "utf8", cwd, env: { ...process.env, OPENCODE_CONFIG_DIR: "" } })
  return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
}

const config = (root: string, name = "opencode.json") => JSON.parse(readFileSync(join(root, name), "utf8"))

describe("installer lifecycle", () => {
  it("registers once, stays idempotent, and uninstalls cleanly", () => {
    const root = fresh()
    const first = run(["install", "--json", "--config-dir", root])
    assert.equal(first.code, 0)
    assert.deepEqual(first.json().changed, ["opencode.json"])
    assert.deepEqual(config(root).plugin, ["parallax-opencode"])
    const second = run(["install", "--json", "--config-dir", root])
    assert.deepEqual(second.json().changed, [])
    assert.equal(run(["status", "--json", "--config-dir", root]).json().healthy, true)
    const removed = run(["uninstall", "--json", "--config-dir", root])
    assert.deepEqual(removed.json().changed, ["opencode.json"])
    assert.deepEqual(config(root).plugin, [])
    const status = run(["status", "--json", "--config-dir", root])
    assert.equal(status.code, 1)
    assert.equal(status.json().registered, false)
  })

  it("preserves unrelated JSONC config, replaces legacy entries, and removes copied legacy assets", () => {
    const root = fresh()
    mkdirSync(join(root, "agents"), { recursive: true })
    mkdirSync(join(root, "skills", "parallax-plan"), { recursive: true })
    writeFileSync(join(root, "opencode.jsonc"), `{
  // user settings
  "model": "anthropic/claude-sonnet-4-5", /* keep */
  "plugin": ["./plugins/parallax-engine.js", ["other-plugin", {"a": 1}], "parallax-opencode@0.7.4",],
}`)
    const managed = "managed agent"
    writeFileSync(join(root, "agents", "parallax.md"), managed)
    writeFileSync(join(root, "agents", "horizon.md"), "customized by the user")
    writeFileSync(join(root, "skills", "parallax-plan", "SKILL.md"), "skill")
    const sha = (text: string) => createHash("sha256").update(text).digest("hex")
    writeFileSync(join(root, ".parallax-install.json"), JSON.stringify({
      schemaVersion: 1, package: "parallax-opencode", version: "0.7.4", configFile: "opencode.jsonc", registrationManaged: true,
      assets: [
        { path: "agents/parallax.md", sha256: sha(managed), managed: true },
        { path: "agents/horizon.md", sha256: sha("original"), managed: true },
        { path: "skills/parallax-plan/SKILL.md", sha256: sha("skill"), managed: true },
        { path: "../escape", sha256: sha("x"), managed: true },
      ],
    }))
    const dry = run(["install", "--json", "--dry-run", "--config-dir", root]).json()
    assert.deepEqual(dry.removedLegacy.sort(), [".parallax-install.json", "agents/parallax.md", "skills/parallax-plan/SKILL.md"])
    assert.ok(existsSync(join(root, ".parallax-install.json")))
    const report = run(["install", "--json", "--config-dir", root]).json()
    assert.deepEqual(report.changed, ["opencode.jsonc"])
    const next = config(root, "opencode.jsonc")
    assert.equal(next.model, "anthropic/claude-sonnet-4-5")
    assert.deepEqual(next.plugin, [["other-plugin", { a: 1 }], "parallax-opencode"])
    assert.ok(!existsSync(join(root, "agents", "parallax.md")))
    assert.ok(!existsSync(join(root, "skills")))
    assert.equal(readFileSync(join(root, "agents", "horizon.md"), "utf8"), "customized by the user")
    assert.ok(!existsSync(join(root, ".parallax-install.json")))
    assert.ok(!existsSync(join(root, "opencode.json")))
  })

  it("fails closed on malformed config and never writes on dry-run or bad arguments", () => {
    const root = fresh()
    writeFileSync(join(root, "opencode.json"), '{"plugin": "nope"}')
    const bad = run(["install", "--json", "--config-dir", root])
    assert.equal(bad.code, 1)
    assert.match(bad.json().error, /plugin must be an array/)
    assert.equal(readFileSync(join(root, "opencode.json"), "utf8"), '{"plugin": "nope"}')
    writeFileSync(join(root, "opencode.json"), "{ broken")
    assert.match(run(["install", "--config-dir", root]).err, /Invalid JSON/)
    const empty = fresh()
    assert.equal(run(["install", "--dry-run", "--config-dir", empty]).code, 0)
    assert.equal(run(["bogus", "--config-dir", empty]).code, 2)
    assert.equal(run(["install", "--what", "--config-dir", empty]).code, 2)
    assert.deepEqual(readdirSync(empty), [])
    assert.match(run(["help"]).out, /Usage: parallax-opencode/)
  })

  it("reports doctor and receipt summaries", () => {
    const root = fresh()
    run(["install", "--config-dir", root])
    const project = fresh()
    mkdirSync(join(project, ".parallax"))
    writeFileSync(join(project, ".parallax", "config.json"), '{"strictness":"bogus"}')
    const doctor = run(["doctor", "--json", "--config-dir", root], project).json()
    assert.equal(doctor.registered, true)
    assert.ok(doctor.failures.some((failure: string) => /strictness/.test(failure)))
    writeFileSync(join(project, ".parallax", "receipts.jsonl"), [
      JSON.stringify({ id: "a1", at: "t", verdict: "pass", command: "npm", args: ["run", "test"], files: ["x"] }),
      JSON.stringify({ id: "b2", at: "t", verdict: "fail", command: "npm", args: ["run", "test"], files: [] }),
      "garbage",
    ].join("\n"))
    const receipts = run(["receipts", "--json"], project).json()
    assert.equal(receipts.total, 2)
    assert.equal(receipts.pass, 1)
    assert.equal(receipts.fail, 1)
    assert.match(run(["receipts"], project).out, /2 receipts: 1 pass, 1 fail/)
  })
})
