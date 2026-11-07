# Nonobvious code (ch. 18): correctness that rests on what the reader cannot see

Lens: Ousterhout, _A Philosophy of Software Design_, ch. 18, "Code should be
obvious". This covers correctness that depends on an ordering, a timing or a
fact stated somewhere else; event-driven indirection; generic containers
where a named type would say what each part is; mutation of an argument;
comments whose reason lives in the issue tracker; and `as` casts that hide
a missing check.

Read at main `03c2f51d5d` (the branch head moved to `9c54678b22` during
the audit, which changes two docs files only, so the source is the same).
Scope: `packages/*/src`. Read-only. Consumer counts are over
`packages/*/src` unless a test path is named. Every finding was grepped
against the three evidence folders, the round-2 order note, the round-3
plan, the root-designs note and `refuted-candidates.json`. Open PRs that
touch a cited file are named where the citation appears.

Two of the findings are wrong now (unknown unknowns): finding 1, where 318
of the 2,535 default text rules can never produce their output, and
finding 5, where a run behaves differently live and after a resume. The
others raise cognitive load: a reader has to hold a fact from another file
in mind to change the code safely.

---

## Numbers

| Lens primitive                                                                                                   | Count                                                                                                                                                                                | Where it matters                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `as` assertions (AST count, excluding `as const`)                                                                | 64 in 1,342 files: harness 35 (395 files), texra 19 (469), cli 3, extension 3, llm 3, desktop 1, trace-viewer 0. 2 are `as unknown as` double casts                                  | **62 of 64 carry a `// cast:` reason.** The two without one are `controllers/settingsView/sharedSettingsCommands.ts:165` and `controllers/session/hostSnapshotSource.ts:238`, both in `packages/texra/src`. Worst: the caller-named body cast in `tools/github/githubClient.ts:186-188` (finding 6). The `as T` casts in `shared/config/settings.ts:277-392` and `platform/defaults/jsonConfigProvider.ts:99` are round 3's P3 |
| `queueMicrotask` / `setImmediate`                                                                                | 6 / 2                                                                                                                                                                                | 5 are already found (K, N, J). The rest are framework edges (Dockview `workbenchController.ts:483`, the Web Awesome `spinner.ts:50`, the extension host's rethrow `unhandledRejectionSurface.ts:77`)                                                                                                                                                                                                                           |
| Fixed sleeps standing in for an event                                                                            | 4                                                                                                                                                                                    | `openBuild.ts:302,324` (5 s each), `diffView.ts:35` (300 ms), `latexCommands.ts:100` (T found it). Finding 7                                                                                                                                                                                                                                                                                                                   |
| Comment lines that state an ordering ("before any", "must … before", "relies on", "order matters")               | 98                                                                                                                                                                                   | Most describe a refusal's order in the same function, which is fine. The ones that state a fact the code depends on: findings 1, 3 and 5                                                                                                                                                                                                                                                                                       |
| Comment lines that lean on a guarantee made elsewhere ("guarantees", "by the time", "only because", "built per") | 91                                                                                                                                                                                   | `llm/src/api/googleInteractions.ts:122` and `anthropicMessages.ts:187` (finding 3), `harness/src/tools/structuredOutput.ts:199` (finding 5)                                                                                                                                                                                                                                                                                    |
| Composite string keys built by template at each site                                                             | `${plugin}/${kind}` 14 sites in 11 files across 2 packages; `${responseId}/${callId}` 4 in 3; `${scriptCallId}/${seq}` 3 in 2                                                        | Finding 4                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Positional tuples crossing a module boundary                                                                     | `HistoryWrite` (13 constructions, two files and a child process); `jsonRpc.cancel`'s `[method, params]` (1 implementer); labelled `[kind, logicalId]` in `rowCodec.ts:99,108` (fine) | Finding 2                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Writes to a parameter (AST: property assign, `.push/.set/.add/.delete/.sort`, `Object.assign`, `delete`)         | 112                                                                                                                                                                                  | Nearly all are deliberate: the view update's copy-on-write drafts (harness `shared/session`, 25), DOM and VS Code objects (extension, 15), and file-local accumulators. Across a module boundary: `lowerMessages`'s `callIds` (finding 3), `HistoryQuery`'s `CallPositions` (finding 2), `countLaunch`'s shared counter (batch), `submitAndObserve`'s `completed` box (D found it)                                             |
| `Record<string, unknown>`                                                                                        | 65                                                                                                                                                                                   | Mostly real boundaries (YAML scan, JSON stores, SQL rows, log data). Worth naming: `RunView.facts` (finding 4), `TemplateVars` (batch)                                                                                                                                                                                                                                                                                         |
| Event emitters                                                                                                   | 1 `vscode.EventEmitter` (`fileDecorations.ts:12`); 31 `.emit(` sites                                                                                                                 | Each is typed: a `RuntimePresentationEvent` key, an `AppSignal` key, or an `AgentEvent` value. The handlers are exhaustive `Record` tables. Few instances (see "Good modules")                                                                                                                                                                                                                                                 |
| `yield* Effect.context<…>()`                                                                                     | 8                                                                                                                                                                                    | 3 go through `Context.pick`. `sessionOwners.ts:207,230` is noted (pr1-compromises §3). `processLayer.ts:225` is the composition root. Two are not covered: batch item 1                                                                                                                                                                                                                                                        |
| Comments citing an issue or PR number                                                                            | 42                                                                                                                                                                                   | About 6 put the number where the reason should be (batch item 4). "used to / previously / Bug fix:" narration: 22                                                                                                                                                                                                                                                                                                              |

---

## Finding 1. The text replacement rules run in object-key order, and 318 of the 2,535 default rules can never produce their output

**Red flags:** correctness that depends on a distant fact (the key order of
object literals across two files and thirteen categories); a generic
container (`Record<string, string>`) whose iteration order is the
behaviour; comments substituting for design; a false comment.

**Evidence.**

- A rule set is `patterns: Record<string, string>`
  (`packages/texra/src/replacement/types.ts:22`). The engine merges every
  enabled category into one object with
  `Object.assign({}, ...enabled.map((rules) => rules.patterns), customReplacements)`
  (`engine.ts:235-241`). It then runs `result.replaceAll(old, newText)` over
  `Object.entries` in that order (`engine.ts:343-344`). Each rule rewrites
  the whole text before the next one runs.
- The ordering is a contract that lives only in comments, in seven places:
  - `maxRules.ts:95-96`: "Keep longer commands before any command prefixes
    because replacements run sequentially";
  - `maxRules.ts:195-197`, `:240-243` ("applyReplacements walks the merged
    pattern object in insertion order") and `:248-250`;
  - `rules.ts:597`: "order matters: longer patterns first";
  - `rulesRegex.ts:326-329`: "preserving the previous insertion order of
    this map (the engine iterates Object.entries)";
  - `engine.ts:183-185`: "Application order is this declaration's key
    order, which is behavior".
- **The contract is already broken, in the same object as its own
  comment.**
  - `LATEX_SPACING_REPLACEMENTS` puts `' \\; '`, `' \\;'` and `'\\;'` (each
    becomes a space) at `rules.ts:598-601`, and the operator rules
    `'\\;+\\;': '+'` … `'\\;=\\;': '='` at `rules.ts:625-629`. By the time
    the operator rules run, `\;` is already gone: `\;+\;` comes out as
    `" + "`, not `+`.
  - In `max_style`, `{d${variable}}` (`maxRules.ts:228`) runs before
    `\frac{d}{d${variable}}` (`:232`). So `\frac{d}{dx}` becomes
    `\frac{d}{\dd x}`, and the third rule's `\frac{\dd}` part never applies.
    The comment above it ("Handle cases like \frac{d}{dx}") describes a rule
    that never fires.
- **Measured.** I transpiled the rule modules into a scratch directory and
  ran the engine's own loop. For each rule, I compared what the full ordered
  pass makes of the rule's input with what it makes of the rule's intended
  output.

  | Rules                                                                                | Passes                                               | As declared  | Sorted longest key first                             |
  | ------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------ | ---------------------------------------------------- |
  | The default categories (`DEFAULT_ENABLED_REPLACEMENTS`), 2,535 rules after the merge | two (`applyAll`)                                     | 318 defeated | **0**                                                |
  | The same                                                                             | one (`applyFor('xml-content')`, `engine.ts:150-163`) | 345          | 10                                                   |
  | `max_style` alone (1,286 rules)                                                      | two                                                  | 48           | **0**                                                |
  | `max_style` alone                                                                    | one                                                  | 184          | 138: chained rules need the second pass in any order |

  The categories hold 3,860 keys. 134 of them appear in more than one
  category.

- **The merge also moves overrides silently.** When a key is assigned again,
  `Object.assign` keeps the key's first position. A later category's
  duplicate, or a user's `latex.customReplacements` entry
  (`texraSettings.ts:203-208`) for an existing key, wins on value but runs
  at the earlier key's position. So it runs before rules the user expects
  it to follow. The docstrings "a category applied later wins"
  (`engine.ts:185`) and "Custom replacements … take precedence"
  (`engine.ts:222-224`) are each half true. A custom key that looks like an
  integer (`"2"`) enumerates before every built-in rule.
- Consumers: `replacementEngine` is used by 4 production files
  (`latex/latexdiff.ts`, `agent/output/XmlOutputManager.ts`,
  `tools/registry.ts`, `tools/documents/documentTools.ts`) and by
  `src/test-kernel/replacement/ReplacementRules.vitest.ts`.
  `XmlOutputManager.ts` and `documentTools.ts` are in #14796, but this
  finding changes none of their lines.

**The design decision behind it.** "Which rule wins when one rule's text
contains another's?" is decided by where an author typed the key, in one of
thirteen object literals in two files, merged by a function in a third. No
module owns the decision.

**The better design.** The engine decides: longest key first. Every
ordering comment states this rule, and the measurement shows it is the rule
that makes every default rule reachable.

- In `getAllReplacements`, sort the merged entries once by key length,
  descending, keeping declaration order on ties:
  `Object.entries(merged).toSorted(([a], [b]) => b.length - a.length)`.
  The result is a named ordered type: `NonRegexRuleSet.patterns` becomes
  `readonly { from: string; to: string }[]`, built once per config read, so
  no reader can mistake a `Record` for an ordered list.
- Overrides become value-only: precedence is the merge, and position no
  longer depends on it.
- Delete the seven ordering comments. Add one sentence on the type: "Rules
  run longest `from` first; two passes chain a rule's output into another."
- Pure computation, so plain TypeScript (AGENTS.md "Effect-native").

**Design it twice.**

- (A) One regex alternation sorted by length, with a lookup table: one scan
  per pass instead of 2,535 `replaceAll` scans. But no rule could act on
  another's output within a pass, which `max_style`'s chained differentials
  need (the 138 above).
- (B) The sorted sequence: every rule's chaining stays, at no extra cost.

B is chosen. A remains a later performance step, since the engine runs on
the streaming path "several times per model response" (`engine.ts:271-275`).

**What we give up.** Output changes for text that hits the 318 defeated
rules. That is the intended output, but it is still a visible change, and
`ReplacementRules.vitest.ts` may pin some of today's results. An author can
no longer force a shorter key to run first. No comment asks for that today.

**Change amplification.** "Add a rule whose key contains an existing key":
today the author must find every earlier key inside it across 13 categories
and 2 files and move the object literal. The measurement shows authors miss
some. After: add the rule anywhere.

**Depends on:** none. Owner: C (the round-2 LaTeX and documents area),
beside R3-T.

---

## Finding 2. `HistoryWrite` is a positional list bound to `?` placeholders in another file, across a process boundary

**Red flags:** a generic container where a named type would say what each
part is; correctness that depends on a distant fact (the order of the `?`
placeholders in SQL strings, one of them inside a sub-select constant).

**Evidence.**

- `type HistoryWrite = readonly [keyof typeof HISTORY_WRITE_SQL, ...(string | number | null)[]]`
  (`packages/harness/src/agent/runtime/historyQuery/views.ts:184-188`).
  The compiler checks the statement name and nothing else: neither the count
  nor the order of the values.
- The child process runs `writes[name].run(...values)`
  (`childSource.ts:68`), positionally, against statements prepared from
  `HISTORY_WRITE_SQL` (`views.ts:160-182`). The statements reach the child
  as JSON at init (`childSource.ts:247-252`).
- 13 construction sites build the arrays in the placeholder order of a
  string they do not show:
  - `modelEnd` (`HistoryQuery.ts:91-106`): ten values, ordered by the
    `UPDATE … SET status = ?, output = ?, error = ?, input_tokens = ?, output_tokens = ?, cost = ?, ended_at = ? WHERE run_id = ? AND invocation_id = ? AND attempt = ?`
    at `views.ts:171-173`. `spend()` returns three of the ten as a
    positional sub-array (`HistoryQuery.ts:86-88`).
  - `toolStart` (`HistoryQuery.ts:185`): `[attempt, at, runId, callId]`,
    where the last two bind the `?`s inside `LATEST_CALL`, a separate
    constant (`views.ts:149-150`, spliced in at `:165,167`).
  - `toolEnd` (`HistoryQuery.ts:190-200`), `toolCall`
    (`:117,160-168,182`) and `modelAttempt` (`:122`).
  - The `runs` insert is `VALUES (?, …)` with one `?` per name in
    `HISTORY_TABLES.runs` (`views.ts:177`). Its 14 values are a parallel
    array in `replaceRuns` (`views.ts:208-229`), kept in step with the
    column list at `views.ts:24-39` by eye.
- Swapping `input_tokens` and `output_tokens`, or `runId` and `callId`,
  compiles, runs, and writes wrong rows into a store the model queries
  (`HISTORY_VIEW_SUMMARY`, `views.ts:236-240`). `HISTORY_TABLES` is public
  API (`index.ts:96`).
- References to `HistoryWrite`: 9, in 2 files. Not touched by any open PR.

**The design decision behind it.** The meaning of each value is carried by
its position in a SQL string, so the statement and every builder of its
arguments are one fact written in two places.

**The better design.**

- Use named parameters, which `node:sqlite` binds natively:
  `StatementSync.run(namedParameters: Record<string, SQLInputValue>, …)`
  (`@types/node/sqlite.d.ts:495-504`), with the default
  `allowBareNamedParameters`.
- Write each statement as `… SET status = :status, output = :output …`,
  and make `HistoryWrite` a mapped union over one parameter interface:
  `type HistoryWrite = { [K in keyof HistoryParams]: { readonly statement: K; readonly params: HistoryParams[K] } }[keyof HistoryParams]`.
  `HistoryParams.toolEnd` is then
  `{ attempt; status; output; value; error; ended_at; run_id; call_id }`.
- The child runs `writes[op.statement].run(op.params)`.
- The `runs` insert names its columns. `replaceRuns` returns an object
  keyed by `HISTORY_TABLES.runs`'s literal names
  (`Record<(typeof HISTORY_TABLES.runs)[number], …>`), so a missing or extra
  column fails to compile.
- Delete: the positional `spend` triple, and the `VALUES (?×n)`
  construction.

This is pure data, so no Effect primitive is involved. The wire to the
child is the harness's own code, so no Schema is needed either ("trust data
from code you control").

**What we give up.** A few characters per statement. Nothing else: the
store is rebuilt from the view at open, so nothing is persisted.

**Change amplification.** "Add a column to `tool_calls`": today 4 places
in 2 files (the column list, the SQL, the right index in each of 3 builders,
the summary), with no compile check on the index. After: the column in
`HistoryParams`, and the compiler names each builder.

**Depends on:** none. Owner: E (agent runtime).

---

## Finding 3. A tool result names its call by position, and each of three lowerers re-derives the pairing with its own cursor

**Red flags:** correctness that depends on a distant fact ("the canonical
grammar guarantees", stated in `protocol.ts`); mutation of an argument; a
positional reference where a named pair would say what it is; the same rule
written three ways.

**Evidence.**

- A tool message's results carry `callOrdinal`, the index of the call among
  the previous assistant message's `local-call` parts
  (`packages/llm/src/message.ts:208-214`, persisted by the harness at
  `shared/schemas/storedTurn.ts:165`). The history check requires
  `result.callOrdinal === ordinal` (`llm/src/protocol.ts:152-176`), so the
  field restates the array index.
- Each lowerer keeps a cursor over "the last assistant's calls" and indexes
  into it. Each has a different reset rule, and the rules agree only because
  of that check:
  - Anthropic: `let calls` (`anthropicMessages.ts:159`), reset only at an
    assistant message (`:195`), read as
    `calls[result.callOrdinal].providerCallId` (`:188`) under the comment
    "The canonical grammar guarantees adjacent, complete ordinals" (`:187`).
  - Google: `let calls` (`googleInteractions.ts:103`), reset after a tool
    message and at an assistant one (`:142,144`), read at `:123` under the
    same comment (`:122`).
  - OpenAI Responses: `callIds: string[]` is a parameter that
    `lowerMessages` mutates (`openaiResponsesLower.ts:76-86`):
    `callIds.length = 0` at every non-tool message (`:116`), `.push`
    (`:222`), read as `call_id: callIds[result.callOrdinal]` (`:110`). For a
    continuation, a second function `replayCallIds` (`:56-73`, 1 caller)
    replays the same reset rule over the covered prefix to seed the array
    (`:340-347`).
- `noUncheckedIndexedAccess` is off, so the compiler does not see the index
  reads. An out-of-range ordinal is a `TypeError` in two lowerers and a
  silent `call_id: undefined` in the third.
- The harness pairs by position too: "A response's dispatch facts follow its
  local calls in order",
  `p.calls.map((call, index) => issue(call, args[index] ?? ''))`
  (`agent/runtime/historyQuery/HistoryQuery.ts:136-145`).
- References to `callOrdinal`: 10, in 7 files. Not covered by O, D or U.

**The design decision behind it.** "Which call does this result answer?" is
answered by a rule the history check enforces in `protocol.ts` and every
lowerer re-implements.

**The better design.**

- The module that checks the grammar also produces the pairing. Beside
  `checkPreparedHistory`, `protocol.ts` exports
  `answeredCalls(messages): ReadonlyMap<number, readonly AnsweredCall[]>`
  (message index to pairs), where
  `interface AnsweredCall { readonly call: LocalCallPart; readonly result: ToolResult }`.
  It is built in the same walk.
- Each lowerer reads `answeredCalls.get(index)` for a tool message and uses
  `pair.call.providerCallId` and `pair.call.name`.
- The OpenAI continuation builds the map over the full history and lowers
  from `coveredMessages`, so the prefix needs no replay.
- Deleted: three cursors (`calls` twice, `callIds`), `replayCallIds`, the
  `callIds` parameter, and both "guarantees" comments.
- Kept: `callOrdinal` on the wire and in storage (a persisted format;
  renaming it would need a row version).

This is pure computation, so plain TypeScript.

**What we give up.** Nothing. The pairing is computed once per lowering
instead of incrementally.

**Change amplification.** "A fourth protocol": today the author writes
another cursor and picks a reset rule. After: the author reads the map.

**Depends on:** none. Owner: E (llm), with R3-E's provider copies (U7).

---

## Finding 4. The `plugin/kind` fact name is spelled at 14 sites in two packages, and the maps keyed by it take any string

**Red flags:** a generic container (`Record<string, …>` keyed by a string
grammar) where a named key would say what it is; information leakage (an
id grammar known by 11 files).

**Evidence.**

- The key of a plugin's fact kind is built by template:
  - `shared/session/runRowReads.ts:65`: the only helper, `factKey`, file
    local, used once;
  - `shared/session/sessionViewUpdate.ts:708`;
  - `controllers/session/rowCodec.ts:348`, plus `pluginKind`,
    `plugin.fact/${plugin}/${kind}` (`:363`), the persisted
    `stored_kind`;
  - `controllers/session/Database.ts:609,617`;
  - `transcript/traceDocumentSchema.ts:52,61`;
  - `agent/runtime/forkRun.ts:209`;
  - `agent/runtime/ToolServices.ts:194`;
  - `tools/plugins.ts:221,262,346`;
  - `shared/schemas/plan.ts:85`;
  - the app's `packages/texra/src/shared/plugins/documents.ts:57`
    (`DOCUMENTS_OUTPUT_KEY`).

  `rowCodec.ts` and `Database.ts` are in #14741.

- The maps keyed by this name accept any string:
  - `RunView.facts: Schema.Record(Schema.String, JsonValueSchema)`, a
    wire field the webviews read (`shared/session/sessionView.ts:92-94`);
  - `RunRows.facts` (`runRowsShape.ts:108`);
  - `FactKinds` (`tools/plugins.ts:258`);
  - `PlanRun.facts: Readonly<Record<string, unknown>>`
    (`shared/schemas/plan.ts:83`).

  A typo in one template reads `undefined` and compiles.

- The same pattern, smaller:
  - `RunState.calls` is keyed `${responseId}/${callId}`
    (`turnRowHandlers.ts:126,315`), and so is the hook point
    (`loop/hooks.ts:396`, "Call ids are unique within one response only").
    `tools/plan/PlanTool.ts:146` rebuilds the key to read the run state.
  - A script call's id `${scriptCallId}/${seq}` is enforced by a schema
    filter (`shared/schemas/runHistoryEvent.ts:352`) and built at
    `loop/toolUseDispatch.ts:807,870`.
- No evidence folder names these grammars. Round 1's A named a different
  one, the delivery id.

**The design decision behind it.** "What is a fact kind called?" has no
owner, so each reader spells the answer.

**The better design.**

- The module that declares `FactKind` (`tools/plugins.ts`, or the shared
  schema module both packages already import) exports one constructor and
  one brand:
  `const FactName = Schema.String.pipe(Schema.brand('FactName'))`
  (`Schema.d.ts:4398`), and
  `factName({ plugin, kind }): FactName` (`plugin` and `kind` are on both a
  `FactKind` and a `plugin.fact` row).
- `RunView.facts` becomes `Schema.Record(FactName, JsonValueSchema)`
  (`Schema.d.ts:3355`), and `RunRows.facts`, `FactKinds` and the trace map
  are keyed by `FactName`. A raw template no longer indexes them.
- `pluginKind` becomes `` `plugin.fact/${factName(fact)}` ``.
- Likewise one `callKey(responseId, callId)` beside `RunState`, and the
  script call id read from the payload's own fields.
- The wire and stored spellings are unchanged.

**Design it twice.**

- (A) Nest the maps by plugin and then kind, which removes the grammar.
  It changes a wire field's shape and every reader.
- (B) The branded name keeps the spelling and gives it one owner.

B is chosen.

**What we give up.** Nothing. Risk: #14741 touches `rowCodec.ts` and
`Database.ts`, so land after it.

**Change amplification.** "A plugin reads its fact": today the template
again, in the app as well. After: `factName(MY_KIND)`.

**Depends on:** #14741. Owner: E.

---

## Finding 5. `submit_output` accepts once per activation while it says once per run, so a run differs live and after a resume

**Red flags:** correctness that depends on a distant fact (where the tool is
constructed); state held in memory beside the rows that already hold it; a
false comment.

**Evidence.**

- `buildTerminalTool` keeps `let captured = false` under the comment "Built
  per run, so `captured` belongs to this run's loop alone"
  (`packages/harness/src/tools/structuredOutput.ts:199-200`). A second call
  fails with "submit_output can only be accepted once per run."
  (`:209-214`).
- It is built in `agentRunLayer` (`agent/runtime/run/AgentRun.ts:219-227`).
  `executeAgent` builds that layer for every activation, fresh or resumed
  (`executeAgent.ts:312-322`). So a resume gets `captured = false`.
- The rows keep the latest submission:
  `structured: output !== null && value !== undefined ? { value } : facts.structured`
  (`shared/session/runFacts.ts:150-152`).
- The sequence "submit, a follow-up, submit again" is therefore refused in
  one process, and accepted (overwriting the result) if the process
  restarted in between. `packages/harness/AGENTS.md` "State is row data":
  "so live and resume are one function".
- The read that would make it one function already exists.
  `RunCall.facts` is "the run's facts as its rows stand when read … so a
  resumed run answers as the live one did" (`agent/runtime/RunCall.ts:229-232`),
  and `RunFacts.structured` is the field (`runFacts.ts:75`).
- `buildTerminalTool` has 1 caller. No evidence folder names it.

**The design decision behind it.** "Has this run submitted its output?" is
answered by a closure, whose lifetime is an activation, instead of by the
rows.

**The better design.**

- `execute` reads `(yield* RunCall)?.facts` (`RunCall` is a
  `Context.Reference`, `Context.d.ts:1741`) and refuses when `structured`
  is not null.
- `captured` and its comment go.
- The tool's description ("Call this exactly once") and the refusal then
  state one rule, which the rows enforce across resumes.
- If "once per activation" is the intended rule, the read is "a
  `submit_output` result since the latest `run.activate`". Either way, one
  answer from the rows.

**What we give up.** Nothing. A second submission after a resume is
refused, as the message already says.

**Change amplification.** "A resumed run may submit again": today the
closure, the fold and the description each say something. After: one
predicate.

**Depends on:** none. Owner: F (harness tools).

---

## Finding 6. GitHub REST bodies are cast to caller-named types while the schemas for them sit unused

**Red flags:** an `as` cast hiding a missing check at a real boundary; a
named type that implies validation it never had.

**Evidence.**

- `ghGet<T>` returns `data: (yield* response.json) as T`, with the reason
  "`T` is the caller's name for the GitHub REST shape at `path`"
  (`packages/texra/src/tools/github/githubClient.ts:150-153,186-188`).
- 14 `ghGet` calls and 3 `ghGetOk` calls in 6 files:
  - 7 pass `<unknown>`, and only `checkRunsClient.ts:339-340` decodes after.
  - 8 name a type and never decode: `checkRunsClient.ts:162`,
    `pullPoller.ts:190,197,204`, and `githubSubscriptionTool.ts:277,341,350,446`
    (`ghGetOk<T>` at `:259-266`).
  - One names a type and then decodes anyway: `repoPoller.ts:387-391`
    (`ghGet<GhPullRequest>`, then
    `Schema.decodeUnknownResult(GhPullRequestSchema)`), so the cast is
    refuted by the next line.
- The named types are mostly `typeof …Schema.Type` (`prTypes.ts:37,51,63,81,157`).
  `GhIssueCommentArraySchema`, `GhReviewCommentArraySchema` and
  `GhIssueSchema` exist and are not run on these reads.
- Root AGENTS.md: "Normalize external input once at the boundary". H
  covered `ghGet`'s failure typing (`H-app-tools.md:258`), not its body.

**The design decision behind it.** The client lets the caller decide what
the body is, so the boundary that should decode it does not.

**The better design.**

- `ghGet(path, schema, etag?)` decodes the 200 body with
  `HttpClientResponse.schemaBodyJson(schema)` (re-exported from
  `http/HttpIncomingMessage.d.ts:73`) and returns
  `ConditionalResponse<S['Type']>`. A decode failure is a typed
  `SchemaError` in the `GitHubFailure` union, which the pollers already log
  and skip (`repoPoller.ts:392-397` shows the shape).
- Each call site passes the schema its type comes from.
- The `<unknown>` callers pass `Schema.Unknown` until their domain parsers
  move behind a schema.
- Deleted: the cast, the decode after the cast at `repoPoller.ts:391`, and
  the generic `T` on `ghGetOk`.

**What we give up.** A payload that drifts from the schema is rejected
instead of read partly. That is the point, but a field GitHub drops starts
failing loudly. Tag optional fields `Schema.optional` where GitHub documents
them as optional.

**Change amplification.** "A new endpoint": today a type and trust. After:
a schema, which the type already derives from.

**Depends on:** none. Owner: C (the GitHub structure, #14790).

---

## Finding 7. The LaTeX viewer opens after a fixed 5 seconds, standing in for "the build finished"

**Red flags:** correctness that depends on a timing; the ordering stated
only in a constant's comment.

**Evidence.**

- `invokeLatexWorkshopBuild` awaits `latex-workshop.build`
  (`packages/extension/src/frontend/latex/openBuild.ts:97-108`). Then
  `scheduleViewerDisplay` sleeps `LATEX_VIEWER_OPEN_DELAY_MS = 5000`
  before `latex-workshop.view` (`openBuild.ts:322-325`;
  `packages/texra/src/shared/constants/latexTiming.ts:9-10`: "Delay
  before auto-opening the LaTeX viewer after build").
  `scheduleViewerRefresh` sleeps another 5000 ms "so LaTeX Workshop has
  rendered the PDF" (`openBuild.ts:296-302`).
- A build slower than 5 s opens a stale or missing PDF. A fast one waits for
  no reason.
- `latex-workshop.view` acts on LaTeX Workshop's _current_ document, so
  callers that prepare several files must remember
  `scheduleViewer: false` and call it once after the last one
  (`openBuild.ts:147-155`; `latexdiffCommands.ts:118`). That is an ordering
  contract on every caller.
- `refreshDiffOnLayoutChange` sleeps `DIFF_REGISTRATION_DELAY_MS = 300` so
  "the moves the diff's own opening caused are not answered"
  (`frontend/ui/diffView.ts:14-18,35`).
- Consumers: `scheduleViewerDisplay` 3 (`openBuild.ts:142,179`,
  `latexdiffCommands.ts:118`); `DIFF_REGISTRATION_DELAY_MS` 1.
  `latexCommands.ts:100`'s bare `Effect.sleep(100)` is T's
  (`T-app-surfaces.md:664-666`).

**The design decision behind it.** "When is the PDF ready?" is guessed
instead of observed. The PDF's path is already computed in this file
(`resolveLatexWorkshopOutDir`, `openBuild.ts:47-90`).

**The better design.**

- Wait for the event the delay stands for: the build's PDF changing on
  disk. In Effect:
  `fs.watch(pdfPath).pipe(Stream.filter(isUpdate), Stream.runHead, Effect.timeoutOption(budget))`
  (`FileSystem.d.ts:324`, `WatchEvent` `:844`; `Stream.d.ts:5253,15903`;
  `Effect.d.ts:8377`). Then open the viewer.
- On timeout, the viewer opens anyway and says the build had not written
  yet, which replaces today's silent race.
- The refresh then needs no second sleep: it follows the same watch.
- For the diff, start the listener after the `vscode.diff` command that
  opened it has returned, and let the existing
  `Stream.debounce(REFRESH_SETTLE_MS)` absorb the trailing burst.
  `DIFF_REGISTRATION_DELAY_MS` goes.

**What we give up.** The fixed upper bound on the wait becomes a budget,
which is a setting-free constant like today's. Watching a file on a network
drive can lag, and the timeout covers that.

**Change amplification.** "Open the viewer after the latexdiff build":
today pick a delay. After: the same watch.

**Depends on:** none. Owner: B (extension commands, R3-B).

---

## Batched smaller items

1. **A captured context re-provided whole, outside the noted session
   owner.**
   - `agentCatalog.ts:322` takes `yield* Effect.context<AgentCatalogServices>()`
     and re-provides it into `refresh` and `customize` (`:339,379`).
   - `toolAvailability.ts:152` does the same with `Effect.provideContext`
     around every probe round (`:188`).
   - `provideContext` merges the captured context over the caller's
     (`effect/dist/internal/effect.js:1366-1368`), so the caller's log
     annotations, span and log level are replaced by those of the fiber that
     built the layer. Root AGENTS.md: "Forward a captured context only
     through `Context.pick`".
   - Fix: `Context.pick(GlobalStorageFs, FileSystem.FileSystem, AgentDirectories, AppState, ToolRegistry)`
     (`Context.d.ts:1660`), and the same for `ToolProbeServices`.
   - Related: `agentCatalog`'s `CatalogState` is written field by field
     across a yield (`agentCatalog.ts:192-232`, and `loadFailure` in a later
     `tap` at `:340-348`), so a reader between the two steps sees one load's
     entries with the previous load's failure. Replace it with one immutable
     snapshot assigned once. (`sessionOwners.ts:207,230` is noted in
     `2026-11-06-root-designs-pr1-compromises.md` §3. `processLayer.ts:225`
     is the composition root's own context.) Owner: F.
2. **`countLaunch` mutates a counter that a script shares.**
   `launches.count += 1` on a `script.shared` value
   (`agent/runtime/delegation/agentChild.ts:59-75`). It is in-memory only, so
   a resumed script gets a new `AGENT_CALL_LIMIT` budget. The launches are
   rows (`script.call` rows for `agent`), so the count can be read from
   `RunCall.facts` like finding 5. Owner: E.
3. **`TemplateVars = Partial<TemplateInputs> & Record<string, unknown>`**
   (`agent/prompt/templateInputs.ts:79`). The intersection with a string
   index means a misspelled variable compiles. Drop the index, or name the
   extension keys a plugin adds. Owner: C, with T1.
4. **Comments whose reason is a ticket.**
   - `desktop/src/main/desktopUpdateChecker.ts:12` ("issue #7682, decision:
     arm b"; "arm" is also on the AGENTS.md plain-names list).
   - `texra/src/agent/export/loadChatExportInput.ts:18` ("per #7246
     Decision 1").
   - `cli/src/runtime/cliProcessRuntime.ts:22` ("rulings ledger, #12720";
     two words the plain-names list refuses).
   - `desktop/src/shared/desktopDiffMessages.ts:67-72` ("Cursor Bugbot
     review on PR #3815").
   - `texra/src/ui/progress/formatters/constants.ts:29` ("see issue #7120").
   - `extension/src/commands.ts:39-48` is an audit log written as a
     comment ("has been verified to have no stale `registerCommand`"). VS
     Code already throws on a duplicate id, and nothing keeps the sentence
     true.

   Each one states the reason or goes, in the PR that touches its file.
   `rules.ts:617`'s "Bug fix: previously …" goes with finding 1.

5. **Small positional tuples.** `JsonRpcOptions.cancel` returns
   `[method, params]` (`tools/jsonRpc.ts:108`, 1 implementer
   `mcp/mcpServer.ts:306-309`, spread into `notify(...notice)` at
   `jsonRpc.ts:387-391`). It should be `{ method, params }`. Thin; it goes
   with any change to the file.
6. **The two casts without a reason.**
   - `sharedSettingsCommands.ts:165`: `Object.fromEntries(...) as SettingsHostState['subscriptionAuth']`.
     A provider missing from `SUBSCRIPTION_AUTH_PROVIDERS` would compile.
     Use `Record.fromEntries` over the literal set, or a `satisfies`.
   - `hostSnapshotSource.ts:238`: `key as keyof Inputs`, the usual
     `Object.entries` widening, which is fine with a reason.
   - Also `runTrace.ts:289`'s `Struct.omit(row, ENVELOPE) as AgentEvent`
     (reasoned) depends on `ENVELOPE` (`:214`) listing exactly the keys that
     `runEventDraft` (`agent/trace/TraceEmitter.ts:294-300`) and the store
     add. A trace event field named `at` or `origin` would be stripped
     silently. A decode with the trace event union drops undeclared keys by
     construction.

---

## Good modules for this lens

- **The `// cast:` discipline.** 62 of 64 assertions say why. The reasons
  are mostly real proofs (`toolProbing.ts:36` "`hasOwn` just found `name`",
  `runRowReads.ts:312` "the row `findIndex` matched"), which makes the
  remaining hidden checks (findings 6, batch 6) easy to see.
- **Typed presentation dispatch.** Every string-keyed `emit` names a member
  of `RuntimePresentationEventPayloads`
  (`agent/runtime/runtimePresentationEvents.ts:19-33`). Each host answers
  with an exhaustive table (`cli/src/runtime/cliPresentationHost.ts:82-120`,
  `extension/src/frontend/events/agentEventListeners.ts:246-257`,
  `desktop/src/main/desktopHostRequests.ts:113-117`), so a handler is found
  by its key and a missing one fails to compile. Desktop IPC goes through
  one bridge (`main/hostBridge.ts:35-43`, `preload/index.ts:20-35`).
- **`ROW_HANDLERS` / `MESSAGE_HANDLERS`** (C judged them good): an ordering
  precondition is data (`requires`) checked once by `applyRow`, not a
  comment.
- **`RunCall.facts`** (`RunCall.ts:229-232`): a tool reads the run's state
  from its rows "so a resumed run answers as the live one did". It is the
  structure findings 5 and batch 2 should use.
- **`readerAbortSignal`** (`llm/src/api/transport.ts:194-224`): it depends
  on finalizer order (LIFO aborts the request before the cancel joins a
  read), but both registrations are four lines apart in one function and
  the comment states the reason, so the order is local. Leave it alone.

## Already found, left alone

| Instance                                                                                                                                                         | Where it is found                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| The TUI's escape-chord `queueMicrotask`, and the static-transcript re-entry (now `staticTranscriptRing.ts:544-547`)                                              | K findings 10 and 1 (`K-cli.md:83,773-774`)                                      |
| `desktopWindows.ts:139` `setImmediate(resume)`; the desktop renderer's `queueMicrotask` shell scheduler (`renderer/main.ts:199-206`)                             | N finding 9 (`N-vscode-desktop.md:541-565`); N's renderer finding (`:669-671`)   |
| `subscribeToSignalChanges`'s microtask (`texra/src/shared/signals.ts:81-110`)                                                                                    | J. A TC39 Signal watcher may not read in its notify, so this is a framework edge |
| The root-run claim "MUST call this as its first statement, before any `await`" (`cli/src/chat/tui/state/sessionRunState.ts:170-195`)                             | F (`F-hosts.md:57-62,136-150`)                                                   |
| `sessionPrograms.start`'s `opened` flag with `onInterrupt` (`effect/sessionPrograms.ts:159-178`)                                                                 | B (`B-session-store.md:608,627`)                                                 |
| The script door's `places` / `barrier` / `since` lanes (`loop/toolUseDispatch.ts:705-733`)                                                                       | E (`E-loop-tools.md:721-725`)                                                    |
| `AttemptOutcome`, the mutable box `eventSink`, `submitAndObserve` and `finishAttempt` share (`ModelInvoker.ts:246-249,483-504`; `run/backgroundTurn.ts:120,131`) | D (`D-model-call.md:268-275`)                                                    |
| `sessionTransport`'s `generation` counter (`ui/progress/sessionTransport.ts:301`)                                                                                | J (`J-ui-kit.md:54,86`)                                                          |
| `executeCli.ts:218,227`'s `failurePresented`, sniffed from `emit`                                                                                                | F (`F-hosts.md:452`)                                                             |
| `runApprovalQueue.change`'s skip read "the view has applied every change by the time it returns" (`:220-229`)                                                    | B (`B-session-store.md:469`)                                                     |
| The settings readers' caller-named `as T` (`shared/config/settings.ts:277-392`, `jsonConfigProvider.ts:99,134`)                                                  | Round 3 P3                                                                       |
| `sessionOwners.ts:207,230` `Context.merge` of the whole captured context                                                                                         | `2026-11-06-root-designs-pr1-compromises.md` §3; V's S20                         |
| `latexCommands.ts:100` `Effect.sleep(100)`                                                                                                                       | T (`T-app-surfaces.md:664-666`)                                                  |
| `BatchCopies` / `ownCopy` and the transcript drafts' copy-on-write writes (most of the 112 parameter writes)                                                     | C judged them good (`C-row-model.md:702-703`)                                    |

---

## Effect-native mapping

Every API below was checked in `node_modules/effect` 4.1.2 `.d.ts`. A row
marked "none" is pure computation, which AGENTS.md keeps in plain
TypeScript. There is no `Layer.scoped`, and none is proposed.

| Hand-rolled today                                                                                                                                            | Effect primitive, or the plain structure                                                                                                                                                                                                                                                  | Note                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Rule order as object-key insertion order across 13 `Record<string, string>` literals, merged by `Object.assign` (`replacement/engine.ts:235-241,343`)        | none: an ordered `readonly { from; to }[]` sorted longest `from` first, once per config read (`Array.prototype.toSorted`)                                                                                                                                                                 | finding 1; measured 318 → 0 defeated default rules                                                       |
| `HistoryWrite` positional tuples bound to `?` placeholders (`historyQuery/views.ts:160-188`, `childSource.ts:68`)                                            | none: named SQL parameters, `node:sqlite` `StatementSync.run(namedParameters)` (`@types/node/sqlite.d.ts:495-504`), with a mapped `HistoryParams` type                                                                                                                                    | finding 2                                                                                                |
| Three call cursors and a mutated `callIds` array (`anthropicMessages.ts:159-208`, `googleInteractions.ts:103-193`, `openaiResponsesLower.ts:56-116,340-347`) | none: `answeredCalls(messages)` beside `checkPreparedHistory` in `llm/src/protocol.ts`, returning `AnsweredCall { call, result }` pairs                                                                                                                                                   | finding 3                                                                                                |
| `${plugin}/${kind}` templates at 14 sites; `Record<string, …>` maps keyed by them                                                                            | `Schema.brand('FactName')` (`Schema.d.ts:4398`) on `Schema.String`; `Schema.Record(FactName, JsonValueSchema)` (`Schema.d.ts:3355`); one `factName` constructor                                                                                                                           | finding 4; the wire and stored spellings are unchanged                                                   |
| `let captured = false` in the terminal tool (`tools/structuredOutput.ts:199-216`)                                                                            | the `RunCall` `Context.Reference` (`Context.d.ts:1741`) and its `facts` Effect: `structured !== null` refuses                                                                                                                                                                             | finding 5; live and resume become one function                                                           |
| `(yield* response.json) as T` (`github/githubClient.ts:186-188`)                                                                                             | `HttpClientResponse.schemaBodyJson(schema)` (`http/HttpIncomingMessage.d.ts:73`, re-exported by `http/HttpClientResponse.d.ts:36`); otherwise `Schema.decodeUnknownEffect` (`Schema.d.ts:1229`)                                                                                           | finding 6; `SchemaError` joins `GitHubFailure`                                                           |
| `Effect.sleep(5000)` before and after opening the viewer; `Effect.sleep(300)` before listening (`openBuild.ts:302,324`, `diffView.ts:35`)                    | `FileSystem.watch(path)` (`FileSystem.d.ts:324`, `WatchEvent` `:844`) → `Stream.filter` (`Stream.d.ts:5253`) → `Stream.runHead` (`:15903`) under `Effect.timeoutOption` (`Effect.d.ts:8377`); the diff listener starts after the open's `vscode.diff` returns and keeps `Stream.debounce` | finding 7                                                                                                |
| `yield* Effect.context<…>()` re-provided whole (`agentCatalog.ts:322,339,379`; `toolAvailability.ts:152,188`)                                                | `Context.pick(...)` (`Context.d.ts:1660`)                                                                                                                                                                                                                                                 | batch 1; `provideContext` merges the captured context over the caller's (`internal/effect.js:1366-1368`) |
| `CatalogState` written field by field across a yield (`agentCatalog.ts:192-232,340-348`)                                                                     | none: one immutable snapshot assigned once. If readers must follow it, `SubscriptionRef.make` / `set` (`SubscriptionRef.d.ts:93,1102`)                                                                                                                                                    | batch 1                                                                                                  |
| `launches.count += 1` on a script-shared object (`delegation/agentChild.ts:59-75`)                                                                           | the `RunCall` `facts` read, as in finding 5                                                                                                                                                                                                                                               | batch 2                                                                                                  |
