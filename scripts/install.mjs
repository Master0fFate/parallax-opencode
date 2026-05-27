#!/usr/bin/env node
import { mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "fs"
import { homedir, platform } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

const CONFIG = (() => {
  const base = platform() === "win32"
    ? join(homedir(), ".config", "opencode")
    : join(homedir(), ".config", "opencode")
  return base
})()

const PLUGIN_SRC_CANDIDATES = [
  join(ROOT, "dist-standalone", "parallax-engine.js"),
  join(ROOT, "dist", "plugin.js"),
  join(ROOT, "src", "plugin.ts"),
]
function resolvePluginSrc() {
  for (const candidate of PLUGIN_SRC_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return PLUGIN_SRC_CANDIDATES[0] // fall through to first even if missing
}
const FILES = {
  plugin: { src: resolvePluginSrc(), dest: join(CONFIG, "plugins", "parallax-engine.js") },
  agents: [
    { src: join(ROOT, "agents", "parallax.md"), dest: join(CONFIG, "agents", "parallax.md") },
    { src: join(ROOT, "agents", "horizon.md"),  dest: join(CONFIG, "agents", "horizon.md") },
  ],
  skills: [
    { name: "parallax",       src: join(ROOT, "skills", "parallax"),         dest: join(CONFIG, "skills", "parallax") },
    { name: "parallax-plan",  src: join(ROOT, "skills", "parallax-plan"),    dest: join(CONFIG, "skills", "parallax-plan") },
    { name: "parallax-debug", src: join(ROOT, "skills", "parallax-debug"),   dest: join(CONFIG, "skills", "parallax-debug") },
    { name: "horizon",        src: join(ROOT, "skills", "horizon"),          dest: join(CONFIG, "skills", "horizon") },
  ],
}

const DEP = "@opencode-ai/plugin"
const DEP_PATH = join(CONFIG, "node_modules", DEP.replace("/", join("node_modules", "")))

function log(msg) {
  console.log(`[parallax] ${msg}`)
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function ensureDependency() {
  if (!existsSync(DEP_PATH)) {
    log(`installing ${DEP}...`)
    const pkgPath = join(CONFIG, "package.json")
    if (!existsSync(pkgPath)) {
      execSync("npm init -y", { cwd: CONFIG, stdio: "pipe" })
    }
    execSync(`npm install ${DEP}`, { cwd: CONFIG, stdio: "pipe" })
    log(`${DEP} installed`)
  } else {
    log(`${DEP} already installed`)
  }
}

function copyFiles() {
  ensureDir(join(CONFIG, "plugins"))
  ensureDir(join(CONFIG, "agents"))
  ensureDir(join(CONFIG, "skills"))

  log(`copying plugin  -> ${FILES.plugin.dest}`)
  copyFileSync(FILES.plugin.src, FILES.plugin.dest)

  for (const ag of FILES.agents) {
    log(`copying agent   -> ${ag.dest}`)
    copyFileSync(ag.src, ag.dest)
  }

  for (const sk of FILES.skills) {
    log(`copying skill   -> ${sk.dest}`)
    if (existsSync(sk.dest)) {
      cpSync(sk.src, sk.dest, { recursive: true, force: true })
    } else {
      cpSync(sk.src, sk.dest, { recursive: true })
    }
  }
}

function registerPlugin() {
  const configPath = join(CONFIG, "opencode.json")
  const pluginEntry = "parallax-opencode"

  if (!existsSync(configPath)) {
    log("no opencode.json found -- skipping registration")
    return
  }

  try {
    const raw = readFileSync(configPath, "utf8")
    const config = JSON.parse(raw)

    if (!Array.isArray(config.plugin)) {
      config.plugin = []
    }

    // Check if already registered (by name, old path, or old name)
    const alreadyRegistered = config.plugin.some(
      (p) => p === pluginEntry || p === "parallax-engine" || p === "./plugins/parallax-engine.js",
    )

    if (alreadyRegistered) {
      log("plugin already registered in opencode.json")
      return
    }

    config.plugin.push(pluginEntry)
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
    log("registered parallax-opencode plugin in opencode.json")
  } catch (err) {
    log(`failed to register plugin: ${String(err && err.message ? err.message : err)}`)
  }
}

function ensureNpmPackage() {
  const pkgPath = join(CONFIG, "node_modules", "parallax-opencode")
  if (existsSync(pkgPath)) {
    log("parallax-opencode already in node_modules")
    return
  }
  log("installing parallax-opencode package in node_modules...")
  execSync("npm install parallax-opencode@latest --ignore-scripts", {
    cwd: CONFIG,
    stdio: "pipe",
  })
  log("parallax-opencode installed in node_modules")
}

function main() {
  log(`config directory: ${CONFIG}`)
  copyFiles()
  ensureNpmPackage()
  ensureDependency()
  registerPlugin()
  log("done! restart OpenCode to load Parallax Engine.")
  log("press [Tab] in the TUI to cycle to the Parallax agent.")
}

main()
