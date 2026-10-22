# Path-segment splitting duplicates `pathCore.ts`

Date: 2026-09-27
Status: proposed — open design question; no code change pending.

`packages/harness/src/utils/core/pathCore.ts` exports `getPathSegments`
(trim, backslashes to `/`, split, drop empty segments; it does not resolve
`.`/`..`, so traversal attempts stay detectable) and `toPosixPath` (splits
and resolves `.`/`..` via `pathe`'s `normalize`). Three app files re-derive a
similar split instead of importing either:

- `packages/texra/src/common/files/fileListingRules.ts` —
  `containsHiddenSegment` and `containsExcludedDirectory` split
  `normalizeFilePath(...)` on `/` without filtering `.`/`..`.
  `containsExcludedDirectory` lowercases the whole path before splitting,
  which the shared helper does not do.
- `packages/texra/src/agent/output/compiledPdfArtifacts.ts` —
  `normalizePdfRelativePath` splits, drops literal `.`/`..` segments, then
  rejoins. This is not equivalent to `toPosixPath`: dropping a literal `..`
  (`foo/../bar` → `foo/bar`) differs from resolving it (`toPosixPath` gives
  `bar`), so a swap changes behaviour for any PDF path with a real `..`
  segment.
- `packages/texra/src/utils/files/outputFileUtils.ts`
  (`getSafeDocumentPathParts`) — parses `dir`/`name`/`ext` with
  `path.posix.parse`, then filters the `dir` segments, including a
  drive-letter check (`^[A-Za-z]:$`) that neither `pathCore` helper has.

None of the three is browser-reachable; `compiledPdfArtifacts.ts` and
`outputFileUtils.ts` already import `node:path`.

`getPathSegments` is not a drop-in: routing `fileListingRules.ts` and
`compiledPdfArtifacts.ts` through it was tried and reverted (#14159), because
it trims its input, so a name with leading whitespace (` .draft`,
` node_modules`, ` report.tex`) would change hidden/excluded results and
published PDF paths.

**Proposal.** Decide on purpose whether traversal segments are dropped
(today's `compiledPdfArtifacts.ts` behaviour) or resolved (`toPosixPath`)
for PDF-artifact paths, and how the drive-letter case in `outputFileUtils.ts`
should behave. Then either add a non-trimming variant to `pathCore.ts` with
the shape these callers need, or fix each call site's `..` handling
deliberately and route it through the shared helper. This is a decision
about traversal semantics, not a mechanical dedup, so it should not ride as
a drive-by fix.

**Not a candidate.** `packages/harness/src/shared/tools/executionsDisplay.ts`
does the same split, but it is reached from webview code and cannot import
`pathCore.ts`, which imports `node:path`.
