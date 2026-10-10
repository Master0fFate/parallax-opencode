import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url))

type Action = "allow" | "ask" | "deny"
type Permission = Record<string, Action | Record<string, Action>>

export interface AgentDefinition {
  description: string
  mode: "primary" | "subagent"
  color: string
  permission: Permission
  prompt: string
}

const DEFINITIONS: Record<string, Omit<AgentDefinition, "prompt">> = {
  parallax: {
    description: "Evidence-led coding agent: preflight, change, verify, receipt.",
    mode: "primary",
    color: "#6c63ff",
    permission: { edit: "allow", bash: "ask", "horizon_*": "deny" },
  },
  horizon: {
    description: "Durable supervisor for long-running goals: plans, delegates one brief at a time, verifies, resumes.",
    mode: "primary",
    color: "#00bcd4",
    permission: {
      edit: "deny",
      bash: "ask",
      task: { "*": "deny", "horizon-worker": "allow", "horizon-auditor": "allow" },
    },
  },
  "horizon-worker": {
    description: "Implements exactly one Horizon brief and returns receipt evidence.",
    mode: "subagent",
    color: "#26a69a",
    permission: { edit: "allow", bash: "ask", task: "deny", question: "deny", "horizon_*": "deny" },
  },
  "horizon-auditor": {
    description: "Read-only independent audit of one Horizon brief.",
    mode: "subagent",
    color: "#7e57c2",
    permission: { edit: "deny", bash: "deny", task: "deny", question: "deny", todowrite: "deny", "parallax_*": "deny" },
  },
}

export const AGENT_NAMES = new Set(Object.keys(DEFINITIONS))

export function loadAgents(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {}
  for (const [name, definition] of Object.entries(DEFINITIONS)) {
    const prompt = readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8").trim()
    agents[name] = { ...definition, prompt }
  }
  return agents
}
