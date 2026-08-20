# Kiln CLI

Command-line access to Kiln and self-hosted Hearth instances. The CLI uses
readable tables, plain log and file output, and concise status messages.

## Install

Run without a global install:

```sh
npx kiln-cli --version
npx kiln-cli login
```

Or install it globally. The npm package is named `kiln-cli`; both installation
methods expose the `kiln` command.

```sh
npm install --global kiln-cli
kiln login
```

Update an existing global CLI installation with:

```sh
kiln update
```

The updater reuses pnpm or Bun when it can identify that package manager as the
owner of the installed CLI. Otherwise, and whenever that update fails, it uses
`npm install --global kiln-cli@latest`. This updates only the local Kiln CLI,
not Hearth or any Relay.

## Install the agent skill

Install the Kiln skill globally so supported coding agents can discover and use
the CLI across projects:

```sh
npx skills@latest add kiln-site/kiln --skill kiln-cli --global
```

The installer detects supported agents and places the standard Agent Skill in
their user-level skill directories. Omit `--global` to install it only in the
current project.

## Build locally

```sh
pnpm --filter kiln-cli build
./apps/cli/dist/kiln --version
```

Bun compiles the app into `dist/kiln`; Bun does not need to be installed on
the machine running that executable. Local macOS builds are ad-hoc signed with
the JavaScript runtime entitlements required by Bun.

## Authenticate

```sh
kiln login
kiln login https://hearth.example.com --name workstation --no-open
```

The first form targets `https://kiln.site`. The command opens a browser and
waits while you approve the sign-in. Self-hosted Hearth installations are
selected with the positional URL or `--url`. Named profiles are available
through `--profile`.

`KILN_URL` and `KILN_TOKEN` can bypass the saved profile in CI or scripts.
Interactive logins store credentials in macOS Keychain or Windows Credential
Manager. The profile URL and credential reference remain in the owner-only Kiln
config file. Existing plaintext profiles migrate automatically the next time the
CLI needs their saved credential. Explicit token overrides bypass migration,
and login or logout can replace or remove a legacy profile directly. If a
native manager temporarily cannot store a legacy credential, the CLI uses the
existing token for that command, leaves it pending, and retries on later use.

When a supported system credential manager is unavailable, such as on a
headless Linux host, the CLI falls back to storing the credential in the
owner-only config file and prints a warning during login. If a manager exists
but cannot store the credential, the warning identifies that failure instead.
`kiln logout` revokes the active credential, removes its profile, and deletes
its system credential.

For non-interactive automation, set both variables without creating a local
profile:

```sh
export KILN_URL=https://hearth.example.com
export KILN_TOKEN="$DEPLOY_KILN_TOKEN"
kiln server info <relay-id>:<instance-id>
```

Hearth still applies the credential mode and the account's Relay/server access
grants. Supplying a token does not grant administrative access.

## Discover and operate

```sh
kiln relays list
kiln relay info <relay-id>
kiln activity list --limit 200
kiln servers list
kiln servers create <relay-id> paper --name survival --memory 4GiB --disk 25GiB
kiln server info <relay-id>:<instance-id>
kiln server startup <relay-id>:<instance-id> --memory 6GiB --java-version 25
kiln server brick <relay-id>:<instance-id> fabric --game-version 1.21.11
kiln server power <relay-id>:<instance-id> restart
kiln server logs <relay-id>:<instance-id> --follow
kiln server console <relay-id>:<instance-id> "say deploy complete"
kiln files list <relay-id>:<instance-id> .
kiln files read <relay-id>:<instance-id> server.properties
kiln files write <relay-id>:<instance-id> server.properties ./server.properties
kiln files download <relay-id>:<instance-id> logs/latest.log ./latest.log
kiln files upload <relay-id>:<instance-id> ./plugins/example.jar plugins/example.jar
kiln files upload <relay-id>:<instance-id> https://example.com/example.jar plugins/example.jar
kiln files sync <relay-id>:<instance-id> ./server --plan --json
kiln files sync <relay-id>:<instance-id> ./server --exclude 'logs/**' --exclude '*.tmp'
kiln files sync <relay-id>:<instance-id> ./server --atomic --json
kiln files sync <relay-id>:<instance-id> ./server --atomic --delete-managed --manifest ./managed.json --max-delete 5
kiln backups list --limit 200
kiln backups create server <relay-id>:<instance-id> --name "Before update"
kiln backups create server <relay-id>:<instance-id> --storage <destination-uuid>
kiln backups create server <relay-id>:<instance-id> --mode full
kiln backup download <backup-id>
kiln server delete <relay-id>:<instance-id> --confirm <relay-id>:<instance-id>
```

Disk quotas must be at least `0.1GiB`, matching the Relay allocation minimum.
Server backups default to incremental restic snapshots and accept exactly one
Relay-local or S3-compatible destination. Full archives can use multiple
destinations.

Uploads and downloads use the Relay SFTP endpoint and verify its advertised
SSH host-key fingerprint. HTTPS upload sources are downloaded directly by the
Relay through the authenticated control channel and reject private or reserved
network destinations. Other file operations use the versioned CLI API.
Read-only credentials can discover authorized resources, follow logs, and read
files, but cannot create or delete servers, change startup settings, power
servers, send console commands, modify files, or upload.

## Recursive file sync

`kiln files sync <server> <local-directory>` recursively inventories the local
directory and the authorized server root through one host-key-pinned SFTP
session. It creates missing remote directories, compares file sizes and
SHA-256 hashes, uploads only changed files, and reads uploaded files back to
verify their size and hash.

Use `--plan` to inspect the operation without changing remote files. Repeat
`--exclude <pattern>` for relative glob patterns such as `logs/**`, `cache`,
or `*.tmp`; excluded paths are skipped on both sides, and excluding a directory
by name keeps the remote walk out of it entirely. `--json` emits one versioned
JSON document containing the plan and result for CI consumers. Local symlinks, unsafe remote names, and a remote
symlink or directory where a file would be written cause planning to fail.

Use `--atomic` to upload into a deployment-specific staging directory, verify
each staged file, and have Relay transactionally rename the plan into place.
Relay retains rollback copies until all renames succeed, journals activation for
startup recovery, cleans safely marked staging after failures when reachable,
and records the CLI actor and affected paths in activity.

Managed deletion is opt-in. `--delete-managed` requires a version 1 JSON
manifest such as `{"version":1,"managed":["plugins/Example.jar"]}`. Only
missing regular files explicitly named by the manifest are eligible.
`--max-delete` defaults to zero and refuses a plan over its limit. Excludes,
undeclared files, directories, worlds, logs, backups, crash reports, and Kiln's
staging data remain preserved. Managed deletion requires the separate
`instance.files.delete-managed` permission.

Without `--atomic`, sync retains the Phase 1 direct-upload behavior and never
deletes files.

Run `kiln help` for the complete command reference.
