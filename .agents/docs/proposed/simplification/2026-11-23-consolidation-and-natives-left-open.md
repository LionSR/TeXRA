# Consolidation and natives: what the 2026-11-23 audit left open

Date: 2026-11-23
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what the standard library or Effect provide. These landed in the PR that
adds this note:

- `hostFailed` and `fromHost` take the sentence that goes before a cause's
  words, and `fromHostSync` lifts a host API that answers at once; nine
  hand-built `HostFailed` values and three local sync lifters call them
- `Record.isEmptyRecord` in place of six `Object.keys(x).length` counts
- `Array.max` / `Array.min` with a named `Order` for five running-best loops
- `processRunning` (`@texra-ai/worldline/node`) for the two signal-0 checks
- `withSince` in the repo poller, which wrote its own copy
- `String.capitalize`, `Number.clamp`, `Array.takeWhile` and one
  `path.parse` for four hand-written forms

## Open

1. **Approval grants compared as JSON text.** `sameGrants`
   (`packages/harness/src/agent/runtime/runApprovalQueue.ts`) compares
   `JSON.stringify([own, goal, limit])`. `own` is a record with optional
   keys, built by a spread and then assigned to, so two equal grants whose
   keys were written in a different order read as changed and write one more
   `approval.policy` row. `isDeepStrictEqual` (`node:util`, already used in
   `toolGuard.ts`) ignores key order, but it tells `{ a: undefined }` from
   `{}`, which the JSON text does not. Decide which of the two a stored row
   can hold before switching. The same question stands for the
   `ifCurrent` check in `packages/texra/src/controllers/server/service.ts`.
2. **GitHub query strings.** The poll paths under
   `packages/texra/src/tools/github/` (`checkRunsClient.ts`,
   `pullPoller.ts`, `issuePoller.ts`, `githubSubscriptionTool.ts`) write
   their query by hand, and `withSince` chooses `?` or `&` by looking for a
   `?`. `URLSearchParams` would build them, but it writes a space as `+` and
   encodes the `:` of `head=owner:branch`, and two suites pin the paths as
   text. One `withQuery(path, params)` in `githubPaths.ts` once those
   suites match a parsed URL.
3. **The home directory and tilde expansion** (items 1 and 2 of the
   2026-11-21 note, item 3 of the 2026-11-22 note) are unchanged:
   `commandDirs()` is still called from a synchronous install-command
   getter that holds no runtime.
4. **One timestamp format, twice.** `toISOString().replace('T', ' ').slice(0, 19)`
   is in `packages/harness/src/tools/executionFormatters.ts` and
   `packages/desktop/src/renderer/logsPane.ts`. A shared formatter would be
   a new export on the browser-safe `./schemas` entry for two callers.

## Checked and declined

- **`Record.isEmptyRecord` over a struct with optional keys**
  (`loop/rows.ts`, `traceLogs.ts`, `surface.ts`, `BaseRequestPanel.ts`).
  Its parameter is a `Record<K, V>`, which a type with optional keys is
  not assignable to.
- **A fixed sentence with no cause words** (`VscodeUiHost.ts`,
  `desktopPreviewHost.ts`) and the sentence that follows its cause
  (`ToolEditApprovalController.ts`) still build `HostFailed` themselves:
  `hostFailed` puts its sentence before the cause's words.
- **`dynamicSourceFunctions` in the bash and zsh completion writers.** The
  same eight lines but for the guard each shell needs; a shared function
  taking the guard saves about as much as it adds.
- **`firstSentence` in `codemode/declarations.ts` and
  `ui/copy/delegationApproval.ts`.** One stops at a newline, the other
  joins lines first, and the second must stay browser-safe.
- **`reasoningChoice.ts` (nearest value, a tie goes up) and
  `lineageMapping.ts` (a tie is no match)** as `Array.min`: neither rule is
  an `Order`.
- **Millisecond constants as `Duration` values.** Every reader takes a
  number, so each would gain a `Duration.toMillis`.
- **`parseArgs` for `--app` in `scripts/verify-desktop.mjs`.** One flag,
  read once.
