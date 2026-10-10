#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir, platform } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ENTRY = "parallax-opencode"
const LEGACY_ENTRIES = new Set(["./plugins/parallax-engine.js", "parallax-engine"])
const LEGACY_MANIFEST = ".parallax-install.json"
const COMMANDS = new Set(["install", "uninstall", "status", "doctor", "receipts", "help"])

const version = () => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
  } catch {
    return "unknown"
  }
}

const usage = () => `parallax-opencode v${version()}

Usage: parallax-opencode <command> [--json] [--dry-run] [--config-dir <path>]

  install     Register the plugin in opencode.json (default). Agents and skills ship inside the package.
  uninstall   Remove the registration
  status      Show registration state
  doctor      Check Node, OpenCode, registration, and project config
  receipts    Summarize .parallax/receipts.jsonl in the current project
  help        Show this help

Config root precedence: --config-dir, OPENCODE_CONFIG_DIR, ~/.config/opencode`

function parseArgs(argv) {
  const options = { command: "install", json: false, dryRun: false, configDir: undefined }
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--json") options.json = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "-h" || arg === "--help") options.command = "help"
    else if (arg === "--config-dir") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) throw new Error("--config-dir requires a path")
      options.configDir = argv[++i]
    } else if (arg.startsWith("--config-dir=")) options.configDir = arg.slice(13)
    else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`)
    else if (COMMANDS.has(arg) && !seen) {
      options.command = arg
      seen = true
    } else throw new Error(`Unknown ${seen ? "argument" : "command"}: ${arg}`)
  }
  return options
}

function stripJsonc(text) {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") out += text[++i] ?? ""
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end < 0) throw new Error("unterminated block comment")
      out += text.slice(i, end + 2).replace(/[^\n]/g, "")
      i = end + 1
    } else out += c
  }
  if (inString) throw new Error("unterminated string")
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function readConfig(path) {
  if (!existsSync(path)) return {}
  let value
  try {
    value = JSON.parse(stripJsonc(readFileSync(path, "utf8")))
  } catch (error) {
    throw new Error(`Invalid JSON/JSONC in ${path}: ${error.message}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`)
  if (value.plugin !== undefined && (!Array.isArray(value.plugin) || !value.plugin.every(isEntry))) {
    throw new Error(`${path}.plugin must be an array of plugin specs`)
  }
  return value
}

const isEntry = (entry) => typeof entry === "string" || (Array.isArray(entry) && typeof entry[0] === "string")
const entryName = (entry) => (typeof entry === "string" ? entry : entry[0]).replace(/@[^/]*$/, "")
const isOurs = (entry) => entryName(entry) === ENTRY || LEGACY_ENTRIES.has(entryName(entry))

function paths(options) {
  const configRoot = resolve(options.configDir || process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"))
  const json = join(configRoot, "opencode.json")
  const jsonc = join(configRoot, "opencode.jsonc")
  return { configRoot, configFile: !existsSync(json) && existsSync(jsonc) ? jsonc : json, manifest: join(configRoot, LEGACY_MANIFEST) }
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    writeFileSync(temp, data, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function legacyAssets(where) {
  if (!existsSync(where.manifest)) return []
  let manifest
  try {
    manifest = JSON.parse(stripJsonc(readFileSync(where.manifest, "utf8")))
  } catch {
    return []
  }
  if (!Array.isArray(manifest?.assets)) return []
  return manifest.assets.filter((asset) => {
    if (asset?.managed !== true || typeof asset.path !== "string" || typeof asset.sha256 !== "string") return false
    if (asset.path.split("/").some((part) => !part || part === "." || part === "..")) return false
    const file = join(where.configRoot, asset.path)
    return existsSync(file) && lstatSync(file).isFile() && createHash("sha256").update(readFileSync(file)).digest("hex") === asset.sha256
  }).map((asset) => asset.path)
}

function install(options) {
  const where = paths(options)
  const config = readConfig(where.configFile)
  const plugins = (config.plugin ?? []).filter((entry) => !isOurs(entry))
  plugins.push(ENTRY)
  const configChanged = JSON.stringify(plugins) !== JSON.stringify(config.plugin ?? [])
  const removals = legacyAssets(where)
  if (existsSync(where.manifest)) removals.push(LEGACY_MANIFEST)
  const report = {
    command: "install", dryRun: options.dryRun, configFile: where.configFile, version: version(),
    changed: configChanged || !existsSync(where.configFile) ? [basename(where.configFile)] : [],
    removedLegacy: removals,
  }
  if (options.dryRun) return report
  if (report.changed.length) atomicWrite(where.configFile, `${JSON.stringify({ ...config, plugin: plugins }, null, 2)}\n`)
  for (const path of removals) rmSync(join(where.configRoot, path), { force: true })
  for (const dir of ["skills/parallax-plan", "skills/parallax-debug", "skills", "agents"]) {
    try {
      rmdirSync(join(where.configRoot, dir))
    } catch {}
  }
  return report
}

function uninstall(options) {
  const where = paths(options)
  const config = readConfig(where.configFile)
  const plugins = (config.plugin ?? []).filter((entry) => !isOurs(entry))
  const changed = plugins.length !== (config.plugin ?? []).length
  const report = { command: "uninstall", dryRun: options.dryRun, configFile: where.configFile, changed: changed ? [basename(where.configFile)] : [] }
  if (!options.dryRun && changed) atomicWrite(where.configFile, `${JSON.stringify({ ...config, plugin: plugins }, null, 2)}\n`)
  return report
}

function status(options) {
  const where = paths(options)
  const config = readConfig(where.configFile)
  const entries = (config.plugin ?? []).filter(isOurs)
  const registered = entries.some((entry) => entryName(entry) === ENTRY)
  const legacy = entries.filter((entry) => entryName(entry) !== ENTRY).map(entryName)
  if (existsSync(where.manifest)) legacy.push(LEGACY_MANIFEST)
  return { command: "status", healthy: registered && legacy.length === 0, registered, legacy, version: version(), configFile: where.configFile }
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: platform() === "win32", timeout: 10_000 })
  if (result.error || result.status !== 0) return null
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0]
}

async function doctor(options) {
  const report = status(options)
  const failures = []
  const opencode = commandVersion("opencode", ["--version"])
  if (!opencode) failures.push("OpenCode is not on PATH; install it and ensure `opencode --version` works")
  else if (!/^(1\.(1[89]|[2-9]\d)|[2-9])\./.test(opencode)) failures.push(`OpenCode ${opencode} is older than the supported 1.18.35`)
  if (!report.registered) failures.push("plugin is not registered; run `parallax-opencode install`")
  if (report.legacy.length) failures.push(`legacy install artifacts remain (${report.legacy.join(", ")}); run \`parallax-opencode install\``)
  const projectConfig = join(process.cwd(), ".parallax", "config.json")
  let effective = null
  if (existsSync(projectConfig)) {
    try {
      const { loadConfig } = await import(new URL("../dist/config.js", import.meta.url))
      effective = loadConfig(process.cwd())
    } catch (error) {
      failures.push(error.message)
    }
  }
  return {
    command: "doctor", healthy: failures.length === 0, versions: { node: process.version, plugin: version(), opencode },
    configFile: report.configFile, registered: report.registered, projectConfig: effective, failures,
  }
}

function receipts() {
  const path = join(process.cwd(), ".parallax", "receipts.jsonl")
  const entries = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
    : []
  const count = (verdict) => entries.filter((receipt) => receipt.verdict === verdict).length
  return {
    command: "receipts", total: entries.length,
    pass: count("pass"), fail: count("fail"), skipped: count("skipped"), unknown: count("unknown"),
    latest: entries.slice(-20).map((receipt) => ({ id: receipt.id, at: receipt.at, verdict: receipt.verdict, command: receipt.command ? `${receipt.command} ${receipt.args.join(" ")}` : null, files: receipt.files })),
  }
}

function print(report) {
  const p = "[parallax]"
  switch (report.command) {
    case "install":
      console.log(`${p} ${report.dryRun ? "would register" : report.changed.length ? "registered" : "already registered"} in ${report.configFile}`)
      for (const path of report.removedLegacy) console.log(`${p} ${report.dryRun ? "would remove" : "removed"} legacy asset ${path}`)
      if (!report.dryRun) console.log(`${p} restart OpenCode to load the parallax and horizon agents`)
      break
    case "uninstall":
      console.log(`${p} ${report.dryRun ? "would remove" : report.changed.length ? "removed" : "no"} registration in ${report.configFile}`)
      break
    case "status":
      console.log(`${p} ${report.healthy ? "healthy" : "attention required"}: registered=${report.registered} legacy=${report.legacy.join(",") || "none"} (${report.configFile})`)
      break
    case "doctor":
      console.log(`${p} ${report.healthy ? "healthy" : "failures found"}: node ${report.versions.node}, plugin ${report.versions.plugin}, opencode ${report.versions.opencode ?? "unavailable"}`)
      for (const failure of report.failures) console.log(`${p} FAIL ${failure}`)
      break
    default:
      console.log(`${p} ${report.total} receipts: ${report.pass} pass, ${report.fail} fail, ${report.skipped} skipped, ${report.unknown} unknown`)
      for (const receipt of report.latest) console.log(`${p} ${receipt.at} ${receipt.verdict.padEnd(7)} ${receipt.id.slice(0, 8)} ${receipt.command ?? "no check"}`)
  }
}

export async function run(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[parallax] ${error.message}\n${usage()}`)
    return 2
  }
  if (options.command === "help") {
    console.log(usage())
    return 0
  }
  try {
    const report = options.command === "install" ? install(options)
      : options.command === "uninstall" ? uninstall(options)
        : options.command === "status" ? status(options)
          : options.command === "doctor" ? await doctor(options)
            : receipts()
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else print(report)
    return report.healthy === false ? 1 : 0
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ command: options.command, healthy: false, error: error.message }, null, 2))
    else console.error(`[parallax] ERROR: ${error.message}\n[parallax] nothing was changed`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run()
