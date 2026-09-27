## Adversarial critique of the proposed TeXRA core-concept set

Everything below was read against `origin/main` at 4311c54176, PR #13350's session-core note, the implemented architecture notes, deepseek-harness and Pico5. Nothing was edited. Re-checked on a53db0e, after #13348 and #13359 merged: items they fixed are marked as such and kept as history, and drifted citations are updated.

### (a) Verdict

The set has the right direction but the wrong grain, and four of its definitions contradict the code.

- **Right:** "log is truth" (R1), "hosts present", runs pinning their composition, and plugins as static tables. These match the rulings.
- **Wrong grain:** three entries are rules or properties rather than concepts (Fold, Pin, Continuation). Composition is two concepts merged, and a preset is not a composition. The set is missing the three nouns that carry most code: Input/inbox, Agent definition, and the Model/Tool call planes.
- **Contradicted by code:** Session ("conversation"), Run ("one program"), Log ("one writer"), and Host ("decides nothing").
- **Lifetime stack:** "process → session → run → call" omits the ruled fourth lifetime, the composition. That lifetime is process-owned and shared across sessions, so the stack is not a simple nesting.

### (b) Merges, splits, additions, and definition fixes

**Wrong definitions**

1. **Session is a storage root, not a conversation.**
   - `Sessions` is a `LayerMap` keyed by storage root, one session per root (`src/controllers/session/sessionLayer.ts:1-14,161-181,788-798`).
   - The session-messaging note says it outright: what users call "sessions alive in one project" are runs inside one `SessionHandle`, one per root, over one `texra.db` (`.agents/docs/proposed/architecture/2026-09-25-session-messaging.md`).
   - The root's DB also holds non-conversation aggregates: `app-state`, `desktop-projects`, `update-check`, `global-inquiry` (`src/shared/schemas/sessionEvent.ts:117-126`).
   - Fix: Session = one storage root's log plus everything live over it. A conversation is a root run inside it, which is Pico5's Session ⊃ Conversation split.
   - Workspace then folds into Session: `WorkspaceRoots.storage` is the session key (`src/controllers/session/WorkspaceRoots.ts`).

2. **The log is per root, ordered per aggregate. It is not per session-conversation.**
   - The `event` table is keyed by `aggregate_id` with a per-aggregate `seq` and a root-wide `commit` (`src/controllers/session/storeFormat.ts:186-213`).
   - Claims live per aggregate in `event_sequence.owner_id`.

3. **"One writer" is false as stated.**
   - A run aggregate has two producers, both going through the one publisher per (process, root), that is, the session's `SessionEvents` inbox: `RunLedger.appendBatch` writes ledger rows, validated and pre-folded (`src/agent/runtime/RunLedger.ts`), and trace facts arrive via `runEventDraft` and `detach` (`SessionEvents.ts:400`, `SessionHandle.ts:993`).
   - Two processes on one root each have a publisher; SQLite and claims arbitrate between them.
   - Two writes bypass the publisher today: `Database.removeRun` (`Database.ts:1013`, which drafts `run.removed` at `:1045`) and `appStateStore` calling `database.appendAll` (`appStateStore.ts:76`).
   - Claims and GC stay in SQL by ruling ("Every write is a command" was withdrawn in #13350).

4. **Run is not "one program."**
   - `RunIdentity` covers native agent, external-CLI agent (codex/claude), `process` (bash) and `multiAgentWorkflow` (`src/shared/schemas/runIdentity.ts:16-30`).
   - `childRunLoop.ts` drives "native runs and processes".
   - Fix: Run = one `run` aggregate with an identity, a parent edge and a driver. The tool-use loop is the native driver.

5. **Host decides things today.**
   - The CLI applies the approval policy for the retry, human-input and executable request kinds (`packages/cli/src/runtime/approval/settleApprovals.ts:86-153`).
   - The host hook `openWorkflowOutput` can replace a run's outcome (`src/agent/runtime/executeAgent.ts:224-231`), in both the CLI (`packages/cli/src/commands/workflow.ts:375`, `resolveWorkflowOutput` with `tryCommitPublication`) and desktop (`desktopAgentLaunch.ts:61`).
   - `prepareSurfaceLaunch` needs host dialogs mid-launch.
   - Post-auth invalidation is a ruled permanent host boundary.
   - The CLI keeps follow-ups typed after Ctrl-C in host memory and auto-resumes.

6. **"Request" is spelled three ways.**
   - `RuntimeRequest`: host → core commands (`src/shared/session/runtimeRequest.ts:26`).
   - `HostRequest`: core → host capabilities (`hostRequest.ts:27`).
   - `request.opened` / `request.decided`: waits on a human.
   - "Host sends requests" collides with the concept name. Rename the first to Command and the second to Host port.

7. **Pin is not what the code does.**
   - "Nothing about the pin is persisted." A resumed run re-resolves its composition and offers recorded ∩ available (plugin note).
   - The definition is not pinned: resume re-reads the YAML live. That is decision 10, still open.
   - A child joins the parent's composition entry but keeps its own declared tools, injections and gates.
   - A child opened after a switch still gets the parent's old composition, so "next run" really means "next root run".

8. **Composition is not "a hashable plugin set."**
   - It also carries `host`, `approvalPromptsUnavailable`, the agent's declared `tools`, `injected`, and probe results (`src/tools/composition.ts:24-49`).
   - So "a preset is a stored composition" cannot hold. A preset can only store the switch part.

9. **Plugin is not "one on/off unit" today.**
   - "Plugin skills are not gated by the plugin's switch" (plugin note, line 191).
   - Bundled plugin agents join `builtInToolUse` unconditionally.
   - `MODEL_PROVIDER_PLUGINS` entries are not toggleable.
   - #13350 counts six different meanings of "plugin".

**Merges**

- **Pin → a property of Run and Composition.** A run holds one composition entry (process `Compositions` LayerMap, refcounted) and records its offered set in the opening `flow.snapshot`. It is not a separate owner of anything.
- **Fold → a rule under Log, not a concept.** There are two named folds by design: `foldRunState` (strict, resume authority) and `sessionFold` (tolerant display). R1 in one-run-model §2 already says two folds are legitimate only for two questions. A contributor needs "read RunState or SessionView", not "Fold".
- **Continuation → a source of Input, selected by the Agent's category from the pinned composition.**
  - It is not just "what at idle." `rounds` changes the run's mode: no input, no threshold compaction, a failed turn ends the run, and a child is wrapped as one turn (`loop/continuationPolicy.ts`, `loop/rounds.ts`, one-run-program note).
  - Goal continuation reads goal state and writes approval bypass (`setGoalSessionAutoApproval`), so it is not pure data.
- **Claim / liveness → part of Log.** The DB claim is the only liveness authority (single-owner liveness note). `runRegistry` holds the in-process entry beside it. Claims are properties of aggregates.
- **Trace → part of Log**, as the run's producer port for display rows. Every `AgentEvent` arm except the transient `stream.chunk` is a session row (`src/agent/trace/events.ts:1-20`). Stage, stream and card lifetimes (move 7) belong to Run and Tool call scopes.
- **Workspace → Session.** Roots are the session's key and are carried by `session.roots` / `call.roots`.
- **Output → documents-plugin facts (`output.produced`), not a top-level concept.** But it needs an explicit rule, because it is where verdicts leak to hosts.

**Splits**

- **Composition → Preset + Composition.** A preset is a stored switch set, recorded by id; this matches the harness, whose session log retains the preset id. A composition is resolved per run from preset × agent tools × host × probes.
- **Parent edge → lineage + supervision.**
  - `runRelation` treats a detached run as top level (`src/shared/session/runRelation.ts`), so detaching erases lineage.
  - Pico5 keeps `parent` (history) and `owner` (authority, subtree abort) as separate fields. TeXRA already has `run.detach` and `child.park` / `child.turn` rows but no noun for either role.

**Additions, tested**

- **Input / inbox: add.** This is the largest omission.
  - `followup.queued` carries user input, child reports, peer messages and subscription notices (#13306).
  - Its in-process owner is a 713-line second owner (`ToolUseFollowUpQueueManager.ts`, held at `SessionHandle.ts:274`). The parent-cancel bug fixed by #13348 did not come from the manager: `FollowUps` was a context tag that a child inherited in its parent's tool-call fiber (`FollowUps.ts:20-24`).
  - The harness has an inbox, Pico5 has Submission and inbox, and move 10 is about exactly this.
- **Agent (definition + catalog): add.**
  - Catalog: module state in `src/agent/index/agentRegistry.ts:63-70`. Three loaders exist. Definition pinning is open (decision 10).
  - Category selects continuation and the documents plugin, so it is load-bearing.
- **Model (binding, route, credential, retry gate, attempt): add.**
  - `ModelInvoker` is the one caller of `packages/llm` (CLAUDE.md).
  - Two bypasses exist: compaction and helpers.
  - The retry gate is session-scoped (`sessionLayer.ts:588`), but its real owner is the credential.
  - Its lifetimes (binding scope, attempt scope) don't fit process → session → run → call.
- **Tool call (offered set, guard, card): add.**
  - The loop-owned card rule, `tool.intent` / `binding` / `result` rows, `toolGuard.ts`, the offered set on the snapshot, and the missing-guard defect (four `requiresApproval` tools with no call-time gate).
  - This is where most contributor code lands.
- **Delegation / child edge + driver: add, or fold into Run plus Input.** `childRunLoop.ts` (1,384 lines), the session budget, `PLUGIN_DRIVERS` and detach policy all need a home. I keep it as its own concept.
- **Turn / step / round: define as Run vocabulary, not top-level concepts.** TeXRA's names are crossed:
  - `state.round` is bumped per model call, which is a step.
  - A workflow round is a turn.
  - `child.turn` is a delivery.
  - The harness defines turn ⊃ step, with round as an outer policy iteration. Adopt that.
- **Trace, Workspace, Claim, Output:** merge as described above. They are not top-level concepts.

### (c) Minimal set (12)

| Concept              | One-line definition                                                                                                                                                | Lifetime                                                                                       | Owner module                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process              | One `ManagedRuntime` plus process services (tables, `Compositions`, `Sessions` map, catalog)                                                                       | OS process                                                                                     | `installProcessRuntime` in `src/controllers/session/sessionLayer.ts:1154`; `src/platform/processRuntime.ts`                                                                                                                 |
| Session              | One storage root: its log, publisher, folds, live runs, requests; conversations are root runs in it                                                                | `Sessions` LayerMap entry, explicit close                                                      | `sessionLayer.ts` + `src/agent/runtime/SessionHandle.ts`                                                                                                                                                                    |
| Log                  | Append-only rows per aggregate, root-wide commit order, one publisher per (process, root), claim per aggregate; RunState and SessionView are its two folds         | Durable (format-stamped)                                                                       | `src/shared/schemas/sessionEvent.ts` (vocabulary), `src/agent/runtime/SessionEvents.ts` (publisher), `src/controllers/session/Database.ts` (claims), `src/shared/session/runRows.ts` / `runStateFold.ts` / `sessionFold.ts` |
| Run                  | One `run` aggregate with identity, parent edge and driver; native driver = the tool-use program; turn ⊃ step                                                       | run.start → run.end; fiber scope while live; resume re-enters from rows                        | `loop/toolUse.ts`, `run/AgentRun.ts`, `RunLedger.ts`, `runRegistry.ts`                                                                                                                                                      |
| Input                | Every message to a run is a `followup.queued` row on its aggregate (user, child report, peer, subscription, continuation-made turn)                                | Row durable until `followup.consumed`                                                          | `src/agent/followUp/`, `src/agent/runtime/FollowUps.ts`, `loop/continuationPolicy.ts`                                                                                                                                       |
| Delegation           | A run opening a child through a driver; the child joins or narrows the parent composition, reports via Input, and shares the session budget; lineage ≠ supervision | Child run's lifetime, under the parent's supervision until detach                              | `childRunLoop.ts`, `childRunBudget.ts`, `src/shared/session/runRelation.ts`                                                                                                                                                 |
| Agent                | A resolved definition (settings, prompt, declared tools, category) from an ordered catalog of sources                                                              | Catalog: process, rebuilt on refresh; definition: recorded at run open                         | `src/agent/index/agentRegistry.ts`, `agentLoad.ts`, `src/agent/core/definition/`                                                                                                                                            |
| Plugin & Composition | Plugin = id plus rows in fixed seam tables; Preset = stored switches; Composition = per-run resolution (preset × agent tools × host × probes), refcounted          | Tables static; composition entry process-scoped, held by runs                                  | `src/tools/plugins.ts`, `src/tools/registry.ts`, `src/tools/composition.ts`, `src/tools/compositions.ts`                                                                                                                    |
| Model call           | Binding (route, credential) → invoker → attempt; the one call path, gated, priced, retried                                                                         | Binding: run (target per-binding scope); attempt scope; gate: session today, credential target | `ModelInvoker.ts`, `run/modelBinding.ts`, `modelRoutes.ts`, `packages/llm`                                                                                                                                                  |
| Tool call            | Offered set → call → guard → (request) → result; loop-owned card                                                                                                   | Call scope                                                                                     | `loop/toolUseDispatch.ts`, `loop/toolGuard.ts`, `ToolCall.ts`                                                                                                                                                               |
| Request              | A wait on a human or authority: `request.opened` → `request.decided`, decided by the session's one policy                                                          | Row lifetime; the run parks meanwhile                                                          | `src/controllers/session/SessionRequests.ts`, `src/shared/approvalPolicy.ts`, `runApprovalQueue.ts`                                                                                                                         |
| Host                 | Presents folds, owns input devices and host-only effects, sends Commands, serves host ports; decides no recorded fact                                              | Host scopes (activation, window, TUI), parallel to sessions                                    | `packages/{extension,desktop,cli}`, `HostInteractions.ts`, `hostRunActions.ts`                                                                                                                                              |

### (d) Invariants, tightened

1. **One writer.**
   - Per (process, root): every durable append is a job on the one `SessionEvents` inbox, and commit order is enqueue order.
   - Per aggregate: only the claim holder appends (the owner is stamped in the insert).
   - Per row type: one writing function (ledger rows: `RunLedger.appendBatch`; `run.end`: `finalizeRun`; request rows: `SessionRequests`).
   - Claims and GC stay in SQL.
   - Current violations: `Database.removeRun`, `appStateStore.appendAll`.
2. **Log is truth.**
   - A fact is one row type.
   - A persisted derivation is admissible only as a checkpoint that rows rebuild and that loses every conflict with them.
   - Two folds exist only for two questions: RunState for resume, SessionView for display. Resume correctness never reads the display view.
   - Add the harness rule "model-visible means logged": the prompt, offered tools and definition that reached the model are reconstructable from the run's rows.
3. **One owner.** Every piece of mutable state is a Layer or scoped value at exactly one lifetime: process, session, composition, run, attempt/call, or host scope. No module variables or WeakMaps keyed by another concept's handle.
4. **No ambient reads.**
   - Effect context carries services of the reader's own lifetime or an enclosing one.
   - A forked child gets its own run layer and never inherits another run's run-lifetime services (the `FollowUps` bug that #13348 fixed).
   - Session-level state is read through the session handle, not module slots.
5. **Plugins.**
   - A plugin is an id plus rows in static seam tables owned by the seam's layer and `satisfies`-checked against the manifest.
   - Each seam has one fixed core call site and resolves at most one contributor per run from the pinned composition, so there is no chain and no register/unregister.
   - Function contributions write only through the run's ledger or publisher.
   - The plugin's switch gates every contribution it makes. Skills and bundled agents currently escape this.
6. **Changes at run open or a recorded step boundary.**
   - A root run resolves its composition (and, once decision 10 lands, its definition) at open and records the offered set and digest on its opening snapshot.
   - A child joins its parent's entry and may only narrow.
   - Resume offers recorded ∩ available and names loudly what is missing.
   - A change inside a run takes effect only at a recorded step boundary, never mid-step.
7. **Core decides.**
   - Any decision whose result is recorded (request decision, admission, outcome) is made in core and committed as a row.
   - A host may supply a human's answer as a Command and run effects that cannot change a verdict: open file, dialog, toast.
8. **Lifetimes.**
   - process ⊃ session ⊃ run ⊃ attempt/call.
   - Composition is process-owned and refcounted by runs across sessions.
   - Host scopes run parallel to sessions and are not nested in them.

### (e) Where a new contributor would most likely put code in the wrong layer today

1. **Approval policy in a host.**
   - Where: `packages/cli/src/runtime/approval/settleApprovals.ts:86-153` decides retry, human-input and executable requests. The GUI hosts don't, so `yolo` and `never` mean different things per host.
   - Rule that prevents it: "Request is decided by the session's one authority in core, atomically with `request.opened`; hosts only present and send the human's decision."
2. **Output and verdict logic in host hooks, and presentation inside runs.**
   - Where: `openWorkflowOutput` changes a run's outcome from the CLI or desktop (`executeAgent.ts:224-231`, `cli/commands/workflow.ts:375`, `desktop/main/desktopAgentLaunch.ts:61`). Meanwhile file-open and PDF presentation run inside every documents run, children included.
   - Rule that prevents it: "Output is the documents plugin's facts; a verdict is committed in core before `run.end`; hosts react to `output.produced`."
3. **Session or run state in module slots and WeakMaps.**
   - Where: goal grants in a module WeakMap (`src/tools/goal/goalAutoApproval.ts:25`, lost on resume), the Codex/Claude registries (a `WeakMap` keyed by `RunRegistry`, `src/tools/agentCliSessionStores.ts:14`), and the agent catalog as module variables (`src/agent/index/agentRegistry.ts:63-70`, with about 21 defensive loads).
   - Rule that prevents it: "State has exactly one lifetime owner and is a Layer there (process / session / composition / run)."
4. **Runner-up: a run's input.**
   - Where: `ToolUseFollowUpQueueManager` is a second in-process owner of a run's input, and, until #13348 made the claim per run, `FollowUps` read from context let a workflow child release its parent's lease.
   - Rule that prevents it: "Input belongs to its run's entry, passed explicitly."

### Comparison with the reference designs

**deepseek-harness.** Its core nouns are:

- plugin (Cordis), `ctx` service registries, seam (definition / provider / consumer), profile and bundle, revisioned preset;
- Session (log plus persistence generations) and SessionEvent, with projections (`ctx.sessionProjections`);
- Agent (live handle) plus AgentLoop (driver), scope (per-agent registration), lineage;
- turn, step and round; inbox; goal; human command.

TeXRA lacks or misnames several of these:

- **Seam / "where new behavior goes" table:** the proposed set has no noun for the tables.
- **Inbox:** no noun in the proposed set.
- **Turn / step:** crossed, as described above.
- **Command vs session event vs live agent event:** TeXRA spells these `RuntimeRequest`, `SessionEvent` and `AgentEvent`.
- **"Model-visible means logged":** not stated.

The harness's preset recovery uses the current definition by id. TeXRA's proposed definition pin is stricter.

**Pico5.** Its core nouns are:

- Session (one mutation line) ⊃ Conversation (parent vs owner) ⊃ Entry;
- Task (durable state machine with kinds);
- Submission and inbox;
- Document and Definition (plugin-owned durable state);
- registries: owner, generation, snapshot (lazy per-owner pin per invocation), cutover, drainage, a recorded offered set, and built-in core tables vs extension registries.

TeXRA equivalents:

- Session ≈ per-root publisher; Conversation ≈ root run, which TeXRA doesn't name.
- Task ≈ Run plus driver. `PLUGIN_DRIVERS` reintroduces Pico's task kinds under another name, so name it honestly.
- Submission ≈ Input, which is missing.
- Document ≈ move 2's `PLUGIN_EVENT_ARMS` with fold slices (goal, inquiry, `run.fact`). TeXRA has no noun for it, and the plugin note's "plugins own no durable state" is already false.
- Generation / pin / drain ≈ the `Compositions` LayerMap refcount. TeXRA pins eagerly per run where Pico pins lazily per invocation.
- Parent vs owner: TeXRA conflates them (see the split under (b)).

**Open question worth flagging.** Nothing forces a new contributor to learn the directory mapping, and today it is skewed:

- `installProcessRuntime` and `SessionRequests` live under `src/controllers/session/`.
- The `RunLedger` interface is in `src/shared/session/`, while its implementation is in `src/agent/runtime/`.

The minimal-set table's owner column is the only thing that would fix that. It should live in one README.
