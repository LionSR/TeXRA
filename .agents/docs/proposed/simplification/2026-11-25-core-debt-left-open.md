# Code debt in the harness and llm: what the 2026-11-25 sweep left

Date: 2026-11-25
Status: proposed

Origin: the scheduled code-debt sweep over `packages/harness/src` and
`packages/llm/src`, for debt markers, lint and diagnostic exemptions,
unexplained casts, silent degradation, untagged errors, false or restating
comments and dead code. Files of the open PRs that delete the document
pipeline, task programs and the agent CLI plugins were left alone.

## The mechanical markers are a verified negative

No `TODO`, `FIXME`, `HACK` or `XXX` remains in either package, and every
"legacy", "compat" and "deprecated" left names an outside format (JSON
Schema's tuple `items`, Claude Code's hook decisions, OpenAI-compatible
endpoints). Every cast carries a `// cast:` reason, the one `as unknown as`
(undici's `fetch` under the DOM typings) included. `oxlint
--report-unused-disable-directives` reports nothing; the three Effect
diagnostic exemptions in `packages/llm/src/api/transport.ts` and
`packages/llm/src/errors.ts` still hold (a raw rejection compared by
identity, and a constructor that fills defaults on decode too). Every
`new Error` left is a defect (`Effect.die`, an invariant `throw`) or the
`cause` of a tagged error; no thunk-form `Effect.try` or pass-through
`catch` remains outside the one `rejoin` the exemption covers. A
word-boundary scan of every export found no symbol without a consumer.

## Open

1. **Unused imports that lint cannot see.** The `no-unused-vars` rule in
   `oxlint.config.mts` ignores any variable matching `Schema$`, which also
   hides an unused import of a schema. `tsc --noUnusedLocals` over the root
   project found three in this area (removed here) and one in
   `packages/harness/src/shared/schemas/logPayload.ts`, a file an open PR
   holds. The same pass over the app and the hosts was not run. Narrowing
   the pattern to declarations (not imports) needs a lint option oxlint may
   not have; the alternative is a `noUnusedLocals` check in the typecheck.
2. **`SessionLog.history`'s `types`**
   (`packages/harness/src/shared/session/sessionLog.ts`). Only one test
   passes it (`packages/harness/test/agent/followUp/ToolUseFollowUp.vitest.ts`,
   to read every `followup.queued` row). Dropping it needs that test to read
   the rows another way: the session context holds no `Database`, and the
   `input` read of `RUN_ROW_READS` folds consumed messages away.
3. **`ToolError`s that drop their cause.** `subagentRun.ts`'s schema check,
   the executions tool's unreadable file, `glob.ts`'s pattern errors,
   `WebFetchTool.ts`'s Markdown conversion and `toFetchToolError`
   (`packages/harness/src/tools/timeouts.ts`) build a `ToolError` from a
   caught error's message without its `cause`. Passing the cause is not
   behavior-preserving: the tool boundary renders `toErrorMessage(error)`,
   which walks the cause chain, so a cause whose message the wrapper quotes
   without its final stop would be printed twice to the model.

4. **TSDoc on the `./plugins` surface**, left because its generated
   reference (`packages/harness/docs/api/plugins.md`) is held by an open
   PR: `pathToLocationIn`'s @param/@returns restate its signature
   (`packages/harness/src/common/storage/fileLocation.ts`), so do
   `renderPrompt`'s (`packages/harness/src/agent/prompt/promptRender.ts`),
   and `JsonRpcConnectionOptions.onRequest` names a `MethodNotFound` the
   code never spells (it answers `-32601`). Take them with `npm run
   docgen` once that PR merges.

5. **`RunFailure.cause` is required** (`packages/harness/src/effect/errors.ts`),
   so `runView`'s `failure` (`packages/harness/src/effect/runHandle.ts`) and
   the service session's `runFailure`
   (`packages/texra/src/controllers/server/serviceSession.ts`) mint
   `new Error(message)` to fill it. The tagged-error shape in root
   `AGENTS.md` makes it `Schema.optional(Schema.Defect())`. `RunFailure` is
   on the `.` entry, so the change regenerates
   `packages/harness/docs/api/index.md`, which the same open PR holds; take
   it with item 4.

## Checked and declined

- **`requireFileReadForEdit`'s `errorMessage`** and **`holdServer`'s
  `load`**: an AST count of direct calls saw neither passed, but `load` is
  passed through `ProjectServers` (`sessionTools.ts`), and a call through
  an aliased import is invisible to that count (`wireFail` is imported as
  `fail` in three files, which pass its `kind`).
- **`cpuBudgetMs` on a code-sandbox request**: only a test passes it, to
  reach the CPU budget in milliseconds; it is the test's handle on a
  budget it could not otherwise reach.
- **Single-caller lookups** (`harnessToolOfClaudeTool`,
  `isRunningSnapshotEvent`, `isInstalledPluginId`): each keeps its table
  private to its module, which its comment says is the point.
- **`ChildNotKilled`** (`packages/harness/src/platform/defaults/nodeServices.ts`):
  raised and caught in one pipe, but the catch logs the message the tagged
  error carries, so the error is the log's input, not a detour.
