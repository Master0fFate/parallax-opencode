#!/usr/bin/env node
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const run = (command, options = {}) => (execSync(command, { cwd: ROOT, stdio: "pipe", ...options }) || "").toString().trim()
const read = (name) => JSON.parse(readFileSync(join(ROOT, name), "utf8"))
const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function validate() {
  const pkg = read("package.json")
  const lock = read("package-lock.json")
  const root = lock.packages?.[""]
  const checks = [
    ["name", pkg.name === "parallax-opencode"],
    ["semver", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)],
    ["lockfile version", lock.version === pkg.version && root?.version === pkg.version],
    ["license", pkg.license === "MIT"],
    ["public access", pkg.publishConfig?.access === "public"],
    ["plugin entry", pkg.main === "./dist/plugin.js" && pkg.exports?.["."]?.import === "./dist/plugin.js"],
    ["verify entry", pkg.exports?.["./verify"]?.import === "./dist/verify.js"],
    ["bin", pkg.bin?.["parallax-opencode"] === "scripts/install.mjs"],
    ["engines", pkg.engines?.node === ">=20" && /^>=1\.18\.\d+$/.test(pkg.engines?.opencode ?? "")],
    ["locked plugin API", root?.dependencies?.["@opencode-ai/plugin"] === pkg.dependencies["@opencode-ai/plugin"]],
    ["locked OpenCode E2E", root?.devDependencies?.["opencode-ai"] === pkg.devDependencies["opencode-ai"] && lock.packages?.["node_modules/opencode-ai"]?.version === pkg.devDependencies["opencode-ai"]],
    ["E2E matches engine floor", pkg.engines?.opencode === `>=${pkg.devDependencies["opencode-ai"]}`],
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length) fail(`release metadata invalid: ${failed.join(", ")}`)
  console.log(`✓ release metadata synchronized (v${pkg.version})`)
  return pkg
}

function authorize(pkg) {
  let user
  try {
    user = run("npm whoami")
  } catch {
    fail("npm authentication failed; run npm login")
  }
  const owners = run(`npm owner ls ${pkg.name}`).split(/\r?\n/).map((line) => line.split(/\s+/)[0]?.toLowerCase()).filter(Boolean)
  if (!owners.includes(user.toLowerCase())) fail(`${user} does not own ${pkg.name}`)
  console.log(`✓ ${user} owns ${pkg.name}`)
}

async function verifyRegistry(pkg, tag) {
  let last
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${pkg.name}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`registry HTTP ${response.status}`)
      const metadata = await response.json()
      const release = metadata.versions?.[pkg.version]
      if (!release?.dist?.integrity) throw new Error(`version ${pkg.version} missing`)
      if (metadata["dist-tags"]?.[tag] !== pkg.version) throw new Error(`${tag} tag is ${metadata["dist-tags"]?.[tag] ?? "missing"}`)
      console.log(`✓ registry verified ${pkg.name}@${pkg.version} (${tag}, ${release.dist.integrity})`)
      return
    } catch (error) {
      last = error
      await new Promise((wait) => setTimeout(wait, 3_000))
    }
  }
  fail(`registry verification failed: ${last?.message}`)
}

const bump = ["patch", "minor", "major"].find((kind) => args.includes(`--${kind}`))
const dryRun = args.includes("--dry-run")
const metadataOnly = args.includes("--metadata-only")
const registryOnly = args.includes("--verify-registry")
const tag = args[args.indexOf("--tag") + 1] && args.includes("--tag") ? args[args.indexOf("--tag") + 1] : "latest"
if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag)) fail(`invalid dist-tag: ${tag}`)

if (bump) {
  run(`npm version ${bump} --no-git-tag-version`)
  console.log(`✓ bumped to v${read("package.json").version}`)
}
const pkg = validate()
if (registryOnly) await verifyRegistry(pkg, tag)
else if (!metadataOnly) {
  run("npm run check", { stdio: "inherit" })
  if (!dryRun) authorize(pkg)
  run(`npm publish --access public --tag ${tag} --ignore-scripts${dryRun ? " --dry-run" : ""}`, { stdio: "inherit" })
  if (!dryRun) await verifyRegistry(pkg, tag)
  console.log(`✓ ${pkg.name}@${pkg.version} ${dryRun ? "is release-ready" : "published"}`)
}
