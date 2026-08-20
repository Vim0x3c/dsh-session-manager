# dsh-session-manager

[中文](README.md) | English

An installable session-management plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It lists every materialized local session, including running, idle, and archived sessions, and provides Resume, Outline, and permanent Delete actions.

## Important

**No deepseek-harness source changes are required.**

Starting with `0.2.0`, this package contains all of the following:

- the browser Session-management panel;
- the Host-side `session.delete` RPC;
- live Agent stop and Session-detach compatibility logic;
- JSONL and SQLite durable deletion;
- loopback, Host, Origin, and Fetch Metadata trust checks.

Users install this plugin and restart `dsh web`. They do not copy code into harness or edit `SessionsApi`, `AgentLoop`, `SessionPersistence`, or any harness file.

## Features

- **Complete session list**: live and cold sessions, archived or not, with title, status, working directory, and update time.
- **Resume**: opens an existing conversation through the browser sessions service.
- **Outline**: folds the recent `session.history` window in the browser into turn, message, and tool-call counts.
- **Permanent delete**: stops and drains a live Agent, detaches its Agent/Session registrations, waits for final persistence retirement, and then removes durable data.
- **JSONL**: removes the complete session-owned directory, including the log and colocated snapshots.
- **SQLite**: deletes through the active backend connection in a transaction; event rows are removed by the schema's foreign-key cascade.
- **Forward compatibility**: native `AgentLoop.stop` and `SessionPersistence.delete` methods are preferred when a future harness supplies them.

Ordinary forks are deletable. Child sessions with `origin: subagent` remain owned by their parent Agent; the UI hides Delete and direct requests return `agent-busy`.

## Compatibility

- Target: DeepSeek Harness `0.1.0-rc.8`.
- Supported first-party persistence backends: `session-persistence-jsonl` and `session-persistence-sqlite`.
- A custom persistence backend must expose `delete(id)` itself. Unknown storage is rejected explicitly rather than guessed or modified directly.
- The delete endpoint accepts loopback authorities only: `localhost`, `127.0.0.0/8`, and `[::1]`. A page opened through a LAN address retains Resume and Outline but does not offer Delete.

The Host implementation fills three interfaces missing from rc.8 and uses rc.8 lifecycle/coordinator internals. Re-run this repository's tests before upgrading harness. As native upstream methods become available, the plugin selects them first and avoids the relevant compatibility path.

## Install

Build the distribution tarball in this repository:

```sh
pnpm install
pnpm pack
```

Install the emitted `dsh-session-manager-0.2.0.tgz` into the web profile:

```sh
dsh plugin --profile web add -w ./dsh-session-manager-0.2.0.tgz
```

Restart `dsh web` after installation.

The `-w` flag is required because each profile contains a `pnpm-workspace.yaml`; a bare add fails with `ERR_PNPM_ADDING_TO_ROOT`. Distribute the built tarball. A git URL installs sources and requires a successful build on the target machine, which can otherwise leave `lib/` missing.

The package's `dsh.bundle.patch` inserts one `dsh-session-manager` Loader row. That row activates both the Host plugin and its `dsh.client` browser half, with peers resolved from the dsh application closure. Installers do not edit the profile's `cordis.patch.yml` manually.

## Usage

Open **Settings -> Sessions**:

- Resume enters an existing conversation;
- Outline displays recent activity statistics;
- Delete opens a confirmation dialog and permanently removes the session.

Deletion is irreversible. Deleting an open live conversation removes it from the Host registries, allowing existing surfaces to react through the normal `host/session-removed` lifecycle.

## How It Works

1. The browser reads `session.list` and `workspace.list` for the complete corpus and archive state.
2. Delete uses Connection's generic RPC caller to POST `/api/session.delete`.
3. The plugin Host half applies the same loopback and same-origin checks used by harness.
4. For a live session it calls native `AgentLoop.stop`, or locates rc.8's exact `agentLoop.lifecycle(<id>)` disposer and awaits complete teardown.
5. It waits for persistence retirement, then deletes JSONL/SQLite data on the coordinator's per-session serialization chain and clears cached state.
6. The client reloads the corpus so the view reflects final Host state.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Tests cover controller races, loopback/Origin rejection, live lifecycle teardown, JSONL directory deletion, SQLite transactions, subagent refusal, and same-id request coalescing.

## Known Limitations

- Outline describes the recent `session.history` window, not the complete log.
- Deleting an archived session does not remove its stale id from `archivedSessionIds`; that inert registry entry cannot restore session data.
- The corpus has no cross-tab push refresh; the panel reloads after deletion and reconnection.
- Delete is unavailable from non-loopback pages.

## License

MIT
