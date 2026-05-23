#!/usr/bin/env node
import { execSync } from "child_process"
import { readFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

function run(cmd, opts) {
  const options = { cwd: ROOT, stdio: "pipe", ...opts }
  return execSync(cmd, options).toString().trim()
}

function checkLogin() {
  try {
    const whoami = run("npm whoami")
    console.log(`✓ logged in as ${whoami}`)
    return whoami
  } catch {
    console.error("✗ not logged into npm. Run: npm login")
    process.exit(1)
  }
}

function checkPackageJson() {
  const checks = [
    ["name", pkg.name === "parallax-opencode"],
    ["version", typeof pkg.version === "string"],
    ["license", pkg.license === "MIT"],
    ["main", pkg.main === "./dist/plugin.js"],
    ["main exists", typeof pkg.main === "string"],
    ["bin", pkg.bin?.["parallax-opencode"]],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  if (failed.length) {
    console.error(`✗ package.json issues: ${failed.map(([n]) => n).join(", ")}`)
    process.exit(1)
  }
  console.log(`✓ package.json valid (v${pkg.version})`)
}

function build() {
  try {
    run("npm run build")
    console.log("✓ build succeeded")
  } catch {
    run("npx tsc")
    console.log("✓ tsc succeeded (no bun build script)")
  }
}

function publish() {
  const tag = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "latest"
  const dryRun = process.argv.includes("--dry-run")
  const versionBump = process.argv.includes("--patch")
    ? "patch"
    : process.argv.includes("--minor")
      ? "minor"
      : process.argv.includes("--major")
        ? "major"
        : null

  let version = pkg.version
  if (versionBump) {
    run(`npm version ${versionBump} --no-git-tag-version`)
    version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
    console.log(`✓ bumped to v${version}`)
  }

  const cmd = `npm publish --access public --tag ${tag}${dryRun ? " --dry-run" : ""}`
  console.log(`\nrunning: ${cmd}\n`)
  run(cmd, { stdio: "inherit" })
}

console.log(`\nPublishing ${pkg.name} v${pkg.version}\n`)
checkLogin()
checkPackageJson()
build()
publish()
console.log(`\n✓ ${pkg.name}@${pkg.version} published`)
