import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin"
import { plugin } from "../plugin.js"

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function project(root: string, test?: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: test ? { test } : {} }))
}

export const PASS = 'node -e "process.exit(0)"'
export const FAIL = 'node -e "console.error(\'boom\'); process.exit(1)"'

export interface FakeClient {
  prompts: Array<Record<string, unknown>>
  parents: Map<string, string>
  client: PluginInput["client"]
}

export function fakeClient(): FakeClient {
  const prompts: Array<Record<string, unknown>> = []
  const parents = new Map<string, string>()
  const client = {
    app: { log: async () => ({}) },
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: parents.get(path.id) } }),
      promptAsync: async (options: Record<string, unknown>) => {
        prompts.push(options)
        return {}
      },
    },
  } as unknown as PluginInput["client"]
  return { prompts, parents, client }
}

export async function load(root: string, client: PluginInput["client"]): Promise<Hooks> {
  return plugin({ client, directory: root, worktree: root } as PluginInput)
}

export function ctx(sessionID: string, agent: string, root: string): ToolContext {
  return { sessionID, agent, directory: root, worktree: root, messageID: "m", abort: new AbortController().signal, metadata() {}, ask: async () => {} }
}

export async function message(hooks: Hooks, sessionID: string, agent: string, synthetic = false): Promise<void> {
  await hooks["chat.message"]!({ sessionID, agent }, { message: {} as never, parts: [{ type: "text", text: "go", synthetic } as never] })
}

export async function call(hooks: Hooks, name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
  const result = await hooks.tool![name].execute(args as never, context)
  return typeof result === "string" ? result : result.output
}

export async function edit(hooks: Hooks, sessionID: string, filePath: string): Promise<void> {
  await hooks["tool.execute.before"]!({ tool: "edit", sessionID, callID: "c" }, { args: { filePath } })
  await hooks["tool.execute.after"]!({ tool: "edit", sessionID, callID: "c", args: { filePath } }, { title: "", output: "", metadata: {} })
}

export async function system(hooks: Hooks, sessionID: string): Promise<string> {
  const output = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} as never }, output)
  return output.system.join("\n")
}

export async function event(hooks: Hooks, type: string, properties: Record<string, unknown>): Promise<void> {
  await hooks.event!({ event: { type, properties } as never })
}

export function receiptId(text: string): string {
  const match = text.match(/receipt ([0-9a-f-]{36})/)
  if (!match) throw new Error(`no receipt id in: ${text}`)
  return match[1]
}
