# Native-method and duplicate-helper scan

Date: 2026-10-30
Status: proposed
Origin: scheduled scan of `packages/*/src` for hand-rolled code that a builtin
covers and for helpers defined twice.

## Clean

No `.substr(`, `JSON.parse(JSON.stringify(`-style deep clones outside
`shared/schemas/jsonValue.ts` (which needs the JSON round trip), hand-written
sleeps, `|| false`, or `new Promise` outside the allowed sites. Functions that
share a name across files are overloads, not copies.

## Candidates (small, none urgent)

1. `envVar` is defined identically in
   `packages/harness/src/utils/system/envFlags.ts` and
   `packages/llm/src/providers/credentials.ts` (private). The harness already
   depends on `@texra-ai/llm`, so one definition could serve both, at the cost
   of widening the llm public surface by one export. Gain: 6 lines. Decide
   whether the export is worth it before doing it.
2. `rank = (effort) => EFFORT_SCALE.indexOf(effort)` is duplicated in
   `packages/llm/src/models/reasoningChoice.ts` and
   `packages/texra/src/tools/codexConfig.ts`. Same trade-off: one line saved
   for a new llm export.
3. `isAbsent` (NotFound platform error) exists in
   `packages/harness/src/utils/files/runStorage.ts` and
   `packages/desktop/src/main/desktopWorkspaceIpc.ts`; the repo already has
   `isFileNotFoundError` in `@common/errors/errorPredicates`. Check whether
   either call site can use it, which would delete both local copies.

Candidate 3 has the best ratio; 1 and 2 are not worth a new export alone.
