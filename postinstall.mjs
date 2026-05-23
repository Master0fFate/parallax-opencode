#!/usr/bin/env node
import { execSync } from "child_process"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const installScript = join(__dirname, "scripts", "install.mjs")

try {
  execSync(`node "${installScript}"`, { stdio: "inherit" })
} catch {
  // postinstall failures are non-fatal
  process.exit(0)
}
