#!/usr/bin/env node
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { homedir, platform } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, "..")
const PLUGIN_ENTRY = "parallax-opencode"
const LEGACY_ENTRIES = ["./plugins/parallax-engine.js", "parallax-engine"]
const MANIFEST_NAME = ".parallax-install.json"
const DEFAULTS = Object.freeze({
  strictness: "strict", minScore: 70, adaptiveProtocol: false,
  designDocRequired: false, trivialPatterns: Object.freeze([]), highRiskPatterns: Object.freeze([]),
})
const PARALLAX_CONFIG_KEYS = new Set([
  "strictness", "minScore", "adaptiveProtocol", "designDocRequired",
  "trivialPatterns", "highRiskPatterns",
])

function packageVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "unknown" }
  catch { return "unknown" }
}

function usage() {
  return `Parallax OpenCode lifecycle v${packageVersion()}

Usage: parallax-opencode [command] [options]

Commands:
  install       Install or safely update Parallax (default)
  dry-run       Preview an install without changing files
  status        Show registration and managed-asset status
  doctor        Diagnose versions, paths, config, permissions, and assets
  uninstall     Remove only Parallax-managed registration and assets
  help          Show this help

Options:
  --dry-run             Preview install/uninstall without file changes
  --json                Emit machine-readable JSON
  --config-dir <path>   Override OPENCODE_CONFIG_DIR
  -h, --help            Show this help

Config root precedence: --config-dir, OPENCODE_CONFIG_DIR, ~/.config/opencode`
}

function parseArgs(argv) {
  const options = { command: "install", dryRun: false, json: false, configDir: undefined, help: false }
  let commandSeen = false
  const commands = new Set(["install", "dry-run", "status", "doctor", "uninstall", "help"])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--json") options.json = true
    else if (arg === "-h" || arg === "--help") options.help = true
    else if (arg === "--config-dir") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) throw new Error("--config-dir requires a path")
      options.configDir = argv[++i]
    } else if (arg.startsWith("--config-dir=")) {
      options.configDir = arg.slice("--config-dir=".length)
      if (!options.configDir) throw new Error("--config-dir requires a path")
    } else if (arg.startsWith("-")) throw new Error(`Unknown argument: ${arg}`)
    else if (commands.has(arg) && !commandSeen) {
      options.command = arg
      commandSeen = true
    } else throw new Error(commandSeen ? `Unknown argument: ${arg}` : `Unknown command: ${arg}`)
  }
  if (options.command === "dry-run") { options.command = "install"; options.dryRun = true }
  if (options.command === "help") options.help = true
  return options
}

function pathsFor(options) {
  const envRoot = process.env.OPENCODE_CONFIG_DIR
  const configRoot = resolve(options.configDir || envRoot || join(homedir(), ".config", "opencode"))
  const json = join(configRoot, "opencode.json")
  const jsonc = join(configRoot, "opencode.jsonc")
  // OpenCode accepts either. If both exist, opencode.json is the least surprising target.
  const configFile = existsSync(json) || !existsSync(jsonc) ? json : jsonc
  return {
    configRoot, configFile,
    // Validate every OpenCode config candidate. This prevents a malformed
    // secondary JSON/JSONC file from being silently ignored during mutation.
    configCandidates: [json, jsonc].filter((path) => existsSync(path)),
    manifest: join(configRoot, MANIFEST_NAME),
    projectConfig: join(process.cwd(), ".parallax", "config.json"),
    backupRoot: join(configRoot, ".parallax-backups"),
  }
}

function stripJsonComments(text) {
  let out = "", inString = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') { inString = true; out += c }
    else if (c === "/" && n === "/") {
      // Comments are whitespace in JSONC. Preserve a separator so comments
      // cannot accidentally join two otherwise-invalid JSON tokens.
      out += " "
      i += 2
      while (i < text.length && text[i] !== "\n") i++
      if (i < text.length) out += "\n"
    } else if (c === "/" && n === "*") {
      out += " "
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n"
        i++
      }
      if (i >= text.length) throw new Error("unterminated block comment")
      i++
    } else out += c
  }
  if (inString) throw new Error("unterminated string")
  let cleaned = "", string = false, slash = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (string) {
      cleaned += c
      if (slash) slash = false
      else if (c === "\\") slash = true
      else if (c === '"') string = false
      continue
    }
    if (c === '"') { string = true; cleaned += c; continue }
    if (c === ",") {
      let next = i + 1
      while (/\s/.test(out[next] || "")) next++
      if (out[next] === "}" || out[next] === "]") continue
    }
    cleaned += c
  }
  return cleaned
}

function parseJsonc(text, source) {
  try { return JSON.parse(stripJsonComments(text)) }
  catch (error) { throw new Error(`Invalid JSON/JSONC in ${source}: ${error instanceof Error ? error.message : String(error)}`) }
}

function validateParallax(value, source) {
  if (value === undefined) return { ...DEFAULTS, trivialPatterns: [], highRiskPatterns: [] }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be an object`)
  for (const key of Object.keys(value))
    if (!PARALLAX_CONFIG_KEYS.has(key)) throw new Error(`${source} has unknown field: ${key}`)
  if (value.strictness !== undefined && (typeof value.strictness !== "string" || !["strict", "standard", "relaxed"].includes(value.strictness)))
    throw new Error(`${source}.strictness must be strict, standard, or relaxed`)
  if (value.minScore !== undefined && (typeof value.minScore !== "number" || !Number.isFinite(value.minScore) || value.minScore < 0 || value.minScore > 100))
    throw new Error(`${source}.minScore must be a number from 0 to 100`)
  for (const key of ["adaptiveProtocol", "designDocRequired"])
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${source}.${key} must be a boolean`)
  for (const key of ["trivialPatterns", "highRiskPatterns"])
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((x) => typeof x !== "string")))
      throw new Error(`${source}.${key} must be an array of strings`)
  return {
    ...DEFAULTS, ...value,
    trivialPatterns: value.trivialPatterns ? [...value.trivialPatterns] : [],
    highRiskPatterns: value.highRiskPatterns ? [...value.highRiskPatterns] : [],
  }
}

function readOpenCodeConfig(path) {
  if (!existsSync(path)) return { value: {}, text: null }
  const text = readFileSync(path, "utf8")
  const value = parseJsonc(text, path)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`)
  if (value.plugin !== undefined && (!Array.isArray(value.plugin) || value.plugin.some((x) => typeof x !== "string")))
    throw new Error(`${path}.plugin must be an array of strings`)
  validateParallax(value.parallax, `${path}.parallax`)
  validateParallax(value[PLUGIN_ENTRY], `${path}.${PLUGIN_ENTRY}`)
  return { value, text }
}

function readProjectConfig(path) {
  if (!existsSync(path)) return { effective: { ...DEFAULTS, trivialPatterns: [], highRiskPatterns: [] }, exists: false }
  const text = readFileSync(path, "utf8")
  let value
  try { value = JSON.parse(text) }
  catch (error) { throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`) }
  return { effective: validateParallax(value, path), exists: true }
}

function sha(data) { return createHash("sha256").update(data).digest("hex") }
function fileSha(path) { return sha(readFileSync(path)) }

function sourceAssets() {
  const roots = [
    [join(ROOT, "agents", "parallax.md"), "agents/parallax.md"],
    [join(ROOT, "agents", "horizon.md"), "agents/horizon.md"],
    [join(ROOT, "agents", "horizon-worker.md"), "agents/horizon-worker.md"],
    [join(ROOT, "agents", "horizon-auditor.md"), "agents/horizon-auditor.md"],
    [join(ROOT, "skills", "parallax-plan"), "skills/parallax-plan"],
    [join(ROOT, "skills", "parallax-debug"), "skills/parallax-debug"],
  ]
  const result = []
  const walk = (source, destination) => {
    if (!existsSync(source)) throw new Error(`Installer asset is missing: ${source}`)
    const stat = statSync(source)
    if (stat.isDirectory()) {
      for (const name of readdirSync(source)) walk(join(source, name), `${destination}/${name}`)
    } else if (stat.isFile()) {
      const data = readFileSync(source)
      result.push({ source, relative: destination.replaceAll("\\", "/"), data, hash: sha(data) })
    } else throw new Error(`Installer asset is not a regular file: ${source}`)
  }
  for (const [source, destination] of roots) walk(source, destination)
  return result
}

function readManifest(path) {
  if (!existsSync(path)) return null
  const value = parseJsonc(readFileSync(path, "utf8"), path)
  const safeAsset = (asset) => {
    if (!asset || typeof asset.path !== "string" || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) return false
    const parts = asset.path.split("/")
    return parts.length > 1 && parts.every((part) => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes(":"))
  }
  if (!value || value.schemaVersion !== 1 || value.package !== PLUGIN_ENTRY ||
      typeof value.version !== "string" || !value.version ||
      !["opencode.json", "opencode.jsonc"].includes(value.configFile) ||
      (value.registrationManaged !== undefined && typeof value.registrationManaged !== "boolean") ||
      !Array.isArray(value.assets) || value.assets.some((asset) =>
        !safeAsset(asset) || (asset.managed !== undefined && typeof asset.managed !== "boolean")) ||
      new Set(value.assets.map((asset) => asset.path)).size !== value.assets.length) {
    throw new Error(`Malformed Parallax install manifest: ${path}`)
  }
  return value
}

function nearestExisting(path) {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function writable(path) {
  try {
    const target = existsSync(path) && !statSync(path).isDirectory() ? path : nearestExisting(path)
    accessSync(target, constants.W_OK)
    return true
  } catch { return false }
}

function preflight(options) {
  let paths = pathsFor(options)
  const manifest = readManifest(paths.manifest)
  // Continue managing the exact config file selected by the original install,
  // even if the user later creates the other supported file form.
  if (manifest?.configFile) {
    paths = { ...paths, configFile: join(paths.configRoot, manifest.configFile) }
  }
  const openCode = readOpenCodeConfig(paths.configFile)
  // OpenCode may leave both file forms in a config root. The selected target
  // is parsed above; parse every other candidate before allowing mutation too.
  for (const candidate of paths.configCandidates) {
    if (candidate !== paths.configFile) readOpenCodeConfig(candidate)
  }
  const project = readProjectConfig(paths.projectConfig)
  // Uninstall relies only on the recorded hashes and remains available even if
  // the npm package's source assets are incomplete or damaged.
  const assets = options.command === "uninstall" ? [] : sourceAssets()
  return { paths, openCode, project, manifest, assets }
}

function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`)
  try {
    writeFileSync(temp, data, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function timestamp() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`
}
function backupPath(paths, stamp, relativePath) { return join(paths.backupRoot, stamp, relativePath) }
function normalizedRelative(root, path) { return relative(root, path).split(sep).join("/") }

function assertSafeDestination(root, destination) {
  const relativePath = normalizedRelative(root, destination)
  if (relativePath === ".." || relativePath.startsWith("../") || relativePath.includes("/../")) {
    throw new Error(`Managed destination escapes the config root: ${destination}`)
  }
  let current = root
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
    throw new Error(`OpenCode config root must not be a symbolic link: ${current}`)
  }
  for (const part of relativePath.split("/").slice(0, -1)) {
    current = join(current, part)
    if (!existsSync(current)) break
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Managed destination parent is not a real directory: ${current}`)
    }
  }
}

function performInstall(state, options) {
  const { paths, openCode, manifest, assets } = state
  // Destination shape and parent boundaries are preflighted before any mutation.
  for (const destination of [paths.configFile, paths.manifest, paths.backupRoot,
    ...assets.map((asset) => join(paths.configRoot, asset.relative))]) {
    assertSafeDestination(paths.configRoot, destination)
  }
  for (const asset of assets) {
    const destination = join(paths.configRoot, asset.relative)
    if (existsSync(destination) && !lstatSync(destination).isFile()) throw new Error(`Asset destination is not a regular file: ${destination}`)
  }
  for (const legacy of ["plugins/parallax-engine.js", "plugins/parallax-engine.d.ts"]) {
    const path = join(paths.configRoot, legacy)
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`Legacy asset is not a regular file: ${path}`)
  }
  const priorAssets = new Map((manifest?.assets || []).map((asset) => [asset.path, asset]))
  const priorHashes = new Map((manifest?.assets || []).map((asset) => [asset.path, asset.sha256]))
  const changes = []
  const backups = []
  const stamp = timestamp()

  const plugins = Array.isArray(openCode.value.plugin) ? openCode.value.plugin : []
  const desiredPlugins = plugins.filter((p) => !LEGACY_ENTRIES.includes(p))
  const registrationAdded = !desiredPlugins.includes(PLUGIN_ENTRY)
  if (registrationAdded) desiredPlugins.push(PLUGIN_ENTRY)
  // Ownership is explicit. A registration that pre-dated the first managed
  // install remains the user's and will not be removed by uninstall.
  const registrationManaged = manifest?.registrationManaged === true || registrationAdded
  const configChanged = JSON.stringify(plugins) !== JSON.stringify(desiredPlugins)
  if (configChanged || openCode.text === null) changes.push({ type: "config", path: paths.configFile })

  for (const asset of assets) {
    const destination = join(paths.configRoot, asset.relative)
    if (!existsSync(destination) || lstatSync(destination).isDirectory() || fileSha(destination) !== asset.hash)
      changes.push({ type: "asset", path: destination })
  }
  for (const legacy of ["plugins/parallax-engine.js", "plugins/parallax-engine.d.ts"]) {
    const path = join(paths.configRoot, legacy)
    if (existsSync(path)) changes.push({ type: "remove-legacy", path })
  }
  const desiredPaths = new Set(assets.map((asset) => asset.relative))
  const carriedPriorAssets = []
  for (const prior of manifest?.assets || []) {
    if (desiredPaths.has(prior.path) || prior.managed !== true) continue
    const destination = join(paths.configRoot, prior.path)
    assertSafeDestination(paths.configRoot, destination)
    if (!existsSync(destination)) continue
    if (!lstatSync(destination).isFile()) throw new Error(`Stale managed asset is not a regular file: ${destination}`)
    if (fileSha(destination) === prior.sha256) changes.push({ type: "remove-stale", path: destination })
    else carriedPriorAssets.push(prior) // Preserve customized orphan ownership for doctor/uninstall.
  }
  const desiredAssetRecords = [...assets.map((asset) => {
    const destination = join(paths.configRoot, asset.relative)
    const currentHash = existsSync(destination) && lstatSync(destination).isFile() ? fileSha(destination) : null
    // Existing byte-identical files are adopted for status checks but not
    // claimed for deletion. Files this installer creates or replaces are owned.
    const managed = priorAssets.get(asset.relative)?.managed === true || currentHash !== asset.hash
    return { path: asset.relative, sha256: asset.hash, managed }
  }), ...carriedPriorAssets]
  const manifestChanged = !manifest || manifest.package !== PLUGIN_ENTRY ||
    manifest.version !== packageVersion() || manifest.configFile !== basename(paths.configFile) ||
    manifest.registrationManaged !== registrationManaged ||
    JSON.stringify(manifest.assets) !== JSON.stringify(desiredAssetRecords)
  if (manifestChanged) changes.push({ type: "manifest", path: paths.manifest })

  const report = {
    command: "install", dryRun: options.dryRun, configRoot: paths.configRoot,
    configFile: paths.configFile, changed: changes.map((x) => normalizedRelative(paths.configRoot, x.path)),
    backups, installed: !options.dryRun, version: packageVersion(),
  }
  if (options.dryRun) return report

  // All parsing, validation and source reads happened before the first mutation.
  const rollback = []
  try {
    const saveOriginal = (path, backupRelative, shouldBackup) => {
      if (!existsSync(path)) { rollback.push({ path, data: null }); return }
      const data = readFileSync(path)
      rollback.push({ path, data })
      if (shouldBackup) {
        const destination = backupPath(paths, stamp, backupRelative)
        atomicWrite(destination, data)
        backups.push(normalizedRelative(paths.configRoot, destination))
      }
    }

    if (configChanged || openCode.text === null) {
      saveOriginal(paths.configFile, basename(paths.configFile), openCode.text !== null)
      const next = { ...openCode.value, plugin: desiredPlugins }
      atomicWrite(paths.configFile, JSON.stringify(next, null, 2) + "\n")
    }

    for (const asset of assets) {
      const destination = join(paths.configRoot, asset.relative)
      const currentExists = existsSync(destination)
      const currentHash = currentExists && !lstatSync(destination).isDirectory() ? fileSha(destination) : null
      if (currentHash === asset.hash) continue
      if (currentExists && lstatSync(destination).isDirectory()) throw new Error(`Cannot replace directory with managed file: ${destination}`)
      const wasManaged = currentHash !== null && priorHashes.get(asset.relative) === currentHash
      saveOriginal(destination, asset.relative, currentExists && !wasManaged)
      atomicWrite(destination, asset.data)
    }

    for (const prior of manifest?.assets || []) {
      if (desiredPaths.has(prior.path) || prior.managed !== true) continue
      const destination = join(paths.configRoot, prior.path)
      if (!existsSync(destination) || !lstatSync(destination).isFile() || fileSha(destination) !== prior.sha256) continue
      saveOriginal(destination, prior.path, false)
      rmSync(destination)
    }

    for (const legacy of ["plugins/parallax-engine.js", "plugins/parallax-engine.d.ts"]) {
      const path = join(paths.configRoot, legacy)
      if (!existsSync(path)) continue
      if (!lstatSync(path).isFile()) throw new Error(`Legacy asset is not a regular file: ${path}`)
      saveOriginal(path, legacy, true)
      rmSync(path)
    }

    if (manifestChanged) {
      const installedManifest = {
        schemaVersion: 1, package: PLUGIN_ENTRY, version: packageVersion(),
        installedAt: new Date().toISOString(), configFile: basename(paths.configFile),
        registrationManaged, assets: desiredAssetRecords,
      }
      saveOriginal(paths.manifest, MANIFEST_NAME, false)
      atomicWrite(paths.manifest, JSON.stringify(installedManifest, null, 2) + "\n")
    }
    return report
  } catch (error) {
    for (const entry of rollback.reverse()) {
      try { entry.data === null ? rmSync(entry.path, { force: true }) : atomicWrite(entry.path, entry.data) } catch { /* retain original error */ }
    }
    throw error
  }
}

function assetStatus(state) {
  const desired = new Map(state.assets.map((a) => [a.relative, a.hash]))
  const managed = new Map((state.manifest?.assets || []).map((a) => [a.path, a.sha256]))
  const names = new Set([...desired.keys(), ...managed.keys()])
  return [...names].sort().map((name) => {
    const path = join(state.paths.configRoot, name)
    if (!existsSync(path)) return { path: name, state: "missing" }
    if (!lstatSync(path).isFile()) return { path: name, state: "customized", detail: "not a regular file" }
    const current = fileSha(path)
    if (desired.get(name) === current) return { path: name, state: "current" }
    if (managed.get(name) === current) return { path: name, state: "stale" }
    return { path: name, state: "customized" }
  })
}

function statusReport(state) {
  const plugins = Array.isArray(state.openCode.value.plugin) ? state.openCode.value.plugin : []
  const assets = assetStatus(state)
  const registered = plugins.includes(PLUGIN_ENTRY)
  const desiredHashes = new Map(state.assets.map((asset) => [asset.relative, asset.hash]))
  const manifestAssetsCurrent = Boolean(state.manifest &&
    state.manifest.assets.length === desiredHashes.size &&
    state.manifest.assets.every((asset) =>
      desiredHashes.get(asset.path) === asset.sha256 && typeof asset.managed === "boolean"))
  const manifestCurrent = Boolean(state.manifest &&
    state.manifest.package === PLUGIN_ENTRY &&
    state.manifest.version === packageVersion() &&
    state.manifest.configFile === basename(state.paths.configFile) &&
    typeof state.manifest.registrationManaged === "boolean" && manifestAssetsCurrent)
  const healthy = registered && manifestCurrent && assets.length > 0 && assets.every((a) => a.state === "current")
  return {
    command: "status", healthy, installed: Boolean(state.manifest), registered,
    version: packageVersion(), configRoot: state.paths.configRoot, configFile: state.paths.configFile,
    manifest: state.paths.manifest,
    installation: state.manifest ? {
      package: state.manifest.package || null,
      version: state.manifest.version || null,
      configFile: state.manifest.configFile || null,
      registrationManaged: state.manifest.registrationManaged === true,
      current: manifestCurrent,
    } : null,
    assets,
  }
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: platform() === "win32", timeout: 5000 })
  if (result.error || result.status !== 0) return { available: false, version: null, error: result.error?.message || (result.stderr || "command failed").trim() }
  return { available: true, version: (result.stdout || result.stderr || "unknown").trim().split(/\r?\n/)[0] }
}

function doctorReport(state) {
  const status = statusReport(state)
  const opencode = commandVersion("opencode", ["--version"])
  const failures = []
  if (!opencode.available) failures.push({ code: "opencode-not-found", message: "OpenCode is unavailable", fix: "Install OpenCode and ensure `opencode --version` succeeds." })
  if (!status.registered) failures.push({ code: "plugin-not-registered", message: "Parallax is not registered", fix: "Run `parallax-opencode install`." })
  if (!state.manifest) failures.push({ code: "manifest-missing", message: "Managed install manifest is missing", fix: "Run `parallax-opencode install` to adopt/install assets." })
  else if (!status.installation?.current) failures.push({ code: "manifest-stale", message: "Managed install metadata does not match this package/config target", fix: "Run `parallax-opencode install` to safely refresh the manifest and assets." })
  const badAssets = status.assets.filter((a) => a.state !== "current")
  if (badAssets.length) failures.push({ code: "assets-not-current", message: `${badAssets.length} asset(s) are missing, stale, or customized`, fix: "Review backups, then run `parallax-opencode install`." })
  const canWrite = writable(state.paths.configRoot)
  if (!canWrite) failures.push({ code: "config-not-writable", message: "OpenCode config root is not writable", fix: `Grant write access to ${state.paths.configRoot}.` })
  return {
    command: "doctor", healthy: failures.length === 0,
    versions: { node: process.version, plugin: packageVersion(), opencode },
    paths: {
      configRoot: state.paths.configRoot, configFile: state.paths.configFile,
      manifest: state.paths.manifest, projectConfig: state.paths.projectConfig,
    },
    effectiveConfig: state.project.effective,
    writability: { configRoot: canWrite, configFile: writable(state.paths.configFile) },
    registration: {
      registered: status.registered, entry: PLUGIN_ENTRY,
      managed: state.manifest?.registrationManaged === true,
    },
    assets: status.assets,
    verificationCommands: [
      "node --version", "opencode --version", "parallax-opencode status --json",
      `parallax-opencode doctor --json --config-dir ${JSON.stringify(state.paths.configRoot)}`,
    ],
    failures,
  }
}

function performUninstall(state, options) {
  const { paths, openCode, manifest } = state
  const plugins = Array.isArray(openCode.value.plugin) ? openCode.value.plugin : []
  // Remove one registration only when the manifest proves this lifecycle
  // added it. Pre-existing/manual registrations and duplicate entries remain.
  const nextPlugins = [...plugins]
  const managedRegistrationIndex = manifest?.registrationManaged === true
    ? nextPlugins.lastIndexOf(PLUGIN_ENTRY)
    : -1
  if (managedRegistrationIndex >= 0) nextPlugins.splice(managedRegistrationIndex, 1)
  const removeConfigEntry = managedRegistrationIndex >= 0
  const removable = [], preserved = []
  for (const asset of manifest?.assets || []) {
    const path = join(paths.configRoot, asset.path)
    if (!existsSync(path)) continue
    if (asset.managed === true && lstatSync(path).isFile() && fileSha(path) === asset.sha256) removable.push(path)
    else preserved.push(asset.path)
  }
  const changed = [...removable.map((p) => normalizedRelative(paths.configRoot, p))]
  if (removeConfigEntry) changed.push(basename(paths.configFile))
  if (manifest) changed.push(MANIFEST_NAME)
  const backups = []
  const report = { command: "uninstall", dryRun: options.dryRun, configRoot: paths.configRoot, changed, preserved, backups, uninstalled: !options.dryRun }
  if (options.dryRun) return report

  const rollback = [], stamp = timestamp()
  try {
    if (removeConfigEntry) {
      const original = readFileSync(paths.configFile)
      rollback.push({ path: paths.configFile, data: original })
      const configBackup = backupPath(paths, stamp, basename(paths.configFile))
      atomicWrite(configBackup, original)
      backups.push(normalizedRelative(paths.configRoot, configBackup))
      const next = { ...openCode.value, plugin: nextPlugins }
      atomicWrite(paths.configFile, JSON.stringify(next, null, 2) + "\n")
    }
    for (const path of removable) {
      rollback.push({ path, data: readFileSync(path) })
      rmSync(path)
    }
    // Remove only empty, Parallax-specific skill directories; shared agents/
    // and skills/ roots always remain available to unrelated OpenCode config.
    for (const directory of ["skills/parallax-plan", "skills/parallax-debug"]) {
      try { rmdirSync(join(paths.configRoot, directory)) } catch { /* customized/non-empty: preserve */ }
    }
    if (manifest) {
      rollback.push({ path: paths.manifest, data: readFileSync(paths.manifest) })
      rmSync(paths.manifest)
    }
    return report
  } catch (error) {
    for (const entry of rollback.reverse()) { try { atomicWrite(entry.path, entry.data) } catch { /* retain original error */ } }
    throw error
  }
}

function printHuman(report) {
  const prefix = "[parallax]"
  if (report.command === "install") {
    console.log(`${prefix} ${report.dryRun ? "install dry-run" : "install complete"}`)
    console.log(`${prefix} config root: ${report.configRoot}`)
    for (const path of report.changed) console.log(`${prefix} ${report.dryRun ? "would change" : "changed"}: ${path}`)
    for (const path of report.backups) console.log(`${prefix} backup: ${path}`)
    if (!report.changed.length) console.log(`${prefix} already current`)
  } else if (report.command === "uninstall") {
    console.log(`${prefix} ${report.dryRun ? "uninstall dry-run" : "uninstall complete"}`)
    for (const path of report.changed) console.log(`${prefix} ${report.dryRun ? "would remove/change" : "removed/changed"}: ${path}`)
    for (const path of report.preserved) console.log(`${prefix} preserved customized asset: ${path}`)
    for (const path of report.backups) console.log(`${prefix} backup: ${path}`)
  } else if (report.command === "status") {
    console.log(`${prefix} status: ${report.healthy ? "healthy" : "attention required"}`)
    console.log(`${prefix} config: ${report.configFile}`)
    console.log(`${prefix} plugin registered: ${report.registered ? "yes" : "no"}`)
    if (!report.installation) console.log(`${prefix} install manifest: missing`)
    else if (!report.installation.current) console.log(`${prefix} install manifest: stale (${report.installation.version || "unknown version"})`)
    for (const asset of report.assets) console.log(`${prefix} asset ${asset.state}: ${asset.path}`)
  } else {
    console.log(`${prefix} doctor: ${report.healthy ? "healthy" : "failures found"}`)
    console.log(`${prefix} versions: Node ${report.versions.node}, plugin ${report.versions.plugin}, OpenCode ${report.versions.opencode.version || "unavailable"}`)
    console.log(`${prefix} config root: ${report.paths.configRoot} (writable: ${report.writability.configRoot})`)
    console.log(`${prefix} effective config: ${JSON.stringify(report.effectiveConfig)}`)
    for (const asset of report.assets) console.log(`${prefix} asset ${asset.state}: ${asset.path}`)
    for (const failure of report.failures) console.log(`${prefix} FAIL ${failure.message}. ${failure.fix}`)
    console.log(`${prefix} verification: ${report.verificationCommands.join("; ")}`)
  }
}

export function run(argv = process.argv.slice(2)) {
  let options
  try { options = parseArgs(argv) }
  catch (error) {
    console.error(`[parallax] ${error instanceof Error ? error.message : String(error)}`)
    console.error("Run 'parallax-opencode help' for usage.")
    return 2
  }
  if (options.help) { console.log(usage()); return 0 }
  try {
    const state = preflight(options)
    let report
    if (options.command === "install") report = performInstall(state, options)
    else if (options.command === "uninstall") report = performUninstall(state, options)
    else if (options.command === "status") report = statusReport(state)
    else report = doctorReport(state)
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else printHuman(report)
    return (options.command === "status" || options.command === "doctor") && !report.healthy ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (options.json) console.log(JSON.stringify({ command: options.command, healthy: false, error: message, actionable: "Fix the reported configuration error and retry; no lifecycle changes were made." }, null, 2))
    else console.error(`[parallax] ERROR: ${message}\n[parallax] No lifecycle changes were made. Fix the configuration and retry.`)
    return 1
  }
}

const isMain = process.argv[1] &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) process.exitCode = run()
