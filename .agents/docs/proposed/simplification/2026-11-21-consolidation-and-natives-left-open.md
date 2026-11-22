# Consolidation and natives: what the 2026-11-21 audit left open

Date: 2026-11-21
Status: proposed

Origin: the scheduled audit for duplicated logic and hand-written versions
of what Node, the standard library or Effect provide. These landed in the PR
that adds this note:

- `SettingsCatalog.defaultOf` (was `configDefault`, config rows only)
- `normalizeLineEndings` in `@texra-ai/harness/schemas`
- `languageForPath` in `@ui/highlighting/fileLanguage`
- `formatCount` in place of the app's `formatTokenCount`
- `raisedBy` read from one module
- two inline plurals through `formatResultCount`

Item 3, whether focus is in a text field, landed in the 2026-11-22 UI audit:
`isTypingKeystroke` and `textEntryHasFocus` (`packages/texra/src/ui/wa/keyActivation.ts`)
answer it for the desktop shortcut registry and the request cards.

## Open

1. **The home directory is read four ways.**
   - `homeDirectory` (`packages/harness/src/utils/system/platformPaths.ts`)
     wraps `os.homedir()` and warns when it throws.
   - `packages/texra/src/platform/defaults/commandDirs.ts` reads `HOME` alone
     in `pushHomeBinDirs` and `HOME || USERPROFILE` for the TeX roots.
   - `packages/harness/src/common/plugins/installedPlugins.ts` calls
     `os.homedir()` bare, which can throw.

   `commandDirs()` is synchronous, and `availabilityProbes.ts` calls it from
   a getter that holds no runtime. Taking `home` as a parameter needs that
   getter to get the directories from its caller first.

2. **Tilde expansion, twice, with different rules.** `installedPlugins.ts`
   expands only `~` plus the platform separator; `claudeAgentConfig.ts`
   (`packages/texra/src/tools/agentCli/`) expands `~/` and `~\` on every
   platform. One `expandHome(input, home)` beside `homeDirectory` once item 1
   decides how a synchronous caller gets `home`.

## Checked and declined

- **`envVar` in llm and in the harness.** Identical five lines. The harness
  exports its copy on `./node`; llm cannot import the harness, and a
  harness re-export of an llm function is a shim.
- **`truncatedHexId` for three app hashes** (`compileCheck.ts`,
  `discovery.ts`, `protocol.ts`). They call Node's one-shot `hash`; a
  one-line harness wrapper on a public entry is not a gain.
- **`toErrorMessage` in `packages/llm/src/node.ts`.** The fact-spread
  ratchet counts files that name it, so the call raises the count.
- **One home path for `redactDiagnostics`** (desktop log viewer, CLI
  doctor). `redactPathPrefixes` splits on either separator, so normalizing
  the home path changes nothing, and the module stays free of `os`.
- **`RunGeneratedFile` as `RunWorkspaceFile`.** Same fields, different
  facts (files a run wrote under storage, workspace files it edited).
- **`Map.groupBy` for the agent-name collision count**
  (`packages/cli/src/runtime/agents.ts`) and `Array.dedupeWith` for
  `mergeHistoryFiles`. Neither is shorter.
- **The GitHub formatters' `truncate`, the ASCII `truncate` in
  `conversationFormat.ts`, the diff truncations.** Each cuts differently
  on purpose (Unicode or ASCII ellipsis, lines or characters).
