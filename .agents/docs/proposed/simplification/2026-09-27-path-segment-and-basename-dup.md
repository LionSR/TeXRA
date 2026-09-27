# Path-segment splitting and basename lookup: two deferred consolidations

Date: 2026-09-27
Origin: scheduled native-method/consolidation sweep (four-domain survey:
async/timing, hand-rolled data-structure ops, cross-webview duplication,
string/path utilities). Three call sites of hand-rolled `Map`-bucket grouping
and one GitHub-polling query-string bug were fixed directly in this pass
(`groupBy` consolidation in `workflowRunModel.ts`, `TaskGroupList.ts`,
`begEndEnvironmentProbe.ts`; the `since=` always-included bug in
`RepoPollingSource.ts`). These two remaining findings were deliberately left
unedited — each has a real reason the mechanical swap isn't safe as a
drive-by change.

## 1. Path-segment splitting duplicates `pathCore.ts`

`src/utils/core/pathCore.ts` already exports `getPathSegments` (split +
filter, no `.`/`..` resolution — deliberately, so traversal attempts stay
detectable) and `toPosixPath` (splits AND resolves `.`/`..` via `pathe`'s
`normalize`). Three files re-derive a similar split/filter shape instead of
importing either:

- `src/common/files/fileListingRules.ts:101-103,110-111` — `containsHiddenSegment`
  and `containsExcludedDirectory` split on `/` without filtering `.`/`..`
  (closest to `getPathSegments`, but `containsExcludedDirectory` lowercases
  the whole path before splitting, which the shared helper doesn't do).
- `src/agent/output/compiledPdfArtifacts.ts:31-34` — `normalizePdfRelativePath`
  splits and filters out literal `.`/`..` segments, then rejoins. This is
  **not** equivalent to `toPosixPath`: filtering out a literal `'..'` segment
  (`foo/../bar` → `foo/bar`) is different from resolving it
  (`toPosixPath('foo/../bar')` → `bar`). Swapping to `toPosixPath` would
  change behavior for any PDF path containing a real `..` traversal segment,
  not just cosmetically shorten the function.
- `src/utils/files/outputFileUtils.ts` (`getSafeDocumentPathParts`) — parses
  `dir`/`name`/`ext` via `path.posix.parse` then filters the `dir` segments,
  including a drive-letter check (`^[A-Za-z]:$`) that neither `pathCore`
  helper has.

None of the three are browser-safety-constrained (none on the
`BROWSER_SAFE_UTILS` allowlist; two already import `node:path` directly), so
there's no platform reason to leave them as-is.

**Proposal:** before swapping any of these to `getPathSegments`/`toPosixPath`,
decide on purpose whether traversal segments (`..`) should be filtered
(current `compiledPdfArtifacts.ts` behavior) or resolved (`toPosixPath`
behavior) for PDF-artifact paths and for the drive-letter case in
`outputFileUtils.ts` — then either extend `pathCore.ts` with the exact shape
these three need, or fix each call site's `..`-handling deliberately and
route it through the (possibly extended) shared helper. This is a design
decision about traversal semantics, not a mechanical dedup, so it shouldn't
ride as a drive-by fix.

**Not a candidate:** `src/shared/tools/executionsDisplay.ts:27` does the same
split, but it's imported by webview-reachable code (`src/ui/transcript/*`)
and can't pull in `pathCore.ts` (which imports `node:path`). Its duplication
is the accepted cost of the `BROWSER_SAFE_UTILS` boundary.

## 2. `monacoLanguage.ts` basename reimplementation

`src/shared/monaco/monacoLanguage.ts:20` hand-rolls
`filePath.replaceAll('\\','/').split('/').at(-1) ?? ''` instead of importing
`getBasename` from `@utils/core` (browser-safe, behaviorally equivalent,
including the trailing-slash case). This is a single occurrence, and the
file's own header comment states an explicit design intent: it's "kept in
its own module with no `monaco-editor` import of any kind" so that importing
it never drags a bundler-visible worker chunk into a build that doesn't use
Monaco. `@utils/core` doesn't do any dynamic `import(...?worker)`, so the
specific bundling hazard the comment warns about doesn't apply — but given
the file explicitly signals "keep this isolated" and the finding is thin
(one call site), this is left as a documented candidate rather than an
applied fix: a maintainer who owns this file's isolation intent should
decide whether pulling in `@utils/core` is an acceptable exception before
someone lands it.

## What was surveyed and found clean (do not re-propose)

- Async/timing/concurrency (manual sleep, debounce/throttle, retry loops,
  `.then()`/Effect mixing, hand-rolled mutex/queue, extra `AbortController`
  usage): nothing beyond what the 2026-09-17 Effect-round-trips ledger and
  its siblings already name or rule on.
- Array dedup, `JSON.parse(JSON.stringify())` clones, deep-equal,
  `hasOwnProperty`, UUID reimplementation, mutating `.sort()` on
  caller-owned arrays: zero hits repo-wide.
- Byte-size/number/duration/pluralization formatting: already consolidated
  (`formatBytes`, `pluralize`/`formatResultCount` in `stringUtils.ts`;
  `Intl.*` used appropriately elsewhere).
- Cross-webview duplication (progressView vs settingsView; trace-viewer
  reuses `progressView/frontend` directly rather than forking it): the
  classic candidates (date/time formatting, tablist keyboard nav, banner
  frames, copy-button controller) are already consolidated into `src/ui/`.
  No loop- or state-machine-level duplication survived scrutiny; the two
  thin candidates found (toggle-row-list rendering, window-message-listener
  lifecycle boilerplate) don't clear the "substantial duplication" bar.

## Risk / estimated delta

Both remaining items are low-risk to leave open (no behavior bug, unlike the
`RepoPollingSource.ts` fix applied in this pass) and small in scope
(≤3 files, ≤1 file respectively) whenever someone picks them up.
