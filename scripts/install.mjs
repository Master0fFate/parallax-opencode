#!/usr/bin/env node
import { mkdirSync, copyFileSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync } from "fs"
import { homedir, platform } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

const CONFIG = (() => {
  const base = platform() === "win32"
    ? join(homedir(), ".config", "opencode")
    : join(homedir(), ".config", "opencode")
  return base
})()

const FILES = {
  agents: [
    { src: join(ROOT, "agents", "parallax.md"), dest: join(CONFIG, "agents", "parallax.md") },
    { src: join(ROOT, "agents", "horizon.md"),  dest: join(CONFIG, "agents", "horizon.md") },
  ],
  skills: [
    { name: "parallax-plan",  src: join(ROOT, "skills", "parallax-plan"),    dest: join(CONFIG, "skills", "parallax-plan") },
    { name: "parallax-debug", src: join(ROOT, "skills", "parallax-debug"),   dest: join(CONFIG, "skills", "parallax-debug") },
  ],
}

function log(msg) {
  console.log(`[parallax] ${msg}`)
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function copyFiles() {
  ensureDir(join(CONFIG, "plugins"))
  ensureDir(join(CONFIG, "agents"))
  ensureDir(join(CONFIG, "skills"))

  // Remove old standalone plugin file (now loaded from node_modules)
  const oldPluginPath = join(CONFIG, "plugins", "parallax-engine.js")
  if (existsSync(oldPluginPath)) {
    log(`removing old standalone plugin -> ${oldPluginPath}`)
    rmSync(oldPluginPath)
  }
  const oldDtsPath = join(CONFIG, "plugins", "parallax-engine.d.ts")
  if (existsSync(oldDtsPath)) rmSync(oldDtsPath)

  for (const ag of FILES.agents) {
    log(`copying agent   -> ${ag.dest}`)
    copyFileSync(ag.src, ag.dest)
  }

  for (const sk of FILES.skills) {
    if (!existsSync(sk.src)) {
      throw new Error(`installer manifest points at missing skill: ${sk.src}`)
    }
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
  const oldEntries = ["./plugins/parallax-engine.js", "parallax-engine"]

  try {
    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf8"))
      : {}

    if (!Array.isArray(config.plugin)) {
      config.plugin = []
    }

    // Remove old deprecated entries
    const hadOld = config.plugin.some((p) => oldEntries.includes(p))
    config.plugin = config.plugin.filter((p) => !oldEntries.includes(p))

    // Add new entry if not present
    if (!config.plugin.includes(pluginEntry)) {
      config.plugin.push(pluginEntry)
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
      log("registered parallax-opencode plugin in opencode.json")
    } else if (hadOld) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
      log("migrated old plugin entry to parallax-opencode")
    } else {
      log("plugin already registered in opencode.json")
    }
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
      log("created opencode.json and registered parallax-opencode plugin")
    }
  } catch (err) {
    throw new Error(`failed to register plugin: ${String(err && err.message ? err.message : err)}`)
  }
}

function main() {
  log(`config directory: ${CONFIG}`)
  log("installing agents, mode skills, and explicit plugin registration")
  copyFiles()
  registerPlugin()
  log("done! restart OpenCode to load Parallax Engine.")
  log("press [Tab] in the TUI to cycle to the Parallax agent.")
}

main()
