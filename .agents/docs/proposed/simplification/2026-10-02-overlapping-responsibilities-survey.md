# Overlapping-responsibility survey: 2026-10-02

Date: 2026-10-02
Status: proposed (no code change; nothing met the bar for an unsupervised refactor)
Origin: scheduled audit, charter "find confusing or overlapped
responsibilities between modules and consolidate the most significant one."

## Method

Read the 2026-09-28 survey first and did not re-open its items. Then probed
for duplicated helpers by name and shape (truncation, ENOENT predicates,
escape/record guards, mime and extension tables, `src/common` vs `src/utils`
vs `src/shared/utils`, the Codex and Claude Code tool-log builders).

## Verified clean (one owner each)

- Truncation: `truncateWithEllipsis` / `truncateSummary` in
  `@utils/text/stringUtils` are the owners. The GitHub `truncate` wrappers
  delegate to them. `conversationFormat.ts`'s local `truncate` is
  deliberately ASCII-only and says so in a comment.
- File-not-found classification: `isFileNotFoundError` in
  `@common/errors/errorPredicates` is the only `ENOENT` predicate; the one
  other `ENOENT` mention (`platform/defaults/workspaceStorage.ts`) is a
  multi-code allowlist, not a duplicate.
- `src/common/errors` vs `@utils/errors/errorMessage`: the split (kind
  classification vs browser-safe `unknown` narrowing) is documented in
  AGENTS.md and holds in the tree.
- `codexShared.ts` / `claudeAgentShared.ts`: parallel by design (one per
  external agent CLI); no shared logic duplicated between them.

## Findings (documented, not actioned)

### 1. "Plugin" names two unrelated systems, with two files called `pluginManifest.ts`

- `src/tools/pluginManifest.ts` (+ `plugins.ts`, `pluginLayers.ts`,
  `pluginArms.ts`, `pluginAvailability.ts`): the built-in *tool* plugins, the
  dashboard cards, toggles and availability probes. Data, re-registered by
  code at startup.
- `src/common/plugins/pluginManifest.ts` (+ `marketplace.ts`,
  `installedPlugins.ts`, `pluginTrust.ts`, ...): the *installable* Claude
  Code / Codex-format plugins read from disk.

Same word, same file name, disjoint concepts and consumers (15 files import
`@tools/plugins`; the CLI and settings controllers import `@common/plugins`).
It is already recorded as item 11 of
`proposed/architecture/2026-09-26-core-concepts/audit.md` ("Plugin names seven
distinct things"), and plugin work is in flight
(`2026-09-28-code-plugins-hooks-v1.md`). A rename is the right fix
(e.g. `tools/plugins*` -> `tools/toolPlugin*`, with `pluginManifest.ts` ->
`toolPluginManifest.ts`), but it touches ~30 files and several test paths and
belongs to whoever owns the core-concepts vocabulary ruling, so it is left
for them rather than raced from a scheduled pass.

### 2. Two mime-subtype -> extension tables

`src/shared/utils/clipboardImages.ts` (`IMAGE_MIME_TYPES`, browser-only, so it
cannot import `mime-types`) and `src/tools/emlParser.ts`
(`MIME_SUBTYPE_TO_EXT`) both map image MIME types to extensions. They
disagree (`tiff` -> `tiff` vs `tif`), so merging changes behavior, and the
browser-safe constraint blocks sharing the first one. Sub-bar; noted only.

## Conclusion

No significant new overlap. Responsibilities in the areas swept are
well-defined; the one real confusion (finding 1) is a known naming collision
awaiting an owner ruling. Delta: +1 doc, no production change.
