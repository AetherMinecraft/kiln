import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"

import {
  developmentRelayName,
  ensureDockerVolume,
} from "./dev-docker-helpers.mjs"

const command = process.argv[2] ?? "start"
const initialDirectory = process.cwd()
const worktreeRoot = captureAt(initialDirectory, "git", [
  "rev-parse",
  "--show-toplevel",
])
const commonGitDirectory = resolve(
  worktreeRoot,
  git("rev-parse", "--git-common-dir")
)
const primaryRoot = dirname(commonGitDirectory)
const primaryWorktree = resolve(worktreeRoot) === resolve(primaryRoot)
const stack = primaryWorktree ? "hearth" : worktreeStack(worktreeRoot)
const namespace = primaryWorktree ? "" : stack
const environmentFile = resolve(primaryRoot, ".env")
// Read before Compose sees it so a machine-local override - a port already
// taken, a different domain - produces the same answer in the printed URL and
// in the containers.
const environmentValues = existsSync(environmentFile)
  ? parseEnvironment(readFileSync(environmentFile, "utf8"))
  : new Map()

// OrbStack answers `*.orb.local` and fronts container ports at 443, which is
// why the dev overlay publishes nothing. It is macOS-only, so everywhere else
// the stack publishes its ports and Compose network aliases make the same
// hostname resolve to the container from inside and to 127.0.0.1 from the
// host. Identical port numbers on both sides keep one URL correct for Hearth,
// the browser and the CLI alike.
const devDomain = devSetting(
  "KILN_DEV_DOMAIN",
  process.platform === "darwin" ? "orb.local" : "kiln.localhost"
)
const orbstack = devDomain === "orb.local"
const hearthHost = `hearth.${stack}.${devDomain}`
const relayHost = `relay.${stack}.${devDomain}`
// Published host ports, not container ports. A fixed pair would collide with
// anything else on the box and, worse, with a second Kiln worktree stack -
// which is a normal thing to be running here.
const hearthPort = devSetting("KILN_HEARTH_PORT", "3000")
const relayPort = devSetting("KILN_RELAY_PORT", "4100")
const relayPublicPort = orbstack ? "443" : relayPort
// Managed everywhere: Hearth's automatic pairing requires an HTTPS origin, so
// a Relay on plain HTTP never pairs. The browser reaches the Relay directly for
// console streams and file transfers and will not trust a self-signed CA, so
// issue certificates with mkcert and set KILN_RELAY_TLS_MODE=external when
// those need to work without a per-origin exception.
const relayTlsMode = devSetting("KILN_RELAY_TLS_MODE", "managed")
const relayScheme = relayTlsMode === "development" ? "http" : "https"
const hearthUrl = orbstack
  ? `https://${hearthHost}`
  : `http://${hearthHost}:${hearthPort}`
const relayUrl = orbstack
  ? `https://${relayHost}`
  : `${relayScheme}://${relayHost}:${relayPublicPort}`
const composeFiles = [
  resolve(worktreeRoot, "compose.yaml"),
  resolve(worktreeRoot, "compose.dev.yaml"),
  ...(orbstack ? [] : [resolve(worktreeRoot, "compose.dev.published.yaml")]),
]

if (command === "setup") {
  setupEnvironment()
  ensureSharedStore()
  console.log(`Development environment is ready at ${environmentFile}`)
  process.exit(0)
}

requireEnvironment()
if (command === "start" || command === "up" || command === "refresh") {
  ensureSharedStore()
}

const composeEnvironment = {
  ...process.env,
  KILN_DEV_DOMAIN: devDomain,
  KILN_HEARTH_PORT: hearthPort,
  KILN_DEV_ENV_FILE: environmentFile,
  KILN_INSTALLATION_ID: stack,
  KILN_RELAY_GAME_HOST: process.env.KILN_RELAY_GAME_HOST?.trim() || "localhost",
  KILN_RELAY_HOST: relayHost,
  KILN_RELAY_NAME: developmentRelayName(worktreeRoot),
  KILN_RELAY_PROXY: "none",
  KILN_RELAY_PUBLIC_PORT: relayPublicPort,
  KILN_RELAY_RESOURCE_NAMESPACE: namespace,
  KILN_RELAY_TLS_MODE: relayTlsMode,
  KILN_URL: hearthUrl,
}

switch (command) {
  case "start":
    printStack()
    compose(["up", "hearth"], composeEnvironment)
    break
  case "up":
    printStack()
    compose(["up", "--detach", "--wait", "hearth"], composeEnvironment)
    console.log("\nDevelopment stack is ready.")
    break
  case "down":
    compose(["down"], composeEnvironment)
    break
  case "destroy":
    destroyNamespacedContainers()
    compose(["down"], composeEnvironment)
    destroyNamespacedNetworks()
    compose(["down", "--volumes", "--remove-orphans"], composeEnvironment)
    break
  case "logs":
    compose(["logs", "--follow", "hearth", "relay"], composeEnvironment)
    break
  case "refresh":
    refresh()
    break
  case "url":
    console.log(hearthUrl)
    break
  case "hosts":
    // Neither Windows nor Linux resolves these names on its own, and the CLI
    // and SFTP client need them as much as the browser does.
    console.log(hostsEntry())
    break
  case "list":
    run("docker", ["compose", "ls"], process.env)
    break
  default:
    fail(`Unknown development Docker command: ${command}`)
}

function compose(arguments_, environment) {
  run(
    "docker",
    [
      "compose",
      "--env-file",
      environmentFile,
      "--project-name",
      stack,
      ...composeFiles.flatMap((file) => ["--file", file]),
      ...arguments_,
    ],
    environment
  )
}

function requireNamespaceForDestroy() {
  if (!namespace) {
    fail(
      "Refusing to destroy unscoped Relay resources from the primary worktree. Use dev:docker:down, or remove primary development data deliberately."
    )
  }
}

function destroyNamespacedContainers() {
  requireNamespaceForDestroy()
  const containers = capture("docker", [
    "container",
    "ls",
    "--all",
    "--filter",
    `label=kiln.relay.owner=${namespace}`,
    "--format",
    "{{.ID}}",
  ])
    .split("\n")
    .filter(Boolean)
  if (containers.length > 0) {
    run("docker", ["container", "rm", "--force", ...containers], process.env)
  }
}

function destroyNamespacedNetworks() {
  requireNamespaceForDestroy()
  const networks = capture("docker", [
    "network",
    "ls",
    "--filter",
    `label=kiln.relay.owner=${namespace}`,
    "--format",
    "{{.ID}}",
  ])
    .split("\n")
    .filter(Boolean)
  if (networks.length > 0) {
    run("docker", ["network", "rm", ...networks], process.env)
  }
}

function ensureSharedStore() {
  try {
    ensureDockerVolume("kiln-dev-pnpm-store", (arguments_) =>
      spawnSync("docker", arguments_, {
        cwd: worktreeRoot,
        encoding: "utf8",
        env: process.env,
      })
    )
  } catch (cause) {
    fail(
      cause instanceof Error
        ? cause.message
        : "Could not create the shared pnpm Docker volume."
    )
  }
}

function refresh() {
  const services = ["cache", "mysql", "relay", "hearth"]
  const running = services.every((service) =>
    captureCompose(["ps", "--quiet", service], composeEnvironment)
  )
  if (!running) {
    printStack()
    compose(["up", "--detach", "--wait", "hearth"], composeEnvironment)
    return
  }
  compose(["restart", "relay"], composeEnvironment)
  waitForService("relay")
  compose(["restart", "hearth"], composeEnvironment)
  waitForService("hearth")
  console.log("The development stack is refreshed and healthy.")
}

function waitForService(service) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const container = captureCompose(
      ["ps", "--quiet", service],
      composeEnvironment
    )
    if (container) {
      const status = capture("docker", [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
        container,
      ])
      if (status === "healthy" || status === "running") return
      if (status === "exited" || status === "dead") {
        compose(["logs", "--tail", "80", service], composeEnvironment)
        fail(`${service} stopped before becoming ready.`)
      }
    }
    sleepSeconds(2)
  }
  fail(`Timed out waiting for ${service} to become ready.`)
}

function captureCompose(arguments_, environment) {
  return capture(
    "docker",
    [
      "compose",
      "--env-file",
      environmentFile,
      "--project-name",
      stack,
      ...composeFiles.flatMap((file) => ["--file", file]),
      ...arguments_,
    ],
    environment
  )
}

function printStack() {
  console.log(`Stack:  ${stack}`)
  console.log(`Hearth: ${hearthUrl}`)
  console.log(`Relay:  ${relayUrl}`)
  if (!orbstack) console.log(`Hosts:  ${hostsEntry()}`)
  console.log("")
}

function hostsEntry() {
  return `127.0.0.1 ${hearthHost} ${relayHost}`
}

function setupEnvironment() {
  if (!existsSync(environmentFile)) {
    const example = resolve(primaryRoot, ".env.hearth.example")
    if (!existsSync(example)) fail(`Missing environment template: ${example}`)
    writeFileSync(environmentFile, readFileSync(example, "utf8"), {
      mode: 0o600,
    })
  }
  const values = parseEnvironment(readFileSync(environmentFile, "utf8"))
  const replacements = new Map()
  if (
    !usableSecret(values.get("DB_PASSWORD")) ||
    values.get("DB_PASSWORD") === "replace-with-a-strong-database-password"
  ) {
    replacements.set("DB_PASSWORD", secret(32))
  }
  const authSecrets = values.get("BETTER_AUTH_SECRETS")
  if (!authSecrets || authSecrets === "1:") {
    replacements.set("BETTER_AUTH_SECRETS", `1:${secret(48)}`)
  }
  if (!usableSecret(values.get("KILN_RELAY_BOOTSTRAP_TOKEN"))) {
    replacements.set("KILN_RELAY_BOOTSTRAP_TOKEN", secret(48))
  }
  if (!usableSecret(values.get("KILN_PLATFORM_BACKUP_KEY"))) {
    replacements.set("KILN_PLATFORM_BACKUP_KEY", secret(48))
  }
  chmodSync(environmentFile, 0o600)
  if (replacements.size === 0) return

  const current = readFileSync(environmentFile, "utf8")
  const updated = [...replacements].reduce(
    (contents, [name, value]) => setEnvironmentValue(contents, name, value),
    current
  )
  writeFileSync(environmentFile, updated, { mode: 0o600 })
}

function requireEnvironment() {
  if (!existsSync(environmentFile)) {
    fail(
      `Missing ${environmentFile}. Run pnpm dev:setup once from any worktree.`
    )
  }
  const values = parseEnvironment(readFileSync(environmentFile, "utf8"))
  const missing = []
  if (!usableSecret(values.get("DB_PASSWORD"))) missing.push("DB_PASSWORD")
  if (!usableSecret(values.get("BETTER_AUTH_SECRETS"))) {
    missing.push("BETTER_AUTH_SECRETS")
  }
  if (!usableSecret(values.get("KILN_RELAY_BOOTSTRAP_TOKEN"))) {
    missing.push("KILN_RELAY_BOOTSTRAP_TOKEN")
  }
  if (!usableSecret(values.get("KILN_PLATFORM_BACKUP_KEY"))) {
    missing.push("KILN_PLATFORM_BACKUP_KEY")
  }
  if (missing.length > 0) {
    fail(
      `Missing required development values (${missing.join(", ")}) in ${environmentFile}. Run pnpm dev:setup.`
    )
  }
}

function parseEnvironment(contents) {
  const values = new Map()
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

function setEnvironmentValue(contents, name, value) {
  const expression = new RegExp(`^${name}=.*$`, "mu")
  if (expression.test(contents)) {
    return contents.replace(expression, `${name}=${value}`)
  }
  return `${contents.replace(/\s*$/u, "")}\n${name}=${value}\n`
}

function usableSecret(value) {
  return Boolean(value && value.trim() && !value.includes("replace-with"))
}

function secret(bytes) {
  return randomBytes(bytes).toString("base64url")
}

function worktreeStack(path) {
  const slug =
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 30) || "worktree"
  const hash = createHash("sha256")
    .update(resolve(path))
    .digest("hex")
    .slice(0, 6)
  return `hearth-${slug}-${hash}`
}

function git(...arguments_) {
  return capture("git", arguments_)
}

function capture(executable, arguments_, environment = process.env) {
  return captureAt(worktreeRoot, executable, arguments_, environment)
}

function captureAt(
  workingDirectory,
  executable,
  arguments_,
  environment = process.env
) {
  const result = spawnSync(executable, arguments_, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: environment,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    fail(`${executable} ${arguments_.join(" ")} failed.`)
  }
  return result.stdout.trim()
}

function run(executable, arguments_, environment) {
  const result = spawnSync(executable, arguments_, {
    cwd: worktreeRoot,
    env: environment,
    stdio: "inherit",
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function devSetting(name, fallback) {
  return (
    process.env[name]?.trim() || environmentValues.get(name)?.trim() || fallback
  )
}

function sleepSeconds(seconds) {
  // Synchronous by design: this script is a straight line of Compose calls, and
  // Windows has no `sleep` binary to shell out to.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
