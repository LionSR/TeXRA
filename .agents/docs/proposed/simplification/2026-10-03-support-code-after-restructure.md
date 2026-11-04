# Support code after the restructure: what the sweep left for a design call

Date: 2026-10-03
Status: proposed
Origin: lane 3 of the 2026-10-03b simplification sweep over the host-agnostic
support code, now under `packages/harness/src/{utils,common,platform,logger}/`.
Its behaviour-preserving finds merged in #13670. Of the findings it left, the
`LanguageModelPort.onDidChange` split, the `entryTypeIn` ENOTDIR fix, the
second config-path derivation, `ConfigProvider.inspect`'s `| undefined`, the
`@common/errors` barrel (gone; AGENTS.md says to import the leaf module), the
plugin digest's symlink read (now one `lstat` per entry, with no recovery),
the hook runner's stdio read (now logged at `warn` before the result keeps
what was read), the hook runner's exit code (only a signal kill reads as
no code) and `readLinkOrUndefined` (only EINVAL and absence recovered) have
since been settled. The `initializeNodeRuntimeSkills` inline was dropped:
the package split made it a published `./node` export
(`packages/harness/src/node.ts`) whose caller, `bootstrapHost`, now lives in
the app, which may not import `@skills`. Re-checked against `main` at
`b411a6d` (2026-11-03); the one item that was still open, below, has
since landed too.

## Hooks and MCP servers resolve a program on different PATHs (done)

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
