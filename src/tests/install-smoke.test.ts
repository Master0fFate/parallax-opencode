/**
 * Installer smoke tests.
 *
 * Verifies the explicit `npx parallax-opencode` entrypoint behavior using the
 * source installer with an isolated HOME/USERPROFILE. This catches package
 * manifest drift without mutating the developer's real OpenCode config.
 */
import { describe, it, expect } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "node:child_process"

describe("explicit installer", () => {
  it("copies existing agents/skills and creates plugin registration", () => {
    const home = mkdtempSync(join(tmpdir(), "parallax-install-"))
    try {
      const result = spawnSync(process.execPath, ["scripts/install.mjs"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
      })

      expect(result.status).toBe(0)
      const configDir = join(home, ".config", "opencode")
      expect(existsSync(join(configDir, "agents", "parallax.md"))).toBe(true)
      expect(existsSync(join(configDir, "agents", "horizon.md"))).toBe(true)
      expect(existsSync(join(configDir, "skills", "parallax-plan", "SKILL.md"))).toBe(true)
      expect(existsSync(join(configDir, "skills", "parallax-debug", "SKILL.md"))).toBe(true)
      expect(existsSync(join(configDir, "skills", "parallax", "SKILL.md"))).toBe(false)
      expect(existsSync(join(configDir, "skills", "horizon", "SKILL.md"))).toBe(false)

      const config = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8")) as { plugin?: string[] }
      expect(config.plugin).toContain("parallax-opencode")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
