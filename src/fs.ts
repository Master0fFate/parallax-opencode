import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8")
  renameSync(tmp, path)
}

export function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8")
}

export function readLines<T>(path: string, keep: (value: unknown) => value is T): T[] {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (keep(value)) out.push(value)
    } catch {}
  }
  return out
}

export function parallaxDir(root: string): string {
  const dir = join(resolve(root), ".parallax")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".gitignore"), "*\n", "utf8")
  }
  return dir
}

export function safeId(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== "." && id !== ".."
    ? id
    : `h-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`
}

export function globToRegExp(pattern: string): RegExp {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*" && pattern[i + 1] === "*") {
      i++
      if (pattern[i + 1] === "/") {
        i++
        source += "(?:.*/)?"
      } else source += ".*"
    } else if (c === "*") source += "[^/]*"
    else if (c === "?") source += "[^/]"
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}
