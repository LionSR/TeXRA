# Support code after the restructure: what the sweep left for a design call

Date: 2026-10-03
Status: proposed
Origin: lane 3 of the 2026-10-03b simplification sweep over the host-agnostic
support code, now under `packages/harness/src/{utils,common,platform,logger}/`.
Its behaviour-preserving finds merged in #13670. Of the findings it left, the
`LanguageModelPort.onDidChange` split, the `entryTypeIn` ENOTDIR fix, the
second config-path derivation, `ConfigProvider.inspect`'s `| undefined`, the
`@common/errors` barrel (gone; AGENTS.md says to import the leaf module), the
plugin digest's symlink read (now one `lstat` per entry, with no recovery) and
the hook runner's stdio read (now logged at `warn` before the result keeps
what was read) have since been settled. The `initializeNodeRuntimeSkills`
inline was dropped: the package split made it a published `./node` export
(`packages/harness/src/node.ts`) whose caller, `bootstrapHost`, now lives in
the app, which may not import `@skills`. Re-checked against `main` at `808521a8ed`
(2026-10-30); what follows is still open.

## 1. Two silent catches

- `packages/harness/src/common/plugins/pluginHooks.ts`, `runHook`:
  `handle.exitCode.pipe(Effect.orElseSucceed(() => null))` turns every
  exit-code failure into "exited, code null". The comment only justifies a
  signal kill.
- `packages/harness/src/utils/files/externalRoots.ts`, `readLinkOrUndefined`:
  the comment says EINVAL or ENOENT, but the bare `catch` also absorbs EACCES
  and ELOOP.

Proposal: give each one a code predicate, or log at `warn` before
recovering. Not done in the sweep: each changes which failures surface, and
the hook runner's verdicts are pinned by
`src/test-kernel/common/HookProtocol.vitest.ts`.

## 2. Hooks and MCP servers resolve a program on different PATHs

`pluginDigest.ts` (`externalFiles`) resolves an MCP server command with
`whichOnExtendedPath`. `pluginHooks.ts` (`pinHook`) resolves a hook program
with `which.sync(program, { path: process.env.PATH })`. If a binary is only
on the extended PATH, it pins for a server but is refused for a hook, and
the two can pin different binaries for the same name.

The server side is settled: its spawn gets the extended PATH its pin
resolves over, so a server runs the binary it pinned without moving any
persisted trust digest. The hooks are consistent with themselves: `runHook`
spawns with `extendEnv: false` and `PATH: process.env.PATH ?? '/usr/bin:/bin'`,
and `pinHook` resolves over `process.env.PATH ?? ''`, so with PATH unset the
hook is left dynamic rather than pinned against that fallback. The extension
host writes the extended PATH into `process.env.PATH` once it activates, so
there hooks see it too; the CLI and the desktop app do not.

Still open: one resolver for hooks and servers. Not done because it changes
which hooks load, and with that the hook trust digests.

## Rejected

- **Narrowing `PromptMessageItem` to `T`:** `VscodeUiHost.confirm` builds
  its own close-affordance item through it. Moving that inside the host
  trades one type arm for a private items path.
- **Inlining `planTeamRuns`:** it has two callers (the CLI's `team` command
  and `loadTeamOptions`).
