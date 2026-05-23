/**
 * PARALLAX Discord Rich Presence Module
 *
 * ## BROKEN
 * Discord RPC is not working. The @xhayper/discord-rpc library connects
 * via IPC but presence never appears. Suspected issues:
 *   - esbuild bundling may mangle the IPC transport (node:net, node:fs, node:path)
 *   - Discord IPC pipe discovery may fail in OpenCode's process context
 *   - The "ready" event sequence from login() may not match expectations
 * Needs proper debugging with a test harness outside the plugin bundle.
 *
 * Transferred from the parallax Rust codebase (src/rpc/mod.rs).
 * Uses the same Discord Application ID (1498076324357476494) and
 * the "parallaxtui" large image asset already registered in the
 * Discord Developer Portal for that application.
 *
 * Image switching by agent:
 *   - Agent "parallax"  -> largeImageKey = "parallaxtui"
 *   - Agent "opencode"  -> largeImageKey = "opencode.png"
 *   - Agent null        -> no image, text only
 *   - details always    -> "OpenCode"
 *
 * Integrates with the existing plugin hook model rather than
 * registering standalone hooks, to avoid conflicts with the
 * Parallax protocol enforcement hooks.
 *
 * References:
 *   - Original Rust implementation: parallax/src/rpc/mod.rs
 *   - Reference TS plugin: phoenixak/opencode-discord-rpc
 */

import { Client } from "@xhayper/discord-rpc"
import type { SetActivity } from "@xhayper/discord-rpc"

// ---------------------------------------------------------------------------
// Constants -- transferred from parallax Rust RPC module
// ---------------------------------------------------------------------------

const PARALLAX_CLIENT_ID = "1498076324357476494"

// Parallax images (uploaded to Discord Developer Portal for this app)
// Discord strips file extensions -- key is just the name.
const PARALLAX_IMAGE_KEY = "parallaxtui"
const PARALLAX_IMAGE_TEXT = "ParallaxTUI"

// OpenCode fallback image
const OPENCODE_IMAGE_KEY = "opencode"
const OPENCODE_IMAGE_TEXT = "OpenCode"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RpcStatus = "coding" | "idle" | "thinking" | "waiting"

/**
 * Which agent type is currently active.
 * - "parallax": Parallax engine is in control; show parallaxtui image
 * - "opencode": OpenCode built-in modes; show opencode.png
 * - null:       Unknown / none; text only, no image
 */
export type RpcAgent = "parallax" | "opencode" | null

export interface RpcPresenceData {
  status: RpcStatus
  modelName?: string
  mode?: string
  agent?: RpcAgent
}

// ---------------------------------------------------------------------------
// RPC Manager
// ---------------------------------------------------------------------------

export class DiscordRpcManager {
  private client: Client | null = null
  private isConnected = false
  private connecting = false
  private retryCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private sessionStart: Date | null = null
  private currentPresence: RpcPresenceData | null = null
  private destroyed = false

  private maxRetries = 10
  private retryIntervalMs = 15000

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  async connect(): Promise<boolean> {
    if (this.destroyed) return false
    if (this.isConnected || this.connecting) return this.isConnected

    this.connecting = true

    try {
      this.client = new Client({ clientId: PARALLAX_CLIENT_ID })

      this.client.on("ready", () => {
        this.isConnected = true
        this.connecting = false
        this.retryCount = 0
        this.log("Connected to Discord Rich Presence")

        // Restore presence if we had one before reconnect
        if (this.currentPresence) {
          this.setActivity(this.currentPresence)
        }
      })

      this.client.on("disconnected", () => {
        this.isConnected = false
        this.log("Disconnected from Discord", "warn")
        if (!this.destroyed) this.scheduleReconnect()
      })

      // login() calls connect() internally then emits "ready".
      // Using just connect() would never fire the "ready" event.
      await this.client.login()
      return true
    } catch (err) {
      this.connecting = false
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes("ENOENT") || msg.includes("Could not connect")) {
        this.log("Discord not running or not accessible", "debug")
      } else {
        this.log(`Discord RPC connection failed: ${msg}`, "warn")
      }

      if (!this.destroyed) this.scheduleReconnect()
      return false
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    if (this.retryCount >= this.maxRetries) {
      this.log(
        `Discord RPC: max retries (${this.maxRetries}) reached, giving up`,
        "warn",
      )
      return
    }

    this.retryCount++
    if (this.retryTimer) clearTimeout(this.retryTimer)

    this.retryTimer = setTimeout(() => {
      if (!this.destroyed) this.connect()
    }, this.retryIntervalMs)
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  startSession(): void {
    this.sessionStart = new Date()
    this.log("RPC session started, timer reset", "debug")
  }

  clearSession(): void {
    this.sessionStart = null
  }

  // -----------------------------------------------------------------------
  // Presence
  // -----------------------------------------------------------------------

  async updatePresence(data: RpcPresenceData): Promise<void> {
    this.currentPresence = data
    if (!this.isConnected || !this.client?.user) return

    await this.setActivity(data)
  }

  private async setActivity(data: RpcPresenceData): Promise<void> {
    if (!this.client?.user) return

    // details is always "OpenCode" regardless of agent
    const details = "OpenCode"

    // state shows status + optional mode suffix
    const statusText = this.statusLabel(data.status)
    const state = data.mode
      ? `${statusText} | ${data.mode}`
      : statusText

    const activity: SetActivity = {
      details,
      state,
    }

    // Choose the image based on agent type
    if (data.agent === "parallax") {
      activity.largeImageKey = PARALLAX_IMAGE_KEY
      activity.largeImageText = PARALLAX_IMAGE_TEXT
      activity.smallImageKey = PARALLAX_IMAGE_KEY
      activity.smallImageText = `${PARALLAX_IMAGE_TEXT} | ${statusText}`
    } else if (data.agent === "opencode") {
      activity.largeImageKey = OPENCODE_IMAGE_KEY
      activity.largeImageText = OPENCODE_IMAGE_TEXT
      activity.smallImageKey = OPENCODE_IMAGE_KEY
      activity.smallImageText = `${OPENCODE_IMAGE_TEXT} | ${statusText}`
    }
    // agent === null: no images, text only

    if (this.sessionStart) {
      activity.startTimestamp = this.sessionStart
    }

    if (data.mode) {
      activity.buttons = [
        {
          label: `Mode: ${data.mode}`,
          url: "https://github.com/Master0fFate/parallax-opencode",
        },
      ]
    }

    try {
      await this.client.user.setActivity(activity)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Failed to set activity: ${msg}`, "error")
    }
  }

  async clearPresence(): Promise<void> {
    if (!this.isConnected || !this.client?.user) return
    try {
      await this.client.user.clearActivity()
      this.currentPresence = null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.log(`Failed to clear activity: ${msg}`, "error")
    }
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  async destroy(): Promise<void> {
    this.destroyed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.client) {
      try {
        await this.clearPresence()
        this.client.destroy()
      } catch {
        // Ignore cleanup errors
      }
      this.client = null
    }
    this.isConnected = false
    this.connecting = false
    this.log("Discord RPC destroyed", "info")
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private statusLabel(status: RpcStatus): string {
    switch (status) {
      case "coding":
        return "Coding..."
      case "idle":
        return "Idle"
      case "thinking":
        return "Thinking..."
      case "waiting":
        return "Waiting for input..."
      default:
        return "OpenCode"
    }
  }

  private log(msg: string, level: "info" | "warn" | "error" | "debug" = "info"): void {
    const prefix = "[parallax:discord-rpc]"
    switch (level) {
      case "warn":
        console.warn(`${prefix} ${msg}`)
        break
      case "error":
        console.error(`${prefix} ${msg}`)
        break
      case "debug":
        if (process.env.DEBUG) console.debug(`${prefix} ${msg}`)
        break
      default:
        console.log(`${prefix} ${msg}`)
    }
  }

  get connected(): boolean {
    return this.isConnected
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve agent type from OpenCode agent name
// ---------------------------------------------------------------------------

/**
 * Map an OpenCode agent selector name to an RPC agent type.
 *
 * OpenCode agents you TAB between:
 *   "Parallax" -> "parallax" (show parallaxtui.png)
 *   "Plan", "Build", "Agent", "Debug" (OpenCode built-in) -> "opencode" (opencode.png)
 *   anything else / null -> null (text only, no image)
 */
export function resolveAgent(agentName: string | null | undefined): RpcAgent {
  if (!agentName) return null
  const lower = agentName.toLowerCase()
  if (lower === "parallax") return "parallax"
  // Everything else is an OpenCode built-in agent
  return "opencode"
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: DiscordRpcManager | null = null

export function getDiscordRpc(): DiscordRpcManager {
  if (!_instance) {
    _instance = new DiscordRpcManager()
  }
  return _instance
}

export async function initDiscordRpc(): Promise<DiscordRpcManager> {
  const mgr = getDiscordRpc()
  await mgr.connect()
  return mgr
}

export async function destroyDiscordRpc(): Promise<void> {
  if (_instance) {
    await _instance.destroy()
    _instance = null
  }
}
