# Deployment file sync architecture

This note records the architecture and boundaries used for the first phase of
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
- Relay control mutations persist actor-aware audit records. Direct SFTP writes
  do not currently create deployment-level audit records.
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
remote tree without following remote symlinks, and compares size followed by
SHA-256 when sizes match. It creates missing directories, uploads only changed
files, then verifies remote size and SHA-256. `--plan` performs no writes and
`--json` emits a versioned plan/result document.

Planning, transfer, and verification failures use distinct nonzero exit codes.
Authentication and authorization retain the existing HTTP/SFTP failure codes
and checks at both Hearth and Relay.

## Deferred work

Phase 2 adds deployment staging, multi-file activation, managed manifests,
guarded deletion, cleanup, and actor/path audit records. Phase 3 adds persistent
database associations and reconciliation. Phase 4 adds the official Purpur
Brick. Phase 1 never deletes remote files and does not claim multi-file
atomicity.
