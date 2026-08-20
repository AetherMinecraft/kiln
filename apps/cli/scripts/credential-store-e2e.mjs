import { execFile } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const supported = process.platform === "darwin" || process.platform === "win32"

if (!supported) {
  process.stdout.write(
    `Credential-store E2E skipped on unsupported platform ${process.platform}.\n`
  )
  process.exit(0)
}

const root = join(import.meta.dirname, "..")
const executable = await cliExecutable(root)
const directory = await mkdtemp(join(tmpdir(), "kiln-cli-credential-e2e-"))
const configPath = join(directory, "config.json")
const token = `kiln_cli_${randomBytes(32).toString("base64url")}`
const profile = `e2e-${randomUUID()}`
let authorizationCount = 0
let revoked = false
let environment = null

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        error: {
          code: "authentication_required",
          message: "Authentication required.",
          retryable: false,
        },
      })
    )
    return
  }
  authorizationCount += 1
  if (request.method === "GET" && request.url === "/api/cli/v1/whoami") {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(
      JSON.stringify({
        credential: {
          id: "12345678-1234-4123-8123-123456789abc",
          mode: "full_access",
        },
        user: {
          email: "credential-e2e@example.test",
          id: "credential-e2e-user",
          name: "Credential E2E",
        },
      })
    )
    return
  }
  if (request.method === "DELETE" && request.url === "/api/cli/v1/credential") {
    revoked = true
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ revoked: true }))
    return
  }
  response.writeHead(404)
  response.end()
})

try {
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}`
  await writeFile(
    configPath,
    `${JSON.stringify({
      activeProfile: profile,
      profiles: { [profile]: { token, url } },
      version: 1,
    })}\n`,
    { mode: 0o600 }
  )

  environment = { ...process.env, KILN_CONFIG: configPath }
  delete environment.KILN_TOKEN
  delete environment.KILN_URL
  await execute(executable, ["whoami"], { env: environment })

  const migratedText = await readFile(configPath, "utf8")
  const migrated = JSON.parse(migratedText)
  if (migratedText.includes(token)) {
    throw new Error("Migrated config still contains the plaintext token")
  }
  if (migrated.version !== 2) {
    throw new Error("Credential config did not migrate to version 2")
  }
  if (migrated.profiles[profile]?.credential?.kind !== "external") {
    throw new Error("Credential was not stored in the system manager")
  }

  await execute(executable, ["whoami"], { env: environment })
  const logout = await execute(executable, ["logout"], { env: environment })
  if (logout.stdout.includes("could not be deleted")) {
    throw new Error("CLI reported that the system credential was not deleted")
  }
  const loggedOut = JSON.parse(await readFile(configPath, "utf8"))
  if (loggedOut.profiles[profile]) {
    throw new Error("Logout did not remove the saved profile")
  }
  if (authorizationCount !== 3 || !revoked) {
    throw new Error(
      "Mock Hearth did not observe the complete authenticated flow"
    )
  }

  process.stdout.write(
    `Credential-store E2E passed with ${migrated.profiles[profile].credential.manager}.\n`
  )
} finally {
  if (environment) {
    await execute(executable, ["logout"], { env: environment }).catch(
      () => undefined
    )
  }
  await new Promise((resolvePromise) => server.close(resolvePromise))
  await rm(directory, { force: true, recursive: true })
}

async function cliExecutable(root) {
  const candidates =
    process.platform === "win32"
      ? [join(root, "dist", "kiln.exe"), join(root, "dist", "kiln")]
      : [join(root, "dist", "kiln")]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next platform-specific executable name.
    }
  }
  throw new Error("Build the Kiln CLI before running the credential-store E2E")
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise)
      const address = server.address()
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Mock Hearth did not bind a TCP port"))
        return
      }
      resolvePromise(address.port)
    })
  })
}
