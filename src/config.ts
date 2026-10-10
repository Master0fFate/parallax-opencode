import { existsSync, readFileSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import type { ParallaxConfig, Strictness } from "./types.js"
import { globToRegExp } from "./fs.js"

export const DEFAULTS: Readonly<ParallaxConfig> = Object.freeze({
  strictness: "strict",
  trivialPatterns: Object.freeze([]) as unknown as string[],
  highRiskPatterns: Object.freeze([]) as unknown as string[],
  timeoutMs: 120_000,
})

const STRICTNESS: Strictness[] = ["strict", "standard", "relaxed"]
const KEYS = new Set(Object.keys(DEFAULTS))

export function validateConfig(value: unknown, source = "Parallax config"): ParallaxConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be a JSON object`)
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) if (!KEYS.has(key)) throw new Error(`${source} has unknown field: ${key}`)
  const out: ParallaxConfig = { ...DEFAULTS, trivialPatterns: [], highRiskPatterns: [] }
  if (input.strictness !== undefined) {
    if (!STRICTNESS.includes(input.strictness as Strictness)) throw new Error(`${source}.strictness must be strict, standard, or relaxed`)
    out.strictness = input.strictness as Strictness
  }
  for (const key of ["trivialPatterns", "highRiskPatterns"] as const) {
    const list = input[key]
    if (list === undefined) continue
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`${source}.${key} must be an array of glob strings`)
    }
    out[key] = [...list]
  }
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || (input.timeoutMs as number) < 1_000 || (input.timeoutMs as number) > 3_600_000) {
      throw new Error(`${source}.timeoutMs must be an integer between 1000 and 3600000`)
    }
    out.timeoutMs = input.timeoutMs as number
  }
  return out
}

export function configPath(root: string): string {
  return join(resolve(root), ".parallax", "config.json")
}

export function loadConfig(root: string): ParallaxConfig {
  const path = configPath(root)
  if (!existsSync(path)) return validateConfig({})
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateConfig(parsed, path)
}

export function matches(patterns: string[], root: string, file: string): boolean {
  if (patterns.length === 0) return false
  const abs = resolve(root, file)
  const rel = relative(resolve(root), abs).split("\\").join("/")
  const candidates = [rel, basename(abs)]
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern)
    return candidates.some((candidate) => re.test(candidate))
  })
}

export function gateFor(config: ParallaxConfig, root: string, files: string[]): "block" | "track" {
  if (config.strictness === "relaxed") return "track"
  const risky = (file: string) => matches(config.highRiskPatterns, root, file)
  const trivial = (file: string) => matches(config.trivialPatterns, root, file) && !risky(file)
  if (config.strictness === "strict") return files.some((file) => !trivial(file)) ? "block" : "track"
  return files.some(risky) ? "block" : "track"
}
