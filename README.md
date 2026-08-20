# Kiln

Kiln is a self-hosted platform for running game servers. Hearth is the web panel that manages them; Relay is the agent that runs on each host.

## Images

```text
ghcr.io/kiln-site/hearth:latest
ghcr.io/kiln-site/relay:latest
```

Nightly builds are published as `:latest-nightly`. Official Ember runtimes used by Bricks:

```text
ghcr.io/kiln-site/bricks-java:11
ghcr.io/kiln-site/bricks-java:17
ghcr.io/kiln-site/bricks-java:21
ghcr.io/kiln-site/bricks-java:25
ghcr.io/kiln-site/bricks-steamcmd:latest
```

## Configuration

Start from `.env.hearth.example`. These are the values worth setting for a first install:

```env
KILN_URL=https://hearth.example.com
DB_PASSWORD=
BETTER_AUTH_SECRETS=1:
KILN_PLATFORM_BACKUP_KEY=

KILN_RELAY_HOST=relay.example.com
KILN_RELAY_GAME_HOST=games.example.com
KILN_RELAY_GAME_PORT_RANGE=30000-39999
KILN_RELAY_BOOTSTRAP_TOKEN=
KILN_RELAY_PROXY=none
KILN_RELAY_ACME_EMAIL=

KILN_ENABLE_SIGNUPS=false
```

Generate secrets with `openssl rand -base64 48`. `BETTER_AUTH_SECRETS` is versioned (`1:<secret>`). Keep an offline copy of `KILN_PLATFORM_BACKUP_KEY`; it is intentionally separate from Hearth's live secrets so a platform bundle remains recoverable after Hearth is lost. For a colocated Compose stack, give Hearth and Relay the same bootstrap token so they can pair on first boot. Set `KILN_RELAY_PROXY` to `traefik` or `coolify` when an edge should terminate TLS; `none` leaves that to you.

Then:

```sh
docker compose up -d
```

## Development

Requires Node 20+, pnpm and Docker. On macOS, OrbStack additionally supplies
the `*.orb.local` names the stack uses.

```sh
vp install --frozen-lockfile
pnpm dev:setup
pnpm dev:docker
```

`dev:setup` only needs to run once per clone. Open the URL printed by
`dev:docker` to use the panel.

### Windows and Linux

Without OrbStack there is nothing answering `*.orb.local`, so the stack
publishes its ports and names itself under `kiln.localhost` instead. Add the
line `pnpm dev:docker:hosts` prints to your hosts file once per machine
(`C:\Windows\System32\drivers\etc\hosts` or `/etc/hosts`, as
administrator); the browser, the `kiln` CLI and SFTP all need to resolve it.
Set `KILN_DEV_DOMAIN` to use a different name.

The Relay keeps managed TLS, because Hearth's automatic pairing requires an
HTTPS origin. Its certificate is signed by a CA the Relay generates, which the
browser does not trust, and the browser talks to the Relay directly for console
streams and file transfers. Either accept the warning once for the Relay
origin, or issue certificates with mkcert and set `KILN_RELAY_TLS_MODE=external`
with `KILN_RELAY_TLS_CERT_FILE` and `KILN_RELAY_TLS_KEY_FILE`.

If another service already holds a port, set `KILN_HEARTH_PORT`,
`KILN_RELAY_PORT` or `KILN_RELAY_SFTP_PORT`; a second worktree stack needs its
own values.

On Windows, clone into the WSL2 filesystem and enable Docker Desktop's WSL
integration. The stack works from an NTFS path, but every source read crosses
the VM boundary, which shows up as slow installs and unreliable file watching.

## License

AGPL-3.0 with an optional [Commercial License](./COMMERCIAL_LICENSE.md). See [LICENSE](./LICENSE). Contributors must sign the [CLA](./CLA.md) — details in [CONTRIBUTING.md](./CONTRIBUTING.md).

Copyright © 2026 Marco Technology Consulting Inc. (“QuartzDev”).
