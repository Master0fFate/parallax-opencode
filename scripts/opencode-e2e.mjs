#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TOOLS = ["parallax_preflight", "parallax_verify", "parallax_receipt", "parallax_trace", "horizon_plan", "horizon_feature", "horizon_note"]
const SKILLS = ["parallax-plan", "parallax-debug", "parallax-hyperplan"]
const temp = mkdtempSync(join(tmpdir(), "parallax-e2e-"))
let server

const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" && command === "npm", stdio: ["ignore", "pipe", "pipe"], ...options,
})

const port = () => new Promise((done, fail) => {
  const socket = net.createServer()
  socket.unref()
  socket.once("error", fail)
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address()
    socket.close((error) => (error ? fail(error) : done(port)))
  })
})

async function poll(url, child, logs) {
  const deadline = Date.now() + 60_000
  let last = "no response"
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited with ${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return Array.isArray(body) ? body : body?.data
    } catch (error) {
      last = error.message
      await new Promise((wait) => setTimeout(wait, 250))
    }
  }
  throw new Error(`OpenCode did not answer ${url}: ${last}\n${logs()}`)
}

const action = (agent, permission, pattern = "*") => agent.permission.filter((rule) => rule.permission === permission && rule.pattern === pattern).at(-1)?.action

try {
  const dirs = Object.fromEntries(["pack", "prefix", "config", "home", "workspace"].map((name) => [name, join(temp, name)]))
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

  const packed = Object.values(JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dirs.pack])))[0]
  run("npm", ["install", "--prefix", dirs.prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(dirs.pack, packed.filename)])
  const installed = join(dirs.prefix, "node_modules", "parallax-opencode")
  run(process.execPath, [join(installed, "scripts", "install.mjs"), "install", "--config-dir", dirs.config])
  const config = JSON.parse(readFileSync(join(dirs.config, "opencode.json"), "utf8"))
  if (!config.plugin.includes("parallax-opencode")) throw new Error("installer did not register the plugin")
  writeFileSync(join(dirs.config, "opencode.json"), JSON.stringify({
    ...config, $schema: "https://opencode.ai/config.json", plugin: [pathToFileURL(join(installed, "dist", "plugin.js")).href],
  }, null, 2))
  writeFileSync(join(dirs.workspace, "package.json"), '{"name":"e2e","private":true}\n')

  const opencodePackage = join(ROOT, "node_modules", "opencode-ai")
  const opencode = join(opencodePackage, "bin", "opencode.exe")
  const binaryVersion = () => run(opencode, ["--version"]).trim()
  let version
  try {
    version = binaryVersion()
  } catch {
    run(process.execPath, [join(opencodePackage, "postinstall.mjs")])
    version = binaryVersion()
  }
  const required = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).devDependencies["opencode-ai"]
  if (version !== required) throw new Error(`expected OpenCode ${required}, received ${version}`)

  const env = Object.fromEntries(["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR"]
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]))
  Object.assign(env, {
    HOME: dirs.home, USERPROFILE: dirs.home,
    APPDATA: join(dirs.home, "AppData", "Roaming"), LOCALAPPDATA: join(dirs.home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(dirs.home, ".config"), XDG_DATA_HOME: join(dirs.home, ".local", "share"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"), XDG_STATE_HOME: join(dirs.home, ".local", "state"),
    OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  })

  const skills = JSON.parse(run(opencode, ["debug", "skill"], { cwd: dirs.workspace, env }).replace(/^[^[]*/, ""))
  const missingSkills = SKILLS.filter((name) => !skills.some((skill) => skill.name === name && skill.location.startsWith(installed)))
  if (missingSkills.length) throw new Error(`packaged skills were not discovered: ${missingSkills.join(", ")}`)

  const listen = await port()
  let output = ""
  server = spawn(opencode, ["serve", "--hostname", "127.0.0.1", "--port", String(listen)], { cwd: dirs.workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => { output = `${output}${chunk}`.slice(-12_000) })
  const logs = () => output.trim()
  const query = `directory=${encodeURIComponent(dirs.workspace)}`

  const tools = await poll(`http://127.0.0.1:${listen}/experimental/tool/ids?${query}`, server, logs)
  const ours = tools.filter((id) => id.startsWith("parallax_") || id.startsWith("horizon_")).sort()
  if (JSON.stringify(ours) !== JSON.stringify([...TOOLS].sort())) throw new Error(`tool surface mismatch: ${ours.join(",")}\n${logs()}`)

  const agents = await poll(`http://127.0.0.1:${listen}/agent?${query}`, server, logs)
  const byName = Object.fromEntries(["parallax", "horizon", "horizon-worker", "horizon-auditor"].map((name) => [name, agents.find((agent) => agent.name === name)]))
  const missingAgents = Object.entries(byName).filter(([, agent]) => !agent).map(([name]) => name)
  if (missingAgents.length) throw new Error(`agents were not discovered: ${missingAgents.join(", ")}\n${logs()}`)
  const checks = [
    [byName.parallax.mode === "primary" && byName.horizon.mode === "primary", "primary agents"],
    [byName["horizon-worker"].mode === "subagent" && byName["horizon-auditor"].mode === "subagent", "subagent modes"],
    [Object.values(byName).every((agent) => agent.model == null && agent.prompt?.length > 200), "inherited model and packaged prompts"],
    [action(byName.horizon, "edit") === "deny" && action(byName.horizon, "task") === "deny" && action(byName.horizon, "task", "horizon-worker") === "allow" && action(byName.horizon, "task", "horizon-auditor") === "allow", "horizon delegation allowlist"],
    [action(byName["horizon-worker"], "edit") === "allow" && action(byName["horizon-worker"], "task") === "deny" && action(byName["horizon-worker"], "horizon_*") === "deny", "worker boundary"],
    [action(byName["horizon-auditor"], "edit") === "deny" && action(byName["horizon-auditor"], "bash") === "deny" && action(byName["horizon-auditor"], "task") === "deny" && action(byName["horizon-auditor"], "parallax_*") === "deny", "auditor boundary"],
  ]
  const failed = checks.filter(([ok]) => !ok).map(([, name]) => name)
  if (failed.length) throw new Error(`real OpenCode disagreed on: ${failed.join(", ")}\n${JSON.stringify(byName, null, 1).slice(0, 4000)}`)

  console.log(`OpenCode ${version} E2E passed: ${ours.length} tools, ${Object.keys(byName).length} agents, ${SKILLS.length} skills`)
} finally {
  if (server && server.exitCode === null) {
    server.kill()
    await Promise.race([new Promise((done) => server.once("exit", done)), new Promise((done) => setTimeout(done, 3_000))])
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  rmSync(temp, { recursive: true, force: true })
}
