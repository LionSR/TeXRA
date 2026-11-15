Read on `main` at `cb22acd`. Covered: `packages/harness/src/shared/` (schemas, session row model, transcript row model, state, config, tools) and `packages/harness/src/transcript/`.

### HS-1: A call's edited files are written three times on its card and read by nobody

- **Package:** harness
- **Flags:** repetition (a fact with two owners); export with no consumer; a field constant across all producers
- **Evidence:**
  - `packages/harness/src/controllers/session/rowReader.ts:419-451` (`callCard`) builds one `FileListEntry[]` from the result's `edits` and puts it in three places on the projected `tool.end`: `result.output.editedFiles` (`:432`), `result.files` (`:438`) and the row's own `files` (`:450`). Every entry carries `source: 'tool'`, `sourceDisplay: 'Tool use'` (`:426-427`), constants.
  - `packages/harness/src/shared/schemas/traceEvent.ts:82` declares `files: Schema.optional(Schema.Array(FileListEntrySchema))` on `tool.end`. The only reader of a `tool.end`, `packages/harness/src/shared/session/transcriptUpdate.ts:207-235`, reads `event.result` and `event.status`; `event.files` is never read. `TraceEmitter.ts:178,210` (the other producer, agent-CLI cards) never writes it.
  - `editedFiles`: one occurrence in the repo's source (`rowReader.ts:432`); zero in `packages/*/src` readers, zero in tests. `files` reaches `ToolUseLog` only as an undeclared rest key (`shared/toolUse.ts:129-143`, "Fields outside ToolUseLogSchema (e.g. `toolUseDispatch.ts`'s `files`) are kept"; `toolUseDispatch.ts` writes no `files`) and no section builder in `shared/transcript/toolRowSections.ts` or `toolRowModel.ts` reads `log.files`: the file sections come from `output.edits` and the call's input.
  - `FileListEntrySchema.source` (`shared/schemas/log.ts:55`): three writers (`rowReader.ts:426`, `packages/texra/src/tools/documents/documentTask.ts:130`, `documentTools.ts:163`), no reader in `packages/*/src` (both hosts paint `sourceDisplay` only: `packages/texra/src/ui/progress/formatters/htmlBuilders.ts:215-218`, `packages/cli/src/chat/tui/render/transcriptRowLines.ts:80`).
- **Better design:** the card's result is the stored result; what a call edited is `result.edits`, its one owner. `callCard` returns `{ ...envelope, type: 'tool.end', logId, status, result }`.
- **Deleted:** `tool.end.files` (schema field), `editedFiles`, the `files` key inside `result`, `FileListEntrySchema.source` and its three writes, the false comment at `toolUse.ts:130`, the `logPayload.ts:32` "e.g. `files`" comment.
- **Size:** about 40 lines, 6 files.
- **Risk / owner decision:** `tool.end` is stored for agent-CLI children, but no producer of a stored `tool.end` writes `files`, so no row version changes. The note `.agents/docs/proposed/simplification/2026-11-14-tool-card-result-and-delivery-shapes.md` §1 (typed `result` on `tool.end`) does not list these fields; this is its first step and stands alone. Open PR #14949 (`claude/dazzling-cori-84lvx0`, commit `8cb7a10`, "a call's card states its edited files once") deletes `editedFiles` only (`rowReader.ts`, 1+/5-); `tool.end.files`, `result.files`, `FileListEntrySchema.source` and the two false comments remain on that branch, so the rest of this finding stands after it.

### HS-2: Three `log` payload cases have no producer: `scratchpad`, `toolUse`, and a text row's `status`

- **Package:** harness (readers in cli and texra)
- **Flags:** a union with a case nothing produces; special and general code mixed; a comment that is false
- **Evidence:**
  - `MESSAGE_TYPES.SCRATCHPAD` (`shared/schemas/log.ts:16`). Every writer of a `log` row's `messageType` or a stream's kind in `packages/*/src`: `ModelInvoker.ts:258-259` (`THINKING`, `MODEL_RESPONSE` streams), `traceLogs.ts:84,111,160,178`, `ModelInvoker.ts:739`, `agentCli/claudeAgent.ts:158,272,282`, `agentCli/codex.ts:117,120,124,218`, `documents/documentTools.ts:166,219`. None writes `scratchpad`; zero occurrences in `src/` and `packages/*/test`. It is still carried by `LOG_PAYLOAD_SCHEMAS` (`logPayload.ts:30`), `STREAMING_TEXT_ROW_KIND` (`session/transcriptLogRows.ts:25,84`), `StreamingTextRow.kind` (`transcript/transcriptRow.ts:80,288,323`), `LogRowPayload` (`projectTranscriptRow.ts:227`), `completedRunArchive.ts:110-113` (whose comment, "a derived view carved from the model response's raw text", describes code that no longer exists), the CLI (`transcriptRowLines.ts:98`, `transcriptEntryLayout.ts:77`, `transcriptEntries.ts:135`) and the progress view (`formatters/index.ts:55`, `bannerFormatters.ts:50-55`, two style rules).
  - A `log` row with `messageType: 'toolUse'`: no producer (cards are `tool.start` / `tool.end` or a call's rows). `LOG_PAYLOAD_SCHEMAS[TOOL_USE]` (`logPayload.ts:33-35`) and `transcriptLogRows.ts:93-95` decode and place a row nothing writes. The literal itself stays: it is the `messageType` of a tool row's base (`transcriptUpdate.ts:198`).
  - `StreamingTextDataSchema` (`logPayload.ts:16-21`, a `StructWithRest` with `status: 'running' | 'completed'`): no `log` producer passes `data` on a text row (`claudeAgent.ts:271-273`, `codex.ts:117,120`), so `running: payload.data?.status === 'running'` (`transcriptLogRows.ts:90`) is always `false`; live text is `stream.start` / `stream.end`.
- **Better design:** the log payload table lists what is written. A text `log` row is settled text (`running: false`), payload `Schema.Undefined` like `PROGRESS_STATUS`; `StreamingTextRow.kind` is `'assistant' | 'thinking'`.
- **Deleted:** `MESSAGE_TYPES.SCRATCHPAD` and its eleven reader cases across harness, cli and texra; `StreamingTextDataSchema`; the `TOOL_USE` entry of `LOG_PAYLOAD_SCHEMAS` and its `recordLogRow` case (`MessageTypeSchema` for a `log` row narrows to the types a log can carry).
- **Size:** about 90 lines, 14 files.
- **Risk / owner decision:** **owner decision**: `messageType` is a stored literal on `log` and `stream.start`; dropping `scratchpad` bumps `log` (v10) and `stream.start` (v1) so an earlier build's row reads as that build's. `MessageType` is exported from `@texra-ai/harness/schemas`.

### HS-3: A compaction's figures ride a second row the transcript hides, and three context-management actions have no producer

- **Package:** harness (one reader in texra)
- **Flags:** repetition (one fact over two rows, each decoded twice); non-obvious code (a positional join); a union with cases nothing produces; a field constant across all producers
- **Evidence:**
  - `ContextManagementAction` (`shared/schemas/contextManagement.ts:5-11`) lists five actions. The only writers of a `contextManagement` log row are `ModelInvoker.ts:406-420` (`max_tokens_reduced`) and `agent/runtime/run/compaction.ts:244-256` (`compaction`), both through `logContextManagementEvent` (`agent/trace/traceLogs.ts:172-179`). `clear_tool_uses`, `clear_thinking` and `truncation` occur in no producer in `packages/*/src`, tests or `src/`; they survive in the schema (`:7-9`, `:32-37`), `CONTEXT_MANAGEMENT_LABEL` and `TOKENS_FREED_ACTIONS` (`shared/transcript/projectTranscriptRow.ts:163-170`), the unreachable "Tokens freed" branch (`:295-304`), and three of the four `ACTION_PRESENTATION` entries (`packages/texra/src/ui/progress/formatters/logFormatters/contextManagementFormatters.ts:25-33`).
  - The `compaction` action is never shown as its own row: `logPayloadRow` returns `undefined` for it (`projectTranscriptRow.ts:278-280`, "a second row would repeat it"). Its figures reach the screen only because `applyFreed` (`shared/runs/compactionActivityProjection.ts:77-100`) re-decodes the row's payload with `ContextManagementDataSchema` (`:83`) and copies them onto "the latest running block" (`findLastIndex`, `:88`). That join is correct only because `compaction.ts:244-257` writes the figures row immediately before `summary.activity.finish('completed')`; nothing in the rows links the two. The activity row is decoded a second time too (`CompactionActivityDataSchema`, `:132`), after `recordLogRow` already decoded both through `decodeLogPayload` (`shared/session/transcriptLogRows.ts:66`), so the comment "decodes a row's `data` here exactly once" (`shared/schemas/logPayload.ts:24-25`) is false for these two types.
  - `CompactionActivityDataSchema.activity: Schema.Literal('context_compaction')` (`contextManagement.ts:56`): one writer (`traceLogs.ts:113`), one value, no reader branches on it (`grep context_compaction`: the schema and the writer).
  - With the compaction case gone, the one `ContextManagementRow` left is `max_tokens_reduced`, so `ContextManagementRow.data` (`shared/transcript/transcriptRow.ts:191`) is read only to pick that one action's icon (`contextManagementFormatters.ts:51`).
- **Better design:** a compaction is one lifecycle, so its figures are on its terminal activity row: `CompactionActivityData` for `state: 'completed'` carries `tokensBefore`, `tokensAfter`, `contextWindow` (the run's `finish('completed', freed)`), and the projection reads them off the payload the fold already decoded (`recordLogRow` hands it the decoded payload, or the projection is called from the decoded branch). `ContextManagementData` becomes the output-budget clamp alone (`max_tokens_reduced`), with no `action` field; the progress view's icon is a constant.
- **Deleted:** `compaction`, `clear_tool_uses`, `clear_thinking`, `truncation` and `TokensFreedDataSchema`; the `compaction` call to `logContextManagementEvent` and its `undefined` row case; `applyFreed` and both re-decodes in `compactionActivityProjection.ts`; `CONTEXT_MANAGEMENT_LABEL`, `TOKENS_FREED_ACTIONS` and the freed-tokens branch; `CompactionActivityData.activity`; `ContextManagementRow.data`; three `ACTION_PRESENTATION` entries; the optional `data?` of `logContextManagementEvent` (both callers pass it).
- **Size:** about 110 lines, 9 files.
- **Risk / owner decision:** **owner decision**: the `log` payloads are stored; the change bumps `log` (v10 to v11), so an earlier build's compaction reads as that build's. `ContextManagementData` and `CompactionActivityData` are exported from `@texra-ai/harness/schemas`. Take with HS-2 and HS-4, which bump the same kind.

### HS-4: Two derived numbers are stored on rows, and one of them is derived by two rules

- **Package:** harness (one reader in texra)
- **Flags:** repetition (a rule with two owners); a stored field derivable from the fields beside it
- **Evidence:**
  - `TokenUsageStats.cacheMissInputTokens` (`shared/schemas/usage.ts:42-43`) is "input minus cache reads". Its one writer is `pricing.ts:47-49` (`agent/runtime/run/pricing.ts`), which writes it only when `cached !== null && inputTokens >= cached`; the usage log derives the same number by another rule, clamping to zero (`pricing.ts:89-90`, `Math.max(0, inputTokens - cachedInputTokens)`). Its one reader is the progress view's usage strip (`packages/texra/src/ui/progress/components/UsagePanel.ts:49-55`). `sumUsageStats` (`usage.ts:94-111`) sums it, so a run whose turns mix a provider that reports cache reads and one that does not shows a cache-miss total below its input total, where `inputTokens - cachedInputTokens` over the summed fields would not. The field rides every stored priced usage (`model.message`, `context.edit`, `tool.result`, `run.description`, `run.end`, `followup.queued`; `runHistoryEvent.ts:147,190,297`, `sessionEvent.ts:273`, `runRecords.ts:115`, `followUp.ts:99`).
  - `ContextManagementData.utilizationBefore` / `utilizationAfter` (`contextManagement.ts:18,39`) are written by both producers as `roundedUtilizationPercent(tokens, contextWindow)` from the `tokensBefore`, `tokensAfter` and `contextWindow` on the same payload (`ModelInvoker.ts:413-416`, `compaction.ts:252-253`). The sibling fact already follows the other design: `context.state` stores `inputTokens` and `contextWindow` only (`traceEvent.ts:93-96`), and the session view derives its percent at read (`shared/session/sessionViewUpdate.ts:719`).
- **Better design:** store the counts, derive the ratio and the difference where they are shown: `roundedUtilizationPercent` in `logPayloadRow` and in the compaction label (`transcriptRow.ts:355-360`), the cache-miss count in the usage strip (one line over `TokenUsageStats`), and the usage log keeps its own wire derivation as the one owner of the clamped rule.
- **Deleted:** `cacheMissInputTokens` (schema field, its `emptyUsageStats` zero, its writer); `utilizationBefore` and `utilizationAfter` (schema fields, four producer lines).
- **Size:** about 30 lines, 7 files.
- **Risk / owner decision:** **owner decision**: both are stored. `cacheMissInputTokens` is optional, so an earlier row still decodes and reads the same (Structs ignore the extra key) and no version needs a bump; the utilization fields are required, so dropping them is part of HS-3's `log` bump. `TokenUsageStats` is exported from `@texra-ai/harness/schemas`.

### HS-5: `stream.start.kind` admits every message type; two are written, and the fold carries a branch for the rest

- **Package:** harness
- **Flags:** a union with cases nothing produces; special and general code mixed
- **Evidence:**
  - `stream.start` declares `kind: MessageTypeSchema` (`shared/schemas/traceEvent.ts:97-100`), all twelve message types, and `AgentTrace.openRun(kind: MessageType)` (`agent/trace/AgentTrace.ts:97`, `TraceEmitter.ts:157`) takes any. Its only callers open `THINKING` and `MODEL_RESPONSE` (`agent/runtime/ModelInvoker.ts:258-259`); no plugin or app code calls `openRun` (`grep openRun( packages/*/src`).
  - Because the kind is wide, the fold maps it through a `Partial` table (`STREAMING_TEXT_ROW_KIND`, `shared/session/transcriptLogRows.ts:20-26`) and its text slot carries `rowKind: StreamingTextRow['kind'] | undefined` ("Undefined for a stream of a kind with no streaming row", `shared/session/transcriptState.ts:57-58`), which `takesLiveText` (`:290`) and `slotRow` (`:303-315`, painted as a plain log row) each branch on. No producer reaches that branch.
  - HS-2 removes `scratchpad`, the third entry of the same table.
- **Better design:** `stream.start.kind` is `Schema.Literals(['modelResponse', 'thinking'])` and `openRun` takes that type; the slot's `rowKind` is `'assistant' | 'thinking'`, always present, and `STREAMING_TEXT_ROW_KIND` is a total two-entry record.
- **Deleted:** the `undefined` case of `rowKind` and its two branches (`takesLiveText`, `slotRow`'s `plainLogRow` fallback); the `Partial` on `STREAMING_TEXT_ROW_KIND`.
- **Size:** about 25 lines, 6 files.
- **Risk / owner decision:** **owner decision**: `stream.start` is stored (v1 to v2 with HS-2) and `AgentTrace` is exported from `@texra-ai/harness/plugins` (`plugins.ts:209-213`), so `openRun`'s parameter narrows on the plugin surface.

### HS-6: The trace read's result is a TypeScript type in the harness, so the app writes its document and its two statuses as schemas twice

- **Package:** harness, texra
- **Flags:** repetition (one fact with three owners); information leakage
- **Evidence:**
  - `AssembleTraceResult` (`packages/harness/src/transcript/traceAssembler.ts:64-70`) is a plain type, exported from `@texra-ai/harness/host` (`host.ts:31`). The service protocol needs a codec for it, so `packages/texra/src/controllers/server/protocol.ts:197-210` writes one by hand: the `ok` branch re-declares the document's two fields (`runId: RunIdSchema, events: Schema.Array(DisplayRowSchema)`, commented "A `TraceDocument`") although `TraceDocumentSchema` is exported from `@texra-ai/harness/schemas` (`schemas.ts:196`), and the other branch restates `Schema.Literals(['config_missing', 'streamLogs_missing'])`.
  - `TraceUnavailable` (`packages/texra/src/agent/export/standaloneTraceHtml.ts:24-26`) restates the same two literals a third time. A status added in `traceAssembler.ts` compiles in neither app schema until both are edited by hand.
- **Better design:** the harness declares the result once as a schema beside `assembleTrace` (`TraceDocumentSchema` for the document, `RunRecordFieldsSchema` for the record, one `Literals` for the two statuses), exports it where `AssembleTraceResult` is exported now, and derives the type from it; `protocol.ts` names that schema and `TraceUnavailable` takes `status` from it.
- **Deleted:** the hand-written `readTrace` union in `protocol.ts` (14 lines), the literal list in `TraceUnavailable`, and the hand-written `AssembleTraceResult` type.
- **Size:** about 25 lines, 4 files.
- **Risk / owner decision:** none in behavior; the published `AssembleTraceResult` type keeps its shape, and one schema is added beside it on the `host` entry.

### HS-7: `isSettledRow` states "settled on arrival" twice, in a set and again in its switch

- **Package:** harness
- **Flags:** repetition (a rule with two owners); non-obvious code; a single-caller extraction; a comment that is false
- **Evidence:** `shared/transcript/transcriptRow.ts:239-245` lists five kinds in `IMMEDIATELY_SETTLED_ROW_KINDS`; `isSelfSettledRow` (`:256-263`) returns true for them, and returns `row.block.finalized` for `compactionActivity`. `isSettledRow` (`:279-308`) calls it first and then switches over every kind: the five kinds' `return true` (`:298-302`) and the `compactionActivity` case (`:295-296`) are unreachable restatements, while `webSearch` and `log`, equally settled on arrival, are in the switch only. `isSelfSettledRow` has one caller (`:283`; not exported), and the comment that its containment "is load-bearing — the promotion loop relies on it to treat both halves as one predicate" (`:269-273`) describes no caller: the promotion loop calls `isSettledRow` alone (`shared/session/sessionViewUpdate.ts:573,596`).
- **Better design:** one function: `settlementSeqNo !== undefined || origin === 'local'` is settled, then one exhaustive switch that says, per kind, what settles it.
- **Deleted:** `IMMEDIATELY_SETTLED_ROW_KINDS`, `isSelfSettledRow`, the duplicated `compactionActivity` test and the containment paragraph.
- **Size:** about 25 lines, 1 file.
- **Risk / owner decision:** none.

### HS-8: Comments in the slice describe fields and steps the code does not have

- **Package:** harness
- **Flags:** a comment that is false
- **Evidence:** none of these is in LC-1a, lens-2's interface-comment table or round 5's comment list.
  1. `transcript/traceDocumentSchema.ts:19-21`: an exported document "authors four facts ...: no owner, no parent, no checkpoint and no follow-ups taken". `run.start` has no owner or checkpoint field (`shared/schemas/sessionEvent.ts:189-201`); `assembleTrace` sets `parent: null, takesFollowUps: false` and nothing else (`traceAssembler.ts:97-98`).
  2. `transcript/traceAssembler.ts:5-8`: "Three facts are authored ...: no parent, no checkpoint and no follow-up support". Same two facts.
  3. `shared/schemas/sessionEvent.ts:180-182`: "`category` and `takesFollowUps` are explicit on every run". No `category` exists; the run's kind is `identity` (`runIdentity.ts:12-30`).
  4. `shared/schemas/traceEvent.ts:105-110`: a first doc block on `response.finalized` ("decided once at the flow boundary", "Fires at every mid-run turn boundary") sits above a second one (`:111-112`); only the second attaches, and the run has no flow boundary (the row is `finalizedRows`, `agent/runtime/loop/rows.ts:38-54`, appended once per answer, `runLoop.ts:127-128`).
  5. `shared/session/sessionViewAccess.ts:1-4`: "its tag is `SessionViewAccess` (`sessionInputs.ts`)". The tag is in `shared/session/runHistory.ts:310`.
  6. `shared/schemas/logPayload.ts:24-25` ("decodes ... exactly once") and `transcript/completedRunArchive.ts:110-112` (scratchpad "carved from the model response's raw text"): HS-3 and HS-2 delete the code that makes them false; listed for the count.
- **Better design:** each comment states what the code does: two authored facts and one redaction; the run's `identity`; one doc block on `response.finalized`; the tag's file.
- **Deleted:** the orphaned `response.finalized` doc block; four false clauses.
- **Size:** about 15 lines, 5 files.
- **Risk / owner decision:** none. Item 1 is on the published `TraceDocumentSchema` doc, so `npm run docgen` regenerates `packages/harness/docs/api/schemas.md`.

## Good modules here

- `shared/schemas/rowVersions.ts`: the version history of every row kind as data beside the kind, a `Record` over `SessionRowDraft['type']` so a new kind does not compile without its version and listing class, and the retired kinds named with what their rows fed. One reader (`rowCodec.ts`).
- `shared/transcript/projectTranscriptRow.ts` `logPayloadRow`: every message type either builds a row or is decided against in one exhaustive switch; an unknown persisted type throws naming the payload.
- `shared/session/transcriptReads.ts` `applyLiveText`: a chunk carries its own offsets, so redelivery in any order is a no-op and durable text wins by construction, with no sequence bookkeeping.
- `shared/schemas/sessionViewInput.ts` `replayInputs`: one function states the cold-read order that both the live reader and an exported trace answer a subscribe with.
- `shared/deliveryTags.ts`: one owned tag pattern from which every recognizer in `subagentFollowup.ts` is derived.
- `transcript/traceDocumentSchema.ts` `readTraceFacts`: an imported trace checks plugin facts exactly as the store does and refuses a retired kind loudly instead of reading it.

## Considered and left alone

- `ToolUseLog`'s nested fallback, `normalizeToolUse`'s `firstTrimmed`, `completedRunArchive.ts`'s re-decode of `tool.output` and `scriptStage.ts`'s `statusOf`: `.agents/docs/proposed/simplification/2026-11-14-tool-card-result-and-delivery-shapes.md` §1. `ToolRow` carrying `log`, `toolUse` and `model`: PR #14949's note `2026-11-15-data-shapes-left-after-the-audit.md` §6.
- `subagentFollowup.ts`'s envelope parsing and `ChildRunDelivery`: the same tool-card note §3.
- `SubagentProgressUpdate` (`overview.cost` is written at `runLoop.ts:483` and never read by `describeSubagentProgress`): HA-4 deletes the type.
- `TakenFollowUp`: LS-1a. `decodeXmlEntities`, `LocalRuntimeStateSchema`, `SessionViewUpdater` (exported for tests): round 5, `2-code-for-tests.md`.
- Entry-only exports (`LogicalId`, `AggregateKind`, `TraceFactKind`, `UsedUpPlan`, `StreamChunkEvent`, …): published surface, the #14956 lane.
- `RETIRED_ROW_KINDS`, `RETIRED_PLUGIN_FACTS`: storage policy P2 (`.agents/docs/proposed/architecture/2026-11-03-session-store-review.md`); they refuse old rows loudly, not a compatibility reader.
- `ErrorLogDataSchema`'s `onExcessProperty: 'error'` (`logPayload.ts:62-67`): the row version already refuses an earlier build's stored error row, but an imported `trace.json` carries no versions, and this is its only guard.
- `isEditLikeToolName`'s `str_replace` / `text_editor` substrings (`shared/tools/toolKind.ts:58-66`): the names come from external agents (Claude Code), so their absence cannot be shown from this tree.
- `stageId` on every `durable()` arm (`sessionEvent.ts:104`): `tool.intent` and `tool.result` carry it (`toolUseDispatch.ts:281,430`), so the envelope field has writers beyond the trace arms.
- `TRACE_ROW_TYPES` beside `TraceRowFieldsSchema`: they differ by `response.finalized` on purpose (the loop writes it, no trace emits it), and `runTrace.ts:199` reads the list at runtime.
- `RunView.title` and `modelLabel` (derivable from `description`/`label` and `model`): the view is documented as precomputed for every host and is not stored.
- `MODEL_AVAILABILITY_STATUS`: round 3, `P-settings-model.md`. `SessionView.policy`, `RunView.turnStartedAt`, `RunRows.parent`, `AgentConfig`'s union: PR #14949's note §1, §2, §7.
- `opResults.ts`'s unexported `ExecResultSchema` (a schema used only for its type): lens-2 covers its comments; too small to stand alone.

## Summary

| Id   | Title                                                                                                  | Package          | Flags                                                                                       | Size                  | Owner decision?                                   |
| ---- | ------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| HS-1 | A call's edited files are written three times on its card and read by nobody                           | harness          | repetition; export with no consumer; constant field                                          | ~40 lines, 6 files    | no (PR #14949 drops `editedFiles` only)           |
| HS-2 | Three `log` payload cases have no producer: `scratchpad`, `toolUse`, a text row's `status`             | harness, cli, texra | union case nothing produces; special and general mixed; false comment                     | ~90 lines, 14 files   | yes (`log` v10, `stream.start` v1; schemas export) |
| HS-3 | A compaction's figures ride a second row the transcript hides; three context actions have no producer  | harness, texra   | repetition; non-obvious code; union cases nothing produces; constant field                   | ~110 lines, 9 files   | yes (`log` bump; schemas exports)                 |
| HS-4 | Two derived numbers are stored on rows, and the cache-miss count is derived by two rules                | harness, texra   | repetition; stored derivable field                                                           | ~30 lines, 7 files    | yes (stored fields; with HS-3's bump)             |
| HS-5 | `stream.start.kind` admits every message type; two are written, and the fold branches for the rest     | harness          | union cases nothing produces; special and general mixed                                      | ~25 lines, 6 files    | yes (`stream.start` bump; `AgentTrace.openRun` on plugins entry) |
| HS-6 | The trace read's result is a TS type, so the app writes its document and statuses as schemas twice     | harness, texra   | repetition; information leakage                                                              | ~25 lines, 4 files    | no                                                |
| HS-7 | `isSettledRow` states "settled on arrival" twice, in a set and in its switch                           | harness          | repetition; non-obvious code; single-caller extraction; false comment                        | ~25 lines, 1 file     | no                                                |
| HS-8 | Comments describe fields and steps the code does not have                                               | harness          | false comment                                                                                | ~15 lines, 5 files    | no                                                |
