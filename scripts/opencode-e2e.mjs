#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const EXPECTED_OPENCODE = /^1\.18\./
const temp = mkdtempSync(join(tmpdir(), "parallax-opencode-e2e-"))
let server

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32" && command === "npm",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const socket = net.createServer()
    socket.unref()
    socket.once("error", reject)
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address()
      const port = typeof address === "object" && address ? address.port : 0
      socket.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForTools(url, child, logs) {
  const deadline = Date.now() + 30_000
  let lastError = "server did not respond"
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited with ${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`)
      const parsed = JSON.parse(body)
      const ids = Array.isArray(parsed) ? parsed : parsed?.data
      if (!Array.isArray(ids)) throw new Error(`unexpected tool response: ${body}`)
      return ids
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw new Error(`OpenCode tool discovery timed out: ${lastError}\n${logs()}`)
}

async function waitForAgents(url, child, logs) {
  const deadline = Date.now() + 30_000
  let lastError = "server did not respond"
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited with ${child.exitCode}\n${logs()}`)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`)
      const parsed = JSON.parse(body)
      const agents = Array.isArray(parsed) ? parsed : parsed?.data
      if (!Array.isArray(agents)) throw new Error(`unexpected agent response: ${body}`)
      return agents
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    }
  }
  throw new Error(`OpenCode agent discovery timed out: ${lastError}\n${logs()}`)
}

try {
  const packDir = join(temp, "pack")
  const prefix = join(temp, "prefix")
  const config = join(temp, "config")
  const home = join(temp, "home")
  const workspace = join(temp, "workspace")
  for (const path of [packDir, prefix, config, home, workspace]) mkdirSync(path, { recursive: true })

  const npm = "npm"
  const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", packDir]))[0]
  const tarball = join(packDir, packed.filename)
  run(npm, ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball])

  const installedPackage = join(prefix, "node_modules", "parallax-opencode")
  const pluginPath = join(installedPackage, "dist", "plugin.js")
  if (!existsSync(pluginPath)) throw new Error("packed plugin entrypoint was not installed")
  run(process.execPath, [join(installedPackage, "scripts", "install.mjs"), "install", "--config-dir", config], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: config, HOME: home, USERPROFILE: home },
  })
  const installedConfig = JSON.parse(readFileSync(join(config, "opencode.json"), "utf8"))
  writeFileSync(join(config, "opencode.json"), JSON.stringify({
    ...installedConfig,
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(pluginPath).href],
  }, null, 2))
  writeFileSync(join(workspace, "package.json"), '{"name":"hermetic-opencode-e2e","private":true}\n')

  const opencodePackage = join(ROOT, "node_modules", "opencode-ai")
  const opencode = join(opencodePackage, "bin", "opencode.exe")
  const provisionOpenCode = () => {
    if (!existsSync(join(opencodePackage, "postinstall.mjs"))) {
      throw new Error("OpenCode E2E unavailable: install the declared opencode-ai devDependency")
    }
    // CI installs with --ignore-scripts. OpenCode's own installer only links
    // the locked, already-installed platform package; it does not read or
    // mutate any user configuration.
    run(process.execPath, [join(opencodePackage, "postinstall.mjs")])
  }
  if (!existsSync(opencode)) provisionOpenCode()
  let version
  try {
    version = run(opencode, ["--version"]).trim()
  } catch {
    provisionOpenCode()
    version = run(opencode, ["--version"]).trim()
  }
  if (!EXPECTED_OPENCODE.test(version)) throw new Error(`expected OpenCode 1.18.x, received ${version}`)

  const isolatedEnv = Object.fromEntries(
    ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "WINDIR", "TEMP", "TMP", "TMPDIR", "CI"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  )
  Object.assign(isolatedEnv, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  })

  const port = await availablePort()
  let stdout = "", stderr = ""
  server = spawn(opencode, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: isolatedEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.setEncoding("utf8")
  server.stderr.setEncoding("utf8")
  server.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000) })
  server.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000) })
  const logs = () => `${stdout}\n${stderr}`.trim()

  const endpoint = `http://127.0.0.1:${port}/experimental/tool/ids?directory=${encodeURIComponent(workspace)}`
  const tools = await waitForTools(endpoint, server, logs)
  const agents = await waitForAgents(
    `http://127.0.0.1:${port}/agent?directory=${encodeURIComponent(workspace)}`,
    server,
    logs,
  )
  const agentNamed = (name) => agents.find((agent) =>
    typeof agent === "object" && agent && agent.name?.toLowerCase() === name.toLowerCase())
  const requiredAgents = ["Horizon", "horizon-worker", "horizon-auditor"]
  const missingAgents = requiredAgents.filter((name) => !agentNamed(name))
  if (missingAgents.length) throw new Error(`packed Horizon agents were not discovered: ${missingAgents.join(", ")}\n${logs()}`)

  const horizonAgent = agentNamed("Horizon")
  const workerAgent = agentNamed("horizon-worker")
  const auditorAgent = agentNamed("horizon-auditor")
  const rules = (agent, permission) => agent.permission.filter((rule) => rule.permission === permission)
  const finalAction = (agent, permission, pattern = "*") =>
    rules(agent, permission).filter((rule) => rule.pattern === pattern).at(-1)?.action
  const taskRules = rules(horizonAgent, "task").slice(-3)
  const expectedTaskRules = [
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "task", pattern: "horizon-worker", action: "allow" },
    { permission: "task", pattern: "horizon-auditor", action: "allow" },
  ]
  if (JSON.stringify(taskRules) !== JSON.stringify(expectedTaskRules)) {
    throw new Error(`real OpenCode did not preserve Horizon's last-match task allowlist: ${JSON.stringify(taskRules)}`)
  }
  if (horizonAgent.mode !== "primary" || workerAgent.mode !== "subagent" || auditorAgent.mode !== "subagent") {
    throw new Error("real OpenCode loaded the Horizon pipeline with incorrect agent modes")
  }
  if ([horizonAgent, workerAgent, auditorAgent].some((agent) => agent.model != null)) {
    throw new Error("packed Horizon agents must not hardcode a model")
  }
  if (finalAction(workerAgent, "edit") !== "allow" || finalAction(workerAgent, "task") !== "deny" ||
      finalAction(workerAgent, "horizon_*") !== "deny" ||
      finalAction(auditorAgent, "edit") !== "deny" || finalAction(auditorAgent, "bash") !== "deny" ||
      finalAction(auditorAgent, "task") !== "deny" || finalAction(auditorAgent, "parallax_*") !== "deny" ||
      finalAction(auditorAgent, "horizon_*") !== "deny" ||
      finalAction(auditorAgent, "horizon_read_plan") !== "allow") {
    throw new Error(`real OpenCode did not enforce the packaged worker/auditor capability boundary: worker=${JSON.stringify(workerAgent.permission)} auditor=${JSON.stringify(auditorAgent.permission)}`)
  }
  const required = [
    "parallax_verify", "parallax_analyze", "parallax_checkin", "parallax_plan", "parallax_build",
    "parallax_debug", "parallax_horizon", "parallax_hyperplan", "parallax_trace_export",
    "parallax_trace_pr_comment", "parallax_trace_view", "parallax_health", "horizon_init_session",
    "horizon_write_plan", "horizon_read_plan", "horizon_update_feature", "horizon_record_verification",
    "horizon_record_audit", "horizon_update_milestone", "horizon_write_state", "horizon_read_state",
    "horizon_append_decision", "horizon_read_decisions", "horizon_write_research", "horizon_read_research",
    "horizon_create_skill", "horizon_list_skills", "horizon_save_trace", "horizon_list_sessions",
    "horizon_session_status", "horizon_evaluate_subagent", "horizon_config",
  ]
  const pluginTools = tools.filter((id) => id.startsWith("parallax_") || id.startsWith("horizon_"))
  const missing = required.filter((tool) => !pluginTools.includes(tool))
  const unexpected = pluginTools.filter((tool) => !required.includes(tool))
  if (missing.length || unexpected.length) {
    throw new Error(`packed plugin tool surface mismatch; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}\n${logs()}`)
  }

  console.log(`OpenCode ${version} packed-plugin E2E passed (${agents.length} agents, ${tools.filter((id) => id.startsWith("parallax_") || id.startsWith("horizon_")).length} tools discovered)`)
} finally {
  if (server && server.exitCode === null) {
    server.kill()
    await Promise.race([
      new Promise((resolveExit) => server.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
    ])
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  rmSync(temp, { recursive: true, force: true })
}
