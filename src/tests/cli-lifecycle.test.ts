import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { main } from "../cli.js"

const originalArgv = process.argv
const originalRoot = process.env.OPENCODE_CONFIG_DIR
const roots: string[] = []
afterEach(() => {
  process.argv = originalArgv
  if (originalRoot === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalRoot
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

async function cli(root: string, ...args: string[]) {
  process.env.OPENCODE_CONFIG_DIR = root
  process.argv = [process.execPath, "cli.ts", ...args]
  return main()
}

describe("CLI lifecycle routing", () => {
  it("covers custom-root install, repeated install, status, and uninstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "parallax-cli-")); roots.push(home)
    const root = join(home, "custom-opencode")
    expect(await cli(root, "install", "--json")).toBe(0)
    expect(await cli(root, "install", "--json")).toBe(0)
    expect(await cli(root, "status", "--json")).toBe(0)
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"))
    expect(config.plugin).toContain("parallax-opencode")
    expect(await cli(root, "uninstall", "--json")).toBe(0)
    expect(existsSync(join(root, ".parallax-install.json"))).toBe(false)
  })

  it("does not mutate malformed config or unknown/dry-run targets", async () => {
    const home = mkdtempSync(join(tmpdir(), "parallax-cli-invalid-")); roots.push(home)
    const root = join(home, "opencode")
    mkdirSync(root)
    const config = join(root, "opencode.json")
    writeFileSync(config, "{not-json")
    expect(await cli(root, "install")).toBe(1)
    expect(readFileSync(config, "utf8")).toBe("{not-json")

    const untouched = join(home, "untouched")
    expect(await cli(untouched, "dry-run")).toBe(0)
    expect(await cli(untouched, "install", "--unknown")).toBe(2)
    expect(existsSync(untouched)).toBe(false)
  })
})
