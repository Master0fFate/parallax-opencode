import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"
import type { ParallaxConfig } from "./types.js"

export interface EffectiveParallaxConfig {
  strictness: "strict" | "standard" | "relaxed"
  minScore: number
  adaptiveProtocol: boolean
  designDocRequired: boolean
  trivialPatterns: string[]
  highRiskPatterns: string[]
}

export const DEFAULT_PARALLAX_CONFIG = Object.freeze({
  strictness: "strict" as const,
  minScore: 70,
  adaptiveProtocol: false,
  designDocRequired: false,
  trivialPatterns: Object.freeze([] as string[]),
  highRiskPatterns: Object.freeze([] as string[]),
})

const PARALLAX_CONFIG_KEYS = new Set([
  "strictness",
  "minScore",
  "adaptiveProtocol",
  "designDocRequired",
  "trivialPatterns",
  "highRiskPatterns",
])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** Validate user input before it can affect protocol enforcement. */
export function validateParallaxConfig(value: unknown, source = "Parallax configuration"): ParallaxConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object`)
  }
  const config = value as Record<string, unknown>
  for (const key of Object.keys(config)) {
    if (!PARALLAX_CONFIG_KEYS.has(key)) throw new Error(`${source} has unknown field: ${key}`)
  }
  if (config.strictness !== undefined &&
      (typeof config.strictness !== "string" || !["strict", "standard", "relaxed"].includes(config.strictness))) {
    throw new Error(`${source}.strictness must be strict, standard, or relaxed`)
  }
  if (config.minScore !== undefined &&
      (typeof config.minScore !== "number" || !Number.isFinite(config.minScore) || config.minScore < 0 || config.minScore > 100)) {
    throw new Error(`${source}.minScore must be a number from 0 to 100`)
  }
  for (const key of ["adaptiveProtocol", "designDocRequired"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new Error(`${source}.${key} must be a boolean`)
    }
  }
  for (const key of ["trivialPatterns", "highRiskPatterns"] as const) {
    if (config[key] !== undefined && !isStringArray(config[key])) {
      throw new Error(`${source}.${key} must be an array of strings`)
    }
  }
  return config as ParallaxConfig
}

export function effectiveParallaxConfig(value: unknown = {}): EffectiveParallaxConfig {
  const config = validateParallaxConfig(value)
  return {
    ...DEFAULT_PARALLAX_CONFIG,
    ...config,
    trivialPatterns: config.trivialPatterns ? [...config.trivialPatterns] : [],
    highRiskPatterns: config.highRiskPatterns ? [...config.highRiskPatterns] : [],
  }
}

/** Read and validate project configuration. Invalid input is an explicit, safe failure. */
export function loadEffectiveParallaxConfig(root = process.cwd()): EffectiveParallaxConfig {
  const path = join(resolve(root), ".parallax", "config.json")
  if (!existsSync(path)) return effectiveParallaxConfig()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return effectiveParallaxConfig(validateParallaxConfig(parsed, path))
}
