#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temp = mkdtempSync(join(tmpdir(), "parallax-pack-"))
const npm = (args, options = {}) => execFileSync("npm", args, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"], ...options })

try {
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", temp]))[0]
  const files = packed.files.map((file) => file.path.replaceAll("\\", "/"))
  const required = [
    "package.json", "LICENSE", "README.md", "scripts/install.mjs",
    "dist/plugin.js", "dist/plugin.d.ts", "dist/verify.js", "dist/verify.d.ts",
    "agents/parallax.md", "agents/horizon.md", "agents/horizon-worker.md", "agents/horizon-auditor.md",
    "skills/parallax-plan/SKILL.md", "skills/parallax-debug/SKILL.md", "skills/parallax-hyperplan/SKILL.md",
  ]
  const missing = required.filter((path) => !files.includes(path))
  if (missing.length) throw new Error(`packed artifact is missing ${missing.join(", ")}`)
  const unexpected = files.filter((path) => !(
    required.includes(path) || /^dist\/[^/]+\.(?:js|d\.ts)$/.test(path)
  ))
  if (unexpected.length) throw new Error(`packed artifact contains unexpected files: ${unexpected.join(", ")}`)

  const prefix = join(temp, "prefix")
  npm(["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(temp, packed.filename)])
  const installed = join(prefix, "node_modules", "parallax-opencode")
  const probe = join(prefix, "probe.mjs")
  writeFileSync(probe, `
    import plugin, { plugin as named } from "parallax-opencode"
    import { discoverCheck, runCheck, verify } from "parallax-opencode/verify"
    if (typeof plugin !== "function" || plugin !== named) throw new Error("invalid plugin export")
    if ([discoverCheck, runCheck, verify].some((fn) => typeof fn !== "function")) throw new Error("invalid verify export")
    const hooks = await plugin({ client: {}, directory: process.cwd(), worktree: process.cwd() })
    const config = { agent: { horizon: { model: "x/y" } } }
    await hooks.config(config)
    const names = Object.keys(config.agent).sort().join(",")
    if (names !== "horizon,horizon-auditor,horizon-worker,parallax") throw new Error("agents not injected: " + names)
    if (config.agent.horizon.model !== "x/y" || !config.agent.horizon.prompt) throw new Error("user override or prompt lost")
    if (!config.skills.paths.some((p) => p.endsWith("skills"))) throw new Error("skills path not registered")
    if (Object.keys(hooks.tool).length !== 7) throw new Error("expected 7 tools")
  `)
  execFileSync(process.execPath, [probe], { cwd: prefix, stdio: "pipe" })

  const configRoot = join(temp, "config")
  const install = JSON.parse(execFileSync(process.execPath, [join(installed, "scripts", "install.mjs"), "install", "--json", "--config-dir", configRoot], { encoding: "utf8" }))
  const config = JSON.parse(readFileSync(join(configRoot, "opencode.json"), "utf8"))
  if (!config.plugin.includes("parallax-opencode")) throw new Error("installer did not register the plugin")
  const status = JSON.parse(execFileSync(process.execPath, [join(installed, "scripts", "install.mjs"), "status", "--json", "--config-dir", configRoot], { encoding: "utf8" }))
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
  if (!status.healthy || install.version !== packed.version || manifest.version !== packed.version || status.version !== packed.version) {
    throw new Error("installed package, installer, and status versions differ")
  }
  console.log(`pack smoke passed: ${packed.name}@${packed.version} (${files.length} files)`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
