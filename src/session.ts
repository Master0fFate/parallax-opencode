import { join, resolve } from "node:path"
import type { Session } from "./types.js"
import { parallaxDir, readJson, safeId, writeJson } from "./fs.js"

export function sessionPath(root: string, id: string): string {
  return join(resolve(root), ".parallax", "sessions", `${safeId(id)}.json`)
}

export function loadSession(root: string, id: string): Session {
  const stored = readJson<Session>(sessionPath(root, id))
  return stored && stored.v === 3 && stored.id === id
    ? stored
    : { v: 3, id, agent: null, preflight: null, pending: [], receipts: [], lastFail: null, closed: null }
}

export function saveSession(root: string, session: Session): void {
  parallaxDir(root)
  writeJson(sessionPath(root, session.id), session)
}

export function updateSession(root: string, id: string, change: (session: Session) => void): Session {
  const session = loadSession(root, id)
  change(session)
  saveSession(root, session)
  return session
}
