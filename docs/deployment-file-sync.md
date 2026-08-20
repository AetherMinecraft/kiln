# Deployment file sync architecture

This note records the architecture and boundaries used for the first two phases of
deployment-oriented file synchronization.

## Existing boundaries

- The CLI resolves `KILN_URL` and `KILN_TOKEN` before saved profiles, so CI can
  authenticate without interactive state.
- Hearth authenticates CLI credentials, enforces their read-only or full-access
  mode, and checks the user's Relay or instance grant for each CLI API request.
- The Relay independently resolves SFTP grants per instance and enforces file
  list, read, create, write, delete, rename, and chmod actions.
- CLI file metadata uses Hearth-to-Relay RPC. Binary local transfers use the
  Relay SFTP endpoint with its advertised SSH host-key fingerprint.
- Relay browser and URL uploads already use descriptor-anchored paths, streamed
  SHA-256 calculation, temporary files, and single-file replacement. SFTP
  exposes the same instance-root authorization but does not provide a
  transaction spanning multiple files.
- Relay control mutations persist actor-aware audit records. Atomic deployment
  activation records the CLI actor, credential, deployment ID, and affected
  paths. Direct SFTP writes do not create deployment-level audit records.
- Hearth persists encrypted managed-database credentials. Relay-managed
  databases own isolated Docker networks and volumes, but no persistent
  server-to-database association or reconciliation record exists yet.
- Brick recipes are versioned catalog metadata resolved by Relay. Paper already
  provides the Minecraft/Java conventions that the future Purpur Brick can
  reuse.

## Phase 1 vertical slice

`kiln files sync <server> <local-directory>` obtains one authorized SFTP
connection and keeps it open for planning and transfer. The CLI inventories
regular local files, rejects symlinks, applies relative exclude globs, walks the
remote tree without following remote symlinks or descending into excluded
directories, and compares size followed by SHA-256 when sizes match. It creates missing directories, uploads only changed
files, then verifies remote size and SHA-256. `--plan` performs no writes and
`--json` emits a versioned plan/result document.

Excludes bound the remote walk as well as the local one, so a deployment costs
what it manages rather than what the instance happens to hold. This matters at
both ends of the scale: worlds and logs would otherwise be stat-ed in full on
every run, and count against the walk's entry ceiling.

Planning, transfer, and verification failures use distinct nonzero exit codes.
Authentication and authorization retain the existing HTTP/SFTP failure codes
and checks at both Hearth and Relay.

`instance.files.list` takes an optional path and the Relay walks that subtree
rather than walking the instance root. The walk stops at a fixed entry ceiling,
so a listing filtered after the fact returned nothing for the requested
directory once anything ahead of it in the walk - typically worlds and rotated
logs - reached that ceiling first. Hearth still narrows the response by prefix,
because a Relay older than this change ignores the path and answers with the
whole instance; scoping is what raises the ceiling, and the filter is what keeps
an unscoped answer from reaching the caller. Listing a non-directory now fails
instead of returning the single matching entry.

## Phase 2 transactional activation

`--atomic` prepares a deployment-specific staging directory, uploads changed
files below it through the same SFTP session, verifies staged size and SHA-256,
and asks Relay to activate the complete plan. Relay independently verifies the
staging marker, hashes, target preconditions, and path boundaries. Each staged
file is installed with a same-filesystem rename. Existing and deleted files are
moved into a rollback tree until every rename succeeds. An fsynced external
journal lets Relay roll back an interrupted activation during startup recovery.

`--delete-managed` requires `--manifest <path>` and `--max-delete <count>` has a
safe default of zero. The manifest is versioned JSON:

```json
{
  "version": 1,
  "managed": ["plugins/Example.jar", "config/example.yml"]
}
```

Only missing regular files named in `managed` become deletion candidates.
Directories, excluded paths, undeclared plugin data, `.kiln`, logs, backups,
crash reports, standard world roots, and directories detected as worlds by a
`level.dat` file are preserved. Hearth requires `instance.files.write` for
staging and activation and the separate `instance.files.delete-managed`
permission whenever managed deletion is requested. Relay also requires its
dedicated `instance.files.sync` action at the control boundary.

Failed transfers and verification trigger marker-checked staging cleanup when
Hearth and Relay remain reachable. Committed or interrupted activation journals
are reconciled when Relay starts. Phase 1 direct mode remains available when
`--atomic` is omitted and retains its non-transactional behavior.

## Deferred work

Phase 3 adds persistent database associations and reconciliation. Phase 4 adds
the official Purpur Brick. Atomic transactions currently support at most 2,000
affected files per deployment. Hard termination before Relay receives the
prepare response can leave an unjournaled staging directory; a later retry may
use a new deployment ID and administrators can remove the abandoned marked
directory after inspection.
