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
inline is moot: neither it nor `bootstrapHost` exists any more. Re-checked against `main` at `808521a8ed`
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

## 2. Hooks and MCP servers resolve a program on different PATHs (done)

Done: `pinHook`, `hookShell` and `runHook` (`pluginHooks.ts`) resolve and
spawn on the PATH extended with `CommandDirs`, as `externalFiles` and an MCP
server's spawn do. A hook whose program is found only on the extended PATH
now pins, so its plugin's digest changes and enabling asks for trust again.
With PATH unset, `runHook` spawns on `/usr/bin:/bin` extended while the
lookup would search the `CommandDirs` alone, so `pinHook` leaves the hook
dynamic rather than pin a binary the spawn may not run.

## Rejected

- **Narrowing `PromptMessageItem` to `T`:** `VscodeUiHost.confirm` builds
  its own close-affordance item through it. Moving that inside the host
  trades one type arm for a private items path.
- **Inlining `planTeamRuns`:** it has two callers (the CLI's `team` command
  and `loadTeamOptions`).
