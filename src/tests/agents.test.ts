import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { AGENT_NAMES, SKILLS_DIR, loadAgents } from "../agents.js"

describe("packaged agents", () => {
  const agents = loadAgents()

  it("ships four agents with prompts that name the tools they rely on", () => {
    assert.deepEqual(Object.keys(agents).sort(), [...AGENT_NAMES].sort())
    assert.match(agents.parallax.prompt, /parallax_preflight[\s\S]*parallax_verify[\s\S]*parallax_receipt/)
    assert.match(agents.horizon.prompt, /horizon_plan[\s\S]*horizon_feature receipt[\s\S]*horizon-auditor/)
    assert.match(agents["horizon-worker"].prompt, /parallax_verify/)
    assert.match(agents["horizon-auditor"].prompt, /horizon_feature audit/)
    for (const agent of Object.values(agents)) {
      assert.ok(!agent.prompt.startsWith("---"))
      assert.ok(agent.prompt.length > 400 && agent.prompt.length < 3500, `prompt length ${agent.prompt.length}`)
      assert.match(agent.prompt, /permission prompts are authoritative|OpenCode permission/)
      assert.match(agent.color, /^#[0-9a-f]{6}$/)
    }
  })

  it("keeps the delegation and read-only boundaries", () => {
    assert.equal(agents.horizon.mode, "primary")
    assert.equal(agents.horizon.permission.edit, "deny")
    assert.deepEqual(agents.horizon.permission.task, { "*": "deny", "horizon-worker": "allow", "horizon-auditor": "allow" })
    assert.equal(agents["horizon-worker"].permission.task, "deny")
    assert.equal(agents["horizon-worker"].permission["horizon_*"], "deny")
    assert.equal(agents["horizon-auditor"].permission.edit, "deny")
    assert.equal(agents["horizon-auditor"].permission.bash, "deny")
    assert.equal(agents.parallax.permission["horizon_*"], "deny")
  })
})

describe("packaged skills", () => {
  it("use the OpenCode skill format with a name matching the folder", () => {
    const names = readdirSync(SKILLS_DIR).sort()
    assert.deepEqual(names, ["parallax-debug", "parallax-hyperplan", "parallax-plan"])
    for (const name of names) {
      const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8")
      const front = text.match(/^---\n([\s\S]*?)\n---\n/)
      assert.ok(front, `${name} needs frontmatter`)
      const keys = front![1].split("\n").map((line) => line.split(":")[0])
      assert.deepEqual(keys, ["name", "description"])
      assert.match(front![1], new RegExp(`^name: ${name}$`, "m"))
      assert.match(front![1], /^description: Use /m)
      assert.ok(text.length < 4000)
    }
  })
})
