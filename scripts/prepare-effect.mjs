import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

// Node rather than shell: npm lifecycle scripts run through cmd.exe on Windows,
// which cannot execute a .sh file at all, so `pnpm install` failed at `prepare`
// before a contributor reached anything else.
const repositoryDirectory = resolve(".repos", "effect")
const repositoryUrl = "https://github.com/Effect-TS/effect-smol"

if (existsSync(resolve(repositoryDirectory, ".git"))) process.exit(0)

mkdirSync(resolve(".repos"), { recursive: true })
const result = spawnSync("git", ["clone", repositoryUrl, repositoryDirectory], {
  stdio: "inherit",
})
if (result.error) {
  console.error(`Could not run git: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
