/** Installer lifecycle integration tests use an isolated OpenCode root. */
import { describe, it, expect } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parallax-install-"))
  const config = join(root, "opencode")
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/install.mjs", ...args], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, OPENCODE_CONFIG_DIR: config },
  })
  return { root, config, run, clean: () => rmSync(root, { recursive: true, force: true }) }
}

function configAt(root: string): { plugin?: string[]; theme?: string } {
  return JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as { plugin?: string[]; theme?: string }
}

describe("explicit installer lifecycle", () => {
  it("runs when invoked through a symlinked package path", () => {
    const f = fixture()
    try {
      const linkedPackage = join(f.root, "linked-package")
      symlinkSync(process.cwd(), linkedPackage, process.platform === "win32" ? "junction" : "dir")
      const result = spawnSync(process.execPath, [
        join(linkedPackage, "scripts", "install.mjs"), "install", "--json", "--config-dir", f.config,
      ], { encoding: "utf8" })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ command: "install", installed: true })
    } finally { f.clean() }
  })

  it("installs into OPENCODE_CONFIG_DIR and repeated install is idempotent", () => {
    const f = fixture()
    try {
      const first = f.run("install", "--json")
      expect(first.status, first.stderr).toBe(0)
      expect(existsSync(join(f.config, "agents", "parallax.md"))).toBe(true)
      expect(existsSync(join(f.config, "agents", "horizon.md"))).toBe(true)
      expect(existsSync(join(f.config, "agents", "horizon-worker.md"))).toBe(true)
      expect(existsSync(join(f.config, "agents", "horizon-auditor.md"))).toBe(true)
      expect(existsSync(join(f.config, "skills", "parallax-plan", "SKILL.md"))).toBe(true)
      expect(existsSync(join(f.config, "skills", "parallax-debug", "SKILL.md"))).toBe(true)
      expect(configAt(f.config).plugin).toContain("parallax-opencode")

      const manifest = join(f.config, ".parallax-install.json")
      const before = readFileSync(manifest, "utf8")
      const mtime = statSync(manifest).mtimeMs
      const second = f.run("install", "--json")
      expect(second.status, second.stderr).toBe(0)
      expect(JSON.parse(second.stdout).changed).toEqual([])
      expect(readFileSync(manifest, "utf8")).toBe(before)
      expect(statSync(manifest).mtimeMs).toBe(mtime)
    } finally { f.clean() }
  })

  it("dry-run and unknown arguments never create the config root", () => {
    const f = fixture()
    try {
      expect(f.run("install", "--dry-run").status).toBe(0)
      expect(existsSync(f.config)).toBe(false)
      expect(f.run("install", "--unknown").status).toBe(2)
      expect(existsSync(f.config)).toBe(false)
    } finally { f.clean() }
  })

  it("does not alter an existing config on dry-run or argument errors", () => {
    const f = fixture()
    try {
      mkdirSync(f.config, { recursive: true })
      const path = join(f.config, "opencode.json")
      const original = JSON.stringify({ theme: "user", plugin: ["other-plugin"] })
      writeFileSync(path, original)
      expect(f.run("install", "--dry-run").status).toBe(0)
      expect(f.run("install", "--unknown").status).toBe(2)
      expect(readFileSync(path, "utf8")).toBe(original)
      expect(existsSync(join(f.config, ".parallax-install.json"))).toBe(false)
      expect(existsSync(join(f.config, "agents"))).toBe(false)
    } finally { f.clean() }
  })

  it("fails malformed JSONC and malformed Parallax settings before mutation", () => {
    for (const content of [
      "{ broken",
      '{ "parallax": { "minScore": 900 } }',
      '{ "parallax-opencode": { "minSore": 70 } }',
      '{ "parallax": { "minScore": 7/* comment */0 } }',
    ]) {
      const f = fixture()
      try {
        mkdirSync(f.config, { recursive: true })
        const path = join(f.config, "opencode.jsonc")
        writeFileSync(path, content)
        const before = readFileSync(path, "utf8")
        const result = f.run("install")
        expect(result.status).toBe(1)
        expect(readFileSync(path, "utf8")).toBe(before)
        expect(existsSync(join(f.config, "agents"))).toBe(false)
        expect(existsSync(join(f.config, ".parallax-install.json"))).toBe(false)
      } finally { f.clean() }
    }
  })

  it("validates both OpenCode config file forms before mutation", () => {
    const f = fixture()
    try {
      mkdirSync(f.config, { recursive: true })
      writeFileSync(join(f.config, "opencode.json"), JSON.stringify({ plugin: ["other-plugin"] }))
      writeFileSync(join(f.config, "opencode.jsonc"), "{ broken")
      const before = readFileSync(join(f.config, "opencode.json"), "utf8")
      expect(f.run("install").status).toBe(1)
      expect(readFileSync(join(f.config, "opencode.json"), "utf8")).toBe(before)
      expect(existsSync(join(f.config, ".parallax-install.json"))).toBe(false)
      expect(existsSync(join(f.config, "agents"))).toBe(false)
    } finally { f.clean() }
  })

  it("accepts JSONC, preserves unrelated config, and backs up customized assets", () => {
    const f = fixture()
    try {
      mkdirSync(join(f.config, "agents"), { recursive: true })
      writeFileSync(join(f.config, "opencode.jsonc"), `{
        // user preference
        "theme": "midnight,}",
        "plugin": ["other-plugin",],
      }`)
      writeFileSync(join(f.config, "agents", "parallax.md"), "my customized agent\n")
      const result = f.run("install", "--json")
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout) as { backups: string[] }
      expect(report.backups.some((path) => path.endsWith("agents/parallax.md"))).toBe(true)
      const config = JSON.parse(readFileSync(join(f.config, "opencode.jsonc"), "utf8"))
      expect(config.theme).toBe("midnight,}")
      expect(config.plugin).toEqual(["other-plugin", "parallax-opencode"])
      const backups = report.backups.map((path) => join(f.config, ...path.split("/")))
      expect(backups.some((path) => readFileSync(path, "utf8") === "my customized agent\n")).toBe(true)
    } finally { f.clean() }
  })

  it("uninstall removes only managed registration/assets and preserves customizations", () => {
    const f = fixture()
    try {
      mkdirSync(f.config, { recursive: true })
      writeFileSync(join(f.config, "opencode.json"), JSON.stringify({ theme: "user", plugin: ["other-plugin"] }))
      expect(f.run("install").status).toBe(0)
      writeFileSync(join(f.config, "agents", "parallax.md"), "changed after install\n")
      const installedConfig = configAt(f.config)
      writeFileSync(join(f.config, "opencode.json"), JSON.stringify({
        ...installedConfig,
        plugin: [...(installedConfig.plugin || []), "parallax-engine"],
      }))

      const result = f.run("uninstall", "--json")
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout) as { preserved: string[] }
      expect(report.preserved).toContain("agents/parallax.md")
      expect(readFileSync(join(f.config, "agents", "parallax.md"), "utf8")).toBe("changed after install\n")
      expect(configAt(f.config)).toMatchObject({ theme: "user", plugin: ["other-plugin", "parallax-engine"] })
      expect(existsSync(join(f.config, "agents", "horizon.md"))).toBe(false)
      expect(existsSync(join(f.config, "agents", "horizon-worker.md"))).toBe(false)
      expect(existsSync(join(f.config, "agents", "horizon-auditor.md"))).toBe(false)
      expect(existsSync(join(f.config, "skills", "parallax-plan"))).toBe(false)
      expect(existsSync(join(f.config, "skills", "parallax-debug"))).toBe(false)
      expect(existsSync(join(f.config, ".parallax-install.json"))).toBe(false)
    } finally { f.clean() }
  })

  it("does not claim or uninstall pre-existing registration and identical assets", () => {
    const f = fixture()
    try {
      mkdirSync(join(f.config, "agents"), { recursive: true })
      writeFileSync(join(f.config, "opencode.json"), JSON.stringify({
        theme: "user",
        plugin: ["other-plugin", "parallax-opencode"],
      }))
      const agent = readFileSync(join(process.cwd(), "agents", "parallax.md"))
      writeFileSync(join(f.config, "agents", "parallax.md"), agent)

      expect(f.run("install").status).toBe(0)
      const manifest = JSON.parse(readFileSync(join(f.config, ".parallax-install.json"), "utf8"))
      expect(manifest.registrationManaged).toBe(false)
      expect(manifest.assets.find((asset: { path: string }) => asset.path === "agents/parallax.md").managed).toBe(false)

      const result = f.run("uninstall", "--json")
      expect(result.status, result.stderr).toBe(0)
      expect(configAt(f.config).plugin).toEqual(["other-plugin", "parallax-opencode"])
      expect(readFileSync(join(f.config, "agents", "parallax.md"))).toEqual(agent)
      expect(JSON.parse(result.stdout).preserved).toContain("agents/parallax.md")
    } finally { f.clean() }
  })

  it("offers machine-readable status and doctor diagnostics", () => {
    const f = fixture()
    try {
      expect(f.run("install").status).toBe(0)
      const status = f.run("status", "--json")
      expect(status.status).toBe(0)
      expect(JSON.parse(status.stdout)).toMatchObject({ healthy: true, registered: true })
      // Model an asset from an older managed release: its bytes still match
      // the recorded hash but differ from this package's desired asset.
      const staleAsset = join(f.config, "agents", "horizon.md")
      writeFileSync(staleAsset, "older managed horizon asset\n")
      const manifestPath = join(f.config, ".parallax-install.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      manifest.assets.find((asset: { path: string }) => asset.path === "agents/horizon.md").sha256 =
        createHash("sha256").update(readFileSync(staleAsset)).digest("hex")
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

      const doctor = f.run("doctor", "--json")
      const report = JSON.parse(doctor.stdout)
      expect(report.versions.node).toBe(process.version)
      expect(report.versions.plugin).toBeTruthy()
      expect(report.versions).toHaveProperty("opencode")
      expect(report.paths.configRoot).toBe(f.config)
      expect(report).toHaveProperty("effectiveConfig")
      expect(report).toHaveProperty("writability")
      expect(report.assets).toContainEqual({ path: "agents/horizon.md", state: "stale" })
      expect(report.failures).toEqual(expect.arrayContaining([expect.objectContaining({ code: "assets-not-current", fix: expect.any(String) })]))
      expect(report.verificationCommands.length).toBeGreaterThan(0)
      expect([0, 1]).toContain(doctor.status)
    } finally { f.clean() }
  })
})
