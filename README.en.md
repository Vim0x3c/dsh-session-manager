# dsh-session-manager

中文 | [English](README.md)

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

```sh
# from a release tarball
dsh plugin --profile web add -w ./dsh-session-manager-0.1.0.tgz
```

> The `-w` flag is required: every profile ships a `pnpm-workspace.yaml`, so pnpm treats the profile directory as a workspace root and refuses a bare `add` with `ERR_PNPM_ADDING_TO_ROOT`. Then restart `dsh web`.

The package is a `dsh.client` browser plugin that also declares `dsh.bundle.patch`, so `dsh plugin` installs it as an activatable layer and the profile's module fallback resolves its peers from the dsh application closure. The patch inserts a loader row with the package's own id (`dsh-session-manager`) — deliberately not the official `ui-session-manage` id, so it never collides with a deployment that already ships the built-in row. On a current web-app deployment that already carries the official session-management row, the two panels coexist (identical features); install this package when your dsh lacks the built-in row — an older or custom web profile.

> Installing from a git URL fetches sources, not the built `lib/`, and the plugin's peer packages are not published to npm, so a git install cannot build or resolve them. Ship the tarball instead.

## Usage

Open **Settings → Sessions** in dsh web. Each row shows the session's title, id, badges, and meta; the actions are Resume, Outline, and Delete.

## Develop

```sh
pnpm install
pnpm build     # tsdown: emits lib/index.js, lib/invariant.js, lib/client.js
```

The build is self-contained (tsdown + lightningcss), with no monorepo checkout required. `prepare` runs the same build, so git installs that allow it produce the artifacts.

## How it works

- Reads `session.list` (every materialized session, archived included) and `workspace.list` for the archive set.
- Resume writes nothing on the wire: it calls the browser sessions service `sessions.open`.
- Outline reads `session.history` (the tail page) and folds it client-side.
- Delete writes `session.delete`, the loopback-pinned privileged RPC that stops the agent before erasing the durable data.

## Known Limitations

- **Outline is the recent window, not the whole log** — it folds the `session.history` tail page, which carries at most a bounded number of messages.
- **An archived id can outlive its session** — there is no unarchive write, so deleting an archived session leaves its (now stale) id in `archivedSessionIds`; the registry tolerates absent ids, so the stale entry is inert.
- **No pushed corpus updates** — the page refreshes on its own deletes, its own open, and reconnects, not on host frames.
- **Subagent sessions reject deletion** — the host answers `agent-busy` for a session with a live subagent owner.

## License

MIT
