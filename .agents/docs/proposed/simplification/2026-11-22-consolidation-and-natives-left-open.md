# Consolidation and natives: what the 2026-11-22 audit left open

Date: 2026-11-22
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what the standard library or Effect provide. These landed in the PR that
adds this note:

- `formatWordList` (`Intl.ListFormat`) for every sentence that joins words
  with `and` or `or`
- `Number.sumAll` in place of seven hand-written sums
- `Duration.format` for every configured timeout a message names, and four
  timeout constants as `Duration` values
- one text-entry focus reader (`packages/texra/src/ui/textEntryFocus.ts`),
  item 3 of `2026-11-21-consolidation-and-natives-left-open.md`
- the Codex effort ceiling reads its own list instead of a copy of llm's
  `rank`

## Open

1. **String order, two rules.** About twenty sorts call `localeCompare`
   (locale- and ICU-dependent) and four call `Order.String` (code units).
   Three write the same `files.toSorted((a, b) => a.path.localeCompare(b.path))`
   (`packages/cli/src/runtime/history.ts`,
   `packages/harness/src/agent/storage/runWorkspaceFiles.ts`,
   `packages/harness/src/tools/executions/runGeneratedFiles.ts`). Which rule
   a listing a model reads should use is a decision: code-unit order is the
   same on every machine, locale order reads better to a person.
2. **Durations computed at run time.** The retry waits in
   `ModelInvoker.ts`, `run/modelCall.ts` and `ModelRetryGate.ts` and the
   catalog's load time in `agentCatalog.ts` still print `${ms}ms`. They are
   computed, possibly fractional, and land in logs; rounding them first is a
   choice this run left.
3. **The home directory, still read four ways** (item 1 of the 2026-11-21
   note). `commandDirs()` could take `home` from `homeDirectory` in the
   process layer, but `preferredInstallCommand` calls it from a plugin's
   synchronous `installCommand` getter, which holds no runtime. Either that
   getter becomes an Effect in the setup contract, or a synchronous home
   reader joins `platformPaths.ts`.

## Checked and declined

- **`includes` then `push` as a `Set`** (`runRowReads.ts`,
  `hookProtocol.ts`, `extendEnvPath`). Each list holds a handful of items
  and keeps its order; a `Set` beside the array is not simpler.
- **The desktop workbench's width sum and the TUI's cursor prefix.** One
  sums DOM widths in a renderer that imports no Effect; the other adds a
  newline per row, which a `map` before `sumAll` would only move.
- **`loopbackLogin`'s port list** (`packages/llm/src/oauth/`). llm cannot
  import the harness, and two ports read the same either way.
- **The linked install-guide names in `DependencyBanner`.** Each name is
  its own button, so the joiner stays hand-written; it now puts the serial
  comma where `formatWordList` does.
