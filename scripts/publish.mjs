#!/usr/bin/env node
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)

function run(command, options = {}) {
  const output = execSync(command, { cwd: ROOT, stdio: "pipe", ...options })
  return output ? output.toString().trim() : ""
}

function manifest() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function validateManifest() {
  const pkg = manifest()
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
  const rootLock = lock.packages?.[""]
  const pluginRange = pkg.dependencies?.["@opencode-ai/plugin"]
  const e2eVersion = pkg.devDependencies?.["opencode-ai"]
  const checks = [
    ["name", pkg.name === "parallax-opencode"],
    ["semver", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)],
    ["lockfile version", lock.version === pkg.version && rootLock?.version === pkg.version],
    ["license", pkg.license === "MIT"],
    ["author", typeof pkg.author === "string" && pkg.author.trim().length > 0],
    ["public publish config", pkg.publishConfig?.access === "public"],
    ["coverage release gate", typeof pkg.scripts?.["release:check"] === "string" && pkg.scripts["release:check"].includes("--coverage")],
    ["repository", pkg.repository?.url === "git+https://github.com/Master0fFate/parallax-opencode.git"],
    ["bugs", pkg.bugs?.url === "https://github.com/Master0fFate/parallax-opencode/issues"],
    ["homepage", pkg.homepage === "https://github.com/Master0fFate/parallax-opencode#readme"],
    ["plugin entry", pkg.main === "./dist/plugin.js"],
    ["plugin ESM export", pkg.exports?.["."]?.import === "./dist/plugin.js"],
    ["verification ESM export", pkg.exports?.["./verification"]?.import === "./dist/verification.js"],
    ["Node engine", pkg.engines?.node === ">=20"],
    ["OpenCode engine", pkg.engines?.opencode === ">=1.18.0 <1.19.0"],
    ["OpenCode plugin API", pluginRange === "~1.18.4"],
    ["locked plugin API range", rootLock?.dependencies?.["@opencode-ai/plugin"] === pluginRange],
    ["locked plugin API version", lock.packages?.["node_modules/@opencode-ai/plugin"]?.version === "1.18.4"],
    ["OpenCode E2E version", e2eVersion === "1.18.4"],
    ["locked OpenCode E2E version", rootLock?.devDependencies?.["opencode-ai"] === e2eVersion && lock.packages?.["node_modules/opencode-ai"]?.version === e2eVersion],
    ["bin", pkg.bin?.["parallax-opencode"] === "scripts/install.mjs"],
  ]
  const failed = checks.filter(([, valid]) => !valid).map(([name]) => name)
  if (failed.length) fail(`package.json/release metadata invalid: ${failed.join(", ")}`)
  console.log(`✓ release metadata synchronized (v${pkg.version})`)
  return pkg
}

function checkAuthorization(pkg) {
  let username
  try {
    username = run("npm whoami").trim()
  } catch {
    fail("npm authentication failed. Run: npm login")
  }

  let owners
  try {
    owners = run(`npm owner ls ${pkg.name}`)
  } catch {
    fail(`could not verify npm ownership for ${pkg.name}`)
  }
  const ownerNames = owners.split(/\r?\n/)
    .map((line) => line.match(/^(\S+)\s+</)?.[1]?.toLowerCase())
    .filter(Boolean)
  if (!ownerNames.includes(username.toLowerCase())) {
    fail(`npm user ${username} is not an owner of ${pkg.name}`)
  }
  console.log(`✓ npm authorization confirmed (${username} owns ${pkg.name})`)
}

async function verifyRegistry(pkg, tag) {
  let lastError
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`)
      const metadata = await response.json()
      const release = metadata.versions?.[pkg.version]
      if (release?.version !== pkg.version) throw new Error(`registry version ${pkg.version} is missing`)
      if (metadata["dist-tags"]?.[tag] !== pkg.version) {
        throw new Error(`registry ${tag} tag is ${metadata["dist-tags"]?.[tag] || "missing"}`)
      }
      if (typeof release.dist?.tarball !== "string" || typeof release.dist?.integrity !== "string") {
        throw new Error("registry distribution metadata is incomplete")
      }
      console.log(`✓ registry verified (${pkg.name}@${pkg.version}, ${tag}, ${release.dist.integrity})`)
      return
    } catch (error) {
      lastError = error
      if (attempt < 10) await new Promise((resolve) => setTimeout(resolve, 3_000))
    }
  }
  fail(`publication completed but registry verification failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

const bump = args.includes("--patch") ? "patch"
  : args.includes("--minor") ? "minor"
    : args.includes("--major") ? "major"
      : null
const dryRun = args.includes("--dry-run")
const metadataOnly = args.includes("--metadata-only")
const verifyRegistryOnly = args.includes("--verify-registry")
const tagAt = args.indexOf("--tag")
const tag = tagAt >= 0 ? args[tagAt + 1] : "latest"
if (!tag) fail("--tag requires a value")
if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag)) fail(`invalid npm dist-tag: ${tag}`)
if (metadataOnly && (bump || dryRun || tagAt >= 0 || verifyRegistryOnly)) fail("--metadata-only cannot be combined with release options")
if (verifyRegistryOnly && (bump || dryRun)) fail("--verify-registry cannot be combined with version bumps or dry-run")

if (bump) {
  run(`npm version ${bump} --no-git-tag-version`)
  console.log(`✓ bumped package and lockfile to v${manifest().version}`)
}

console.log(`\nRelease metadata preflight for ${manifest().name}@${manifest().version}\n`)
const pkg = validateManifest()

if (verifyRegistryOnly) {
  await verifyRegistry(pkg, tag)
} else if (!metadataOnly) {
  run("npm run release:check", { stdio: "inherit" })
  if (!dryRun) checkAuthorization(pkg)

  const publishCommand = `npm publish --access public --tag ${tag} --ignore-scripts${dryRun ? " --dry-run" : ""}`
  console.log(`\nrunning: ${publishCommand}\n`)
  run(publishCommand, { stdio: "inherit" })
  if (!dryRun) await verifyRegistry(pkg, tag)
  console.log(`\n✓ ${pkg.name}@${pkg.version} ${dryRun ? "is release-ready" : "published and registry-verified"}`)
}
