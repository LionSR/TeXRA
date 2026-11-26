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
   hides an unused import of a schema. Partly landed (2026-11-25 evening):
   `tsc --noUnusedLocals` over every project (root, test kernel, each
   package's configs, the harness example; between them every tracked
   TypeScript file but the Deno `supabase/functions/` tree) found one more
   unused import, in
   `src/test-kernel/controllers/session/sessionEvents.vitest.ts`, removed.
   What is left: the import in
   `packages/harness/src/shared/schemas/logPayload.ts`, a file an open PR
   holds, and the check itself. The pattern needs no narrowing: it can go.
   With `varsIgnorePattern: '^_'` (no `|Schema$`) `npm run lint` reports
   that held import and nothing else, since a schema read only in types
   counts as used (`reportVarsOnlyUsedAsTypes` is off). Take both lines
   when `oxlint.config.mts` and `logPayload.ts` leave the open PR.
2. **`SessionLog.history`'s `types`**: landed (2026-11-25 evening). Six
   test reads passed it, not one (four in `ToolUseProgressEvents.vitest.ts`
   and one in `AgentLaunchContext.vitest.ts` beside `ToolUseFollowUp`'s).
   Each now filters what it reads: `context.edit` and `response.finalized`
   from `history`, which reads the run-state kinds, and `followup.queued`
   and `approval.policy` from the run's display rows (`SessionLog.display`).

3. **TSDoc on the `./plugins` surface**, left because its generated
   reference (`packages/harness/docs/api/plugins.md`) is held by an open
   PR: `pathToLocationIn`'s @param/@returns restate its signature
   (`packages/harness/src/common/storage/fileLocation.ts`), so do
   `renderPrompt`'s (`packages/harness/src/agent/prompt/promptRender.ts`),
   and `JsonRpcConnectionOptions.onRequest` names a `MethodNotFound` the
   code never spells (it answers `-32601`). Take them with `npm run
   docgen` once that PR merges.

4. **`RunFailure.cause` is required** (`packages/harness/src/effect/errors.ts`),
   so `runView`'s `failure` (`packages/harness/src/effect/runHandle.ts`) and
   the service session's `runFailure`
   (`packages/texra/src/controllers/server/serviceSession.ts`) mint
   `new Error(message)` to fill it. The tagged-error shape in root
   `AGENTS.md` makes it `Schema.optional(Schema.Defect())`. `RunFailure` is
   on the `.` entry, so the change regenerates
   `packages/harness/docs/api/index.md`, which the same open PR holds; take
   it with item 3. Both still wait (2026-11-25 evening): the open PR holds
   `packages/harness/docs/api/index.md` and `plugins.md`.

## Checked and declined

- **`ToolError`s that drop their cause** (2026-11-25 evening: `subagentRun.ts`'s
  schema check, the executions tool's refused query, `glob.ts`'s pattern
  errors, `WebFetchTool.ts`'s Markdown conversion, `toFetchToolError`). A
  `ToolError`'s `cause` has one reader, the tool boundary's
  `toErrorMessage` (`packages/harness/src/tools/core/definition.ts`): no
  code catches a `ToolError` by tag and none logs one. Each site already
  quotes the cause's whole message, so a cause with no chain of its own
  would be dropped by `toErrorMessage` as embedded and add nothing, and
  one with a chain whose parts end in a stop would print them twice.
  `toFetchToolError`'s status and timeout messages leave the error out on
  purpose. No site gains a reader; the messages stay as they are.

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
