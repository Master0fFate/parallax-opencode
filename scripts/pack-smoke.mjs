#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temp = mkdtempSync(join(tmpdir(), "parallax-pack-smoke-"))

function npm(args, options = {}) {
  return execFileSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
}

try {
  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", temp]))[0]
  if (!packed?.filename || !Array.isArray(packed.files)) throw new Error("npm pack did not return a manifest")

  const paths = packed.files.map((file) => file.path.replaceAll("\\", "/"))
  const required = [
    "package.json",
    "dist/plugin.js",
    "dist/plugin.d.ts",
    "dist/verification.js",
    "dist/verification.d.ts",
    "dist-standalone/parallax-engine.js",
    "agents/horizon.md",
    "agents/horizon-worker.md",
    "agents/horizon-auditor.md",
    "scripts/install.mjs",
  ]
  for (const path of required) {
    if (!paths.includes(path)) throw new Error(`packed artifact is missing ${path}`)
  }

  const forbidden = paths.filter((path) =>
    /^(?:src|node_modules|coverage|data|\.parallax|\.github)\//.test(path) ||
    /(?:^|\/)(?:[^/]+\.(?:log|tmp|map)|verification-ledger\.jsonl)$/.test(path),
  )
  if (forbidden.length) throw new Error(`packed artifact contains runtime/development artifacts: ${forbidden.join(", ")}`)

  const unexpected = paths.filter((path) => !(
    /^(?:LICENSE|README\.md|package\.json)$/.test(path) ||
    /^agents\/[^/]+\.md$/.test(path) ||
    /^skills\/[^/]+\/SKILL\.md$/.test(path) ||
    /^scripts\/install\.mjs$/.test(path) ||
    /^dist\/(?:[^/]+\.(?:js|d\.ts))$/.test(path) ||
    /^dist-standalone\/(?:[^/]+\.(?:js|d\.ts))$/.test(path)
  ))
  if (unexpected.length) throw new Error(`packed artifact contains unexpected files: ${unexpected.join(", ")}`)

  const tarball = join(temp, packed.filename)
  const prefix = join(temp, "prefix")
  npm(["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball])

  const installed = join(prefix, "node_modules", "parallax-opencode")
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
  const probe = join(prefix, "packed-import-smoke.mjs")
  writeFileSync(probe, `
    import plugin, { plugin as namedPlugin } from "parallax-opencode"
    import { runVerification, verifyAndRecord } from "parallax-opencode/verification"
    if (typeof plugin !== "function" || plugin !== namedPlugin) throw new Error("invalid plugin export")
    if (typeof runVerification !== "function" || typeof verifyAndRecord !== "function") throw new Error("invalid verification export")
  `)
  execFileSync(process.execPath, [probe], { cwd: prefix, stdio: "pipe" })
  const runtimeVersion = execFileSync(process.execPath, [join(installed, "dist", "cli.js"), "--version"], {
    cwd: prefix,
    encoding: "utf8",
  }).trim()
  const configRoot = join(temp, "receipt-config")
  const installReport = JSON.parse(execFileSync(process.execPath, [
    join(installed, "scripts", "install.mjs"), "install", "--json", "--config-dir", configRoot,
  ], { cwd: prefix, encoding: "utf8", env: { ...process.env, HOME: join(temp, "home"), USERPROFILE: join(temp, "home") } }))
  const receipt = JSON.parse(readFileSync(join(configRoot, ".parallax-install.json"), "utf8"))
  for (const agent of ["horizon.md", "horizon-worker.md", "horizon-auditor.md"]) {
    if (!receipt.assets.some((asset) => asset.path === `agents/${agent}`) ||
        !readFileSync(join(configRoot, "agents", agent), "utf8").includes("schema-v2")) {
      throw new Error(`packed installer did not install the Horizon agent pipeline: ${agent}`)
    }
  }
  if (manifest.version !== packed.version || runtimeVersion !== packed.version ||
      installReport.version !== packed.version || receipt.version !== packed.version) {
    throw new Error("package, runtime, and installation receipt versions differ")
  }

  console.log(`packed import smoke passed: ${packed.name}@${packed.version} (${paths.length} files)`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
