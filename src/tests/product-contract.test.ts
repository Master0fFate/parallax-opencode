import { readFileSync, readdirSync } from "node:fs"
import { relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

function discoverPromptPaths(directory: string): string[] {
  return filesBelow(resolve(root, directory))
    .filter((path) => path.endsWith(".md"))
    .filter((path) => directory !== "skills" || path.endsWith("SKILL.md"))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
}

const promptPaths = [
  ...discoverPromptPaths("agents"),
  ...discoverPromptPaths("skills"),
].sort()
const prompts = promptPaths.map((path) => ({ path, text: read(path) }))
const publicContractPaths = [
  ...promptPaths,
  "README.md",
  "Horizons.spec.md",
]
const publicContractSurfaces = publicContractPaths.map((path) => ({ path, text: read(path) }))

const questionContract =
  "Ask only when an essential decision cannot be derived safely from repository evidence or a missing credential, access grant, or consequential user choice blocks the work."
const permissionContract = "OpenCode permission prompts are authoritative."

function permissions(text: string): Map<string, string> {
  const block = text.match(/^permission:\r?\n((?:  [a-z]+: (?:allow|ask|deny)\r?\n)+)/m)?.[1]
  expect(block).toBeDefined()
  return new Map(
    block!.trim().split(/\r?\n/).map((line) => {
      const [name, value] = line.trim().split(/:\s+/)
      return [name, value]
    }),
  )
}

describe("unified product and prompt contract", () => {
  it("discovers every shipped agent and mode skill", () => {
    expect(promptPaths).toEqual([
      "agents/horizon-auditor.md",
      "agents/horizon-worker.md",
      "agents/horizon.md",
      "agents/parallax.md",
      "skills/parallax-debug/SKILL.md",
      "skills/parallax-plan/SKILL.md",
    ])
  })

  it.each(prompts)("$path uses the verified change loop", ({ text }) => {
    for (const phase of ["PREFLIGHT", "CHANGE", "VERIFY", "RECEIPT"]) {
      expect(text).toContain(`## ${phase}`)
    }
    expect(text).toContain(questionContract)
    expect(text).toContain(permissionContract)
    expect(text).toMatch(/schema-v2 verification receipt/i)
    expect(text).toMatch(/`pass`/)
    expect(text).toMatch(/`fail`, `skipped`, and `unknown`/)
    expect(text).toMatch(/Markdown/)
  })

  it.each(prompts)("$path avoids conflicting format, question, and capability claims", ({ text }) => {
    expect(text).not.toMatch(/no markdown rendering|plain[- ]text only|plain ASCII/i)
    expect(text).not.toMatch(/always ask|must ask|never ask|questions? (?:are )?required|explicit confirmation/i)
    expect(text).not.toMatch(/100% complete|until the task is complete|task\(\)|autonomous supervisor/i)
  })

  it.each(publicContractSurfaces)("$path has no strictness or preflight bypass contract", ({ text }) => {
    expect(text).not.toMatch(/protocol (?:level\s*(?::|=)?\s*)?none/i)
    expect(text).not.toMatch(/(?:skip|bypass) (?:the )?(?:preflight|protocol|check-?ins?)/i)
    expect(text).not.toMatch(/trivial changes? (?:skip|bypass).*(?:preflight|protocol|check-?ins?)/i)
  })

  it("uses current OpenCode permission names and permission semantics", () => {
    const expectedBase = new Map([
      ["edit", "allow"],
      ["bash", "ask"],
      ["read", "allow"],
      ["grep", "allow"],
      ["glob", "allow"],
      ["list", "allow"],
      ["webfetch", "allow"],
      ["question", "allow"],
      ["todowrite", "allow"],
    ])
    expect(permissions(read("agents/parallax.md"))).toEqual(expectedBase)
    expect(permissions(read("agents/horizon.md"))).toEqual(expectedBase)
    expect(read("agents/horizon.md")).toMatch(
      /task:\r?\n    "\*": deny\r?\n    "horizon-worker": allow\r?\n    "horizon-auditor": allow/,
    )
    expect(permissions(read("agents/horizon-worker.md"))).toEqual(new Map([
      ...expectedBase,
      ["question", "deny"],
      ["task", "deny"],
    ]))
    expect(permissions(read("agents/horizon-auditor.md"))).toEqual(new Map([
      ...expectedBase,
      ["edit", "deny"],
      ["bash", "deny"],
      ["question", "deny"],
      ["todowrite", "deny"],
      ["task", "deny"],
    ]))
    for (const { text } of prompts.filter(({ path }) => path.startsWith("agents/"))) {
      expect(text).not.toMatch(/^  browser:/m)
    }
    expect(read("agents/horizon.md")).toContain(
      "Autonomy settings control Horizon checkpoint behavior; they do not override `ask` or `deny` permissions.",
    )
  })

  it("packages a strictly sequential worker-receipt-auditor pipeline without model assumptions", () => {
    const horizon = read("agents/horizon.md")
    const worker = read("agents/horizon-worker.md")
    const auditor = read("agents/horizon-auditor.md")
    expect(horizon).toMatch(/horizon-worker[\s\S]*wait[\s\S]*schema-v2 receipt ID[\s\S]*horizon-auditor[\s\S]*wait/i)
    expect(horizon).toMatch(/At most one delegated task may be active/i)
    expect(horizon).toMatch(/Overlap, parallel dispatch[\s\S]*forbidden/i)
    expect(worker).toMatch(/exactly one atomic implementation brief/i)
    expect(auditor).toMatch(/read-only auditor/i)
    expect(auditor).toMatch(/Self-reported scores[\s\S]*cannot replace/i)
    for (const text of [horizon, worker, auditor]) expect(text).not.toMatch(/^model:/m)
    expect(read("README.md")).toMatch(/No agent file hardcodes a model/i)
    expect(read("Horizons.spec.md")).toMatch(/weaker\/cheaper model/i)
  })

  it("positions Horizon as durable resumable supervision with evidence limits", () => {
    for (const path of ["agents/horizon.md", "Horizons.spec.md", "README.md"]) {
      const text = read(path)
      expect(text).toMatch(/durable/i)
      expect(text).toMatch(/not a background daemon/i)
      expect(text).toMatch(/receipt/i)
      expect(text).not.toMatch(/100% complete|unattended execution|autonomous supervisor/i)
    }
  })

  it("enforces full-autonomy liveness without weakening evidence or permissions", () => {
    const horizonAgent = read("agents/horizon.md")
    const plugin = read("src/plugin.ts")
    const spec = read("Horizons.spec.md")
    for (const text of [horizonAgent, plugin, spec]) {
      expect(text).toMatch(/without an attempt cap|never caps attempts|no terminal retry budget|not an attempt cap/i)
      expect(text).toMatch(/typed[^\n]*blocker|blocker[^\n]*evidence|records concrete evidence/i)
      expect(text).toMatch(/OpenCode permission/i)
    }
    expect(plugin).toContain('input.event.type === "session.idle"')
    expect(plugin).toContain("client.session.promptAsync")
    expect(plugin).toMatch(/Failed checks, timeouts, low scores[\s\S]*recovery inputs, not blockers/i)
    expect(horizonAgent).toMatch(/do not ask whether to continue/i)
    expect(horizonAgent).toMatch(/GitHub[\s\S]*publishing a package/i)
  })

  it("keeps advanced planning, debugging, and delegation progressively disclosed", () => {
    expect(read("agents/parallax.md")).toContain("progressive disclosure")
    expect(read("skills/parallax-plan/SKILL.md")).toMatch(/progressively add/i)
    expect(read("skills/parallax-debug/SKILL.md")).toContain("## OPTIONAL DEPTH")
    expect(read("agents/horizon.md")).toMatch(/only for complex or repeated work/i)
  })

  it("keeps the runtime Horizon injection on the same contract", () => {
    const plugin = read("src/plugin.ts")
    expect(plugin).toContain("## HORIZON VERIFIED CHANGE LOOP")
    for (const phase of ["### PREFLIGHT", "### CHANGE", "### VERIFY", "### RECEIPT"]) {
      expect(plugin).toContain(phase)
    }
    expect(plugin).toContain("Only pass is passing evidence; fail, skipped, and unknown remain limitations.")
    expect(plugin).toMatch(/OpenCode permission prompts are authoritative/)
    expect(plugin).not.toMatch(/100% complete|via task\(\)|NEVER ask/i)
  })

  it("documents every runtime tool without claiming hidden dispatch or daemon behavior", () => {
    const plugin = read("src/plugin.ts")
    const readme = read("README.md")
    const toolNames = [...plugin.matchAll(/^\s+((?:parallax|horizon)_[a-z_]+): tool\(\{/gm)]
      .map((match) => match[1])
    expect(toolNames.filter((name) => name.startsWith("parallax_"))).toHaveLength(12)
    expect(toolNames.filter((name) => name.startsWith("horizon_"))).toHaveLength(20)
    for (const name of toolNames) expect(readme).toContain(name)

    expect(read("Horizons.spec.md")).toContain(
      "These tools persist and score supplied information. They do not dispatch sub-agents or prove correctness.",
    )
    expect(readme).toContain(
      "The `strictness` setting changes how early the runtime blocks a non-compliant write; it does not define a different agent workflow.",
    )
    expect(readme).toContain("parallax-plan/SKILL.md")
    expect(readme).toContain("parallax-debug/SKILL.md")
    expect(readme).not.toMatch(/^\s+parallax\/\s+# Parallax protocol skills$/m)
  })
})
