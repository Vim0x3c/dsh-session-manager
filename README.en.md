# dsh-session-manager

[中文](README.md) | English

A settings section for [dsh web](https://github.com/deepseek-ai/deepseek-harness) that lists **every session on your machine** — running, idle, and archived — and lets you:

- **Resume** a conversation: switch straight into it and leave the settings panel.
- **Preview an outline** of its recent activity: turn/user/assistant counts, per-tool call breakdown, and the activity window.
- **Delete** any session permanently, behind a confirmation dialog.

It is the one surface where an **archived session** can still be seen: the workspace browser hides archived rows everywhere, so a session can only be removed here once it is archived.

`dsh-plugin` topic:(https://github.com/topics/dsh-plugin)

## Features

- **Full corpus**: every materialized session — attached and cold, archived or not — newest first, with the latest title, running/idle state, a not-started marker, last-updated time, and working directory.
- **Resume**: opens the session through the browser sessions service and closes settings, landing on the conversation. Disabled while the session is running.
- **Outline**: folds the `session.history` tail page entirely in the browser — no model-visible state is derived or persisted.
- **Delete**: the host stops a live session first (cancel agent, await quiescence, detach — the open conversation grays out via `host/session-removed`), then removes the durable data. Loopback-pinned and irreversible.

## Install

Requires a dsh whose application closure contains the plugin's `@deepseek-ai/dsh-*` peer packages — any deployment with the `@deepseek-ai/dsh-web-app` bundle.

**Deletion requires `session.delete`**, a loopback-privileged RPC added recently in dsh. On a non-loopback page, or a host that does not expose the method, the delete button is hidden (with an inline note when a dialog is already open); only the resume/outline actions remain. Version this plugin with a host that ships `session.delete` (the harness working tree has it; older releases may not).

```sh
# 1. In the plugin directory, build and pack a tarball (emitted as <name>-<version>.tgz,
#    e.g. dsh-session-manager-0.1.0.tgz).
pnpm install
pnpm pack

# 2. Install that tarball into a profile (replace <file>.tgz with the real file from step 1).
dsh plugin --profile web add -w ./<file>.tgz
```

> The `-w` flag is required: every profile ships a `pnpm-workspace.yaml`, so pnpm treats the profile directory as a workspace root and refuses a bare `add` with `ERR_PNPM_ADDING_TO_ROOT`. Then restart `dsh web`.

> The tarball is a build artifact (`.tgz` is git-ignored) that is not committed or auto-generated on release — produce it with `pnpm pack` as above, not by referencing a deleted file.

The package is a `dsh.client` browser plugin that also declares `dsh.bundle.patch`, so `dsh plugin` installs it as an activatable layer and the profile's module fallback resolves its peers from the dsh application closure. The patch inserts a loader row with the package's own id (`dsh-session-manager`) — deliberately not the official `ui-session-manage` id, so it never collides with a deployment that already ships the built-in row. It is positioned as a compatibility/extension panel: **install it only when your dsh lacks the built-in Session-management row**. On a current web-app deployment that already carries the official row, the two panels coexist with identical features; the extra one is redundant.

> Installing from a git URL fetches sources, not the built `lib/`, and the plugin's peer packages are not published to npm, so a git install cannot build or resolve them. Ship the tarball instead.

## Usage

Open **Settings → Sessions** in dsh web. Each row shows the session's title, id, badges, and meta; the actions are Resume, Outline, and Delete. Subagent/child sessions (live or forked) and any delete on a non-loopback page or capability-less host show no Delete action — the badge reads *Managed by parent*.

## Develop

```sh
pnpm install
pnpm build          # tsdown: emits lib/index.js, lib/invariant.js, lib/client.js
pnpm typecheck      # tsc --noEmit against dev-only type stubs (see below)
pnpm test           # vitest: foldOutline + controller behavior
```

The build is self-contained (tsdown + lightningcss), with no monorepo checkout required. `prepare` runs the same build, so git installs that allow it produce the artifacts.

**Typecheck in a clean checkout**: the `@deepseek-ai/dsh-*` peers are not published to npm, so `tsc` cannot resolve them from a fresh install. `tsconfig.typecheck.json` includes the ambient declarations in `types/stubs.d.ts`, which mirror the small slice of the dsh client API this plugin uses — enough to typecheck the plugin's own source without the peers. If you have a dsh workspace mounted, drop that file so tsc resolves the real packages (see `src/client/*` imports).

## How it works

- Reads `session.list` (every materialized session, archived included) and `workspace.list` for the archive set.
- Resume writes nothing on the wire: it calls the browser sessions service `sessions.open`.
- Outline reads `session.history` (the tail page) and folds it client-side.
- Delete writes `session.delete`, the loopback-pinned privileged RPC that stops the agent before erasing the durable data.
- List and outline loads are last-request-wins: concurrent reads (a reconnect racing a retry, or consecutive outline dialogs) never let a slow older response clobber a fresher snapshot.

## Known Limitations

- **Outline is the recent window, not the whole log** — it folds the `session.history` tail page, which carries at most a bounded number of messages.
- **An archived id can outlive its session** — there is no unarchive write, so deleting an archived session leaves its (now stale) id in `archivedSessionIds`; the registry tolerates absent ids, so the stale entry is inert.
- **No pushed corpus updates** — the page refreshes on its own deletes, its own open, and reconnects, not on host frames or cross-tab changes.
- **Subagent/child sessions are not deletable from here** — the host owns their lifecycle via their parent (`agent-busy` on a direct delete); the delete entry is hidden rather than offered and rejected.
- **Deletion is loopback-only and recent** — a non-loopback page or a host without `session.delete` hides deletion (see Install).

## License

MIT
