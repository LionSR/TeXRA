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

## The 2026-11-22 natives sweep (harness and llm)

Date: 2026-11-22

A sweep of `packages/harness/src` and `packages/llm/src` for hand-written
versions of what Node, Effect, SQLite or a dependency provides. Landed:

- `web_fetch` decodes its body with `Stream.decodeText` and
  `Stream.mkString` (`packages/harness/src/tools/web/WebFetchTool.ts`): the
  same label and decoder options, stream mode per chunk and the flush of a
  split trailing character. The `Effect.try` around each decode went with
  it; a non-fatal decoder on a label checked beforehand does not throw.
- A memory file's head is `Stream.mkUint8Array`, not collected chunks and
  `Buffer.concat` (`packages/harness/src/tools/memory/memoryFileSystem.ts`).

The usual greps found nothing else: no timers, `new Promise`, retry
counters, hand-written caches, `hasOwnProperty`, sort or reverse copies,
manual grouping or dedup, `JSON.parse(JSON.stringify())` clones, or
hand-written type guards. The Effect language service, run over both
projects with every suggestion rule raised to a warning, reports only
`instanceof` on tagged-error classes (the right check for a class), Node
`path` and `fs` imports in synchronous code, and one nested `Effect.gen` in
the store's `databaseLayer.ts`, which this sweep stays out of.

### Checked and declined

- **The newline JSON-RPC reader on `Stream.decodeText` and
  `Stream.splitLines`** (`takeLines` in `packages/harness/src/tools/jsonRpc.ts`).
  `splitLines` ends a line at a bare `\r`, which JSON allows as whitespace
  between tokens, and emits an unterminated last line. Open item 3 of
  `2026-11-20-effect-modules-audit-left-open.md` (copies per chunk) stands.
- **`safeParseJson` onto `Schema.fromJsonString(Schema.Unknown)`.** Its
  failure says only "Expected a valid JSON string", and the hook protocol's
  warning quotes the parse error. Converting the one caller that ignores the
  message leaves the helper with one caller and no fewer elements.
- **`Stream.timeout` for the background observation's deadline**
  (`packages/llm/src/api/background.ts`). It bounds each pull, not the whole
  observation.
- **`sleepUntil` in `packages/harness/src/agent/followUp/FollowUpReader.ts`.**
  Effect has no sleep until an instant; re-reading the clock after each sleep
  is the behavior.
- **Node's `fs.glob` for the `glob` dependency.** The glob tool reads the
  walker's brace-expanded `patterns` for its escape check and matches dot
  files; converting the agent scanner alone keeps the dependency.
- **`util.MIMEType` for `web_fetch`'s charset.** Experimental on Node 22,
  and it throws on a malformed `Content-Type`.
- **`Stream.decodeText` for the memory head.** `TextDecoder` drops a
  leading BOM, which `Buffer.toString` keeps.
- **`Effect.ignore({ log })` in place of `logFailure`, or `logFailure` in
  place of the inline catch-and-warn sites.** `Effect.ignore` logs the cause
  as text and `logFailure` attaches it as `data`; the inline sites word the
  error into their message. Each swap changes what the progress view shows.
