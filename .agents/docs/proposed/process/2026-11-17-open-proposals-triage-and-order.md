# Open proposals: what is left, who decides, and the order

Date: 2026-11-17
Status: proposed

A reading of every note under `.agents/docs/proposed/` at `main` `c78e9f9`:
how much each still asks for, which of its waiting items need the owner,
which areas a later step deletes, and the order that follows. It is a
snapshot for planning. The notes stay the owners of their items; when one of
them and this note disagree, fix this note or delete it.

How it was made: each note was read in full, and every item it listed as
open was checked against the tree with a whole-word search and a read of
the code it cites. The notes themselves were corrected in the same change,
so the numbers below are the notes' own. An item that is "partly done"
counts as open, and the notes say which items could not be established. The buckets under "Who decides" apply rules
the repository already states; a lean written here is not a ruling.

## What is left

About 192 items: about 103 that are code work, about 64 that wait on a
decision, and about 25 on hold. A first count from the notes' text alone,
before they were corrected, gave about 230. Some are counted twice (see
"Overlaps").

| Note                                                                                                                                 | Work | Waits on a decision | On hold |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------- | ------- |
| [harness general-package design](../architecture/2026-10-21-harness-general-package-design.md)                                       | 6    |                     | 2       |
| [tech-debt target designs](../architecture/2026-10-27-tech-debt-target-designs.md)                                                   | 3    | 1                   |         |
| [harness 1.0 release PRD](../architecture/2026-10-28-harness-1-release-prd.md)                                                       | 6    | 2                   | 1       |
| [one fact, one representation](../architecture/2026-11-03-one-fact-one-representation.md)                                            | 4    | 1                   |         |
| [session store review](../architecture/2026-11-03-session-store-review.md)                                                           | 6    | 2                   | 1       |
| [root designs, Effect-native](../architecture/2026-11-05-root-designs-effect-native.md)                                              | 6    |                     |         |
| [CLI service root causes](../architecture/2026-11-06-cli-service-root-causes.md)                                                     | 4    |                     |         |
| [root designs, PR-1 compromises](../architecture/2026-11-06-root-designs-pr1-compromises.md)                                         | 3    | 1                   |         |
| [programs, not agents](../architecture/2026-11-06-programs-not-agents.md)                                                            | 4    | 2                   |         |
| [red flags round 2 and the order](../architecture/2026-11-07-red-flags-round-2-and-order.md)                                         | 1    | 2                   | 1       |
| [red flags round 3, the plan](../architecture/2026-11-07-red-flags-round-3-plan.md)                                                  | 4    | 1                   | 11      |
| [agent data: one row per fact](../architecture/2026-11-09-agent-data-one-row-per-fact.md)                                            |      | 2                   |         |
| [decisions read the log, not the view](../architecture/2026-11-09-decisions-read-the-log-not-the-view.md)                            | 2    |                     |         |
| [harness against the peers, round 3](../architecture/2026-11-11-harness-against-pi-durable-and-deepseek-round-3.md)                  | 6    | 1                   |         |
| [nothing held across a wait](../architecture/2026-11-14-nothing-held-across-a-wait.md)                                               | 7    | 5                   |         |
| [desktop and extension UX roadmap](../feature/2026-09-26-desktop-and-extension-ux-roadmap.md)                                        | 6    | 1                   |         |
| [orchestrator over projects](../feature/2026-09-26-orchestrator-over-projects.md)                                                    |      |                     | 5       |
| [Claude Agent model route](../feature/2026-10-31-claude-agent-model-route.md)                                                        |      | 4                   |         |
| [runtime performance measurement record](./2026-09-21-runtime-performance-measurement-record.md)                                     |      |                     | 3       |
| [SDK npm publishing](./2026-11-05-sdk-npm-publishing.md)                                                                             |      | 4                   |         |
| [fewer processing options](../simplification/2026-11-03-fewer-processing-options.md)                                                 | 1    | 1                   |         |
| [storage, errors and stop paths](../simplification/2026-11-03-storage-errors-and-stop-paths.md)                                      | 12   |                     |         |
| [store and test-support debts](../simplification/2026-11-04-store-and-test-support-debts.md)                                         | 6    | 8                   |         |
| [session surfaces, ad hoc](../simplification/2026-11-10-session-surfaces-ad-hoc.md)                                                  |      | 5                   |         |
| [llm history lowering and reply-document recovery](../simplification/2026-11-14-llm-history-lowering-and-reply-document-recovery.md) |      | 2                   | 1       |
| [reading a failed cause](../simplification/2026-11-14-reading-a-failed-cause.md)                                                     |      | 3                   |         |
| [tool card result and delivery shapes](../simplification/2026-11-14-tool-card-result-and-delivery-shapes.md)                         | 1    | 2                   |         |
| [unified-latex for LaTeX extraction](../simplification/2026-11-14-unified-latex-for-latex-extraction.md)                             |      | 1                   |         |
| [data shapes left after the audit](../simplification/2026-11-15-data-shapes-left-after-the-audit.md)                                 |      | 3                   |         |
| [global store, values only](../simplification/2026-11-15-global-store-values-only.md)                                                | 4    |                     |         |
| [host rules and app facts with two owners](../simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md)                 | 3    | 3                   |         |
| [layer misplacements left open](../simplification/2026-11-15-layer-misplacements-left-open.md)                                       | 4    | 4                   |         |
| [run-end audit left open](../simplification/2026-11-15-run-end-audit-left-open.md)                                                   | 2    |                     |         |
| [llm provider wire boundary](../simplification/2026-11-16-llm-provider-wire-boundary.md)                                             |      | 1                   |         |
| [one writer per project file](../simplification/2026-11-16-one-writer-per-project-file.md)                                           |      | 1                   |         |
| [SDK readiness audit](../simplification/2026-11-16-sdk-readiness-audit.md)                                                           |      | 1                   |         |
| [test launches wait on state](../simplification/2026-11-16-test-launches-wait-on-state.md)                                           | 2    |                     |         |

[Copilot possibilities](../feature/2026-10-26-copilot-possibilities.md) and
[natives and owners left open](../simplification/2026-11-15-natives-and-owners-left-open.md)
ask for nothing: the first records options, and every item of the second
has landed. The second stays because `refuted-candidates.json` cites it as
the source of a ruling.

### Overlaps

- Red flags round 2 is nearly finished: each of its lane steps now names
  the catalogue row that records it, and one item of code work is left
  (`childEndReport` switching on the child's kind). Round 3 holds the rest.
- The dispatcher split is in the tech-debt note (T1) and the PRD (row 10).
- The global store split is in the storage-errors note (§1) and its own
  note.
- The follow-up rule for a one-shot root is in the decisions note and in
  round 3 of the peers note; #14986 ruled it (keep reading the view).
- The seven LaTeX `*Path` fields are in the data-shapes and host-rules
  notes.
- The stop and resume rows left in the one-fact note are the storage-errors
  note's §5.

## Five defects in the list

These are behaviour, not structure, and none sits in an area a later step
deletes. They go first.

1. The run state does not keep a turn's end (peers round 3, F4).
2. The desktop terminal drops input typed before the shell starts (run-end
   audit, 2).
3. A full disk reported by SQLite is not classified as `disk-full` (session
   surfaces; reproduce first).
4. Deleting a run does not delete its children (nothing held across a
   wait, "The view").
5. No limit on a service that crashes at every start (PRD, row 6).

## Areas a later step deletes

Work here is thrown away. Leave these until the step named has landed or
its question is answered.

| Area                                                                                                                                                                 | Deleted or rewritten by                                       | Items to leave                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agents directory, its index and schema, teams, workspace selection, customize, the bundled skills, the `latex-extract` plugin, the agent list of the launch form | programs, phase 5                                             | M9 (catalog follower); the `AgentConfig` union; the Agents › Advanced switches; composer and launch-form items of the UX roadmap; a compatibility alias for `IS_ANTHROPIC_MODEL` |
| Tools that could be a command-line program (`arxiv`, Zotero)                                                                                                         | programs, phase 7, if accepted                                | card, label and schema polish for those tools                                                                                                                                    |
| The database layer's open modes and per-mode busy rule                                                                                                               | the global store split                                        | storage-errors §1; session store review S5 and S6                                                                                                                                |
| `sessionViewUpdate.ts`, `sessionInputsLayer.ts`, `projections.ts`                                                                                                    | the unanswered question of who owns the view                  | listing narrowing; `SessionViewAccessShape.run` narrowing; the rollup count; `operationalLatestLine`                                                                             |
| The webview's hand-written frames and message dispatcher                                                                                                             | `effect/rpc`, if its bundle check passes                      | round 2 steps 3.4 and 3.5                                                                                                                                                        |
| The golden store and the crash-conformance test support                                                                                                              | the row-version changes and the freeze, which regenerate both | store-debts C1 to C4 and C8; the regeneration job (F14)                                                                                                                          |
| The similarity recovery for reply documents                                                                                                                          | llm-history note, stages 3 to 5                               | any tidying of that code                                                                                                                                                         |
| The `followup.queued` row                                                                                                                                            | one version bump shared by three notes                        | changing it once per note                                                                                                                                                        |

## Order

**0. Five answers that decide the table above.** Programs question 1
(project and user skill directories; agents an installed plugin carries);
programs question 2 (tools as command-line programs); who owns the view;
whether a second window on Windows is rejected for now; whether the freeze
waits for programs phase 5.

**1. The five defects.** Three are in flight (see "In flight").

**2. Two lines in parallel.** They touch different packages.

- _Store (harness)._ The global store split, with the new file created
  beside the old one. Then the rest of storage-errors §1. Then the
  row-version changes in one pass: delete `finishEvidence` and
  `refusalEvidence`; one `followup.queued` bump for the wall time and the
  delivery union; the request-blob version. Then the unreadable-run
  classifier (§2), then errors, stop paths and the model-call failure path
  (§3 to §6), which takes the rows left in the one-fact note and F1 and F5
  of peers round 3.
- _Programs (app)._ Phase 3 (the two `lean4` programs), phase 4 (installed
  plugins carry programs; it must precede phase 5), phase 5. Phase 5
  changes a stored shape (`run.chat`) and two public signatures (`agent()`,
  `StartRequest`), so it is on the path to the freeze and the SDK release,
  not after them.

**3. Evidence, in dependency order.** The llm cassettes (tech-debt M6 to
M8) first: the scripted server they need is also what the model socket
(nothing held, row 18) and the OpenAI background submit check need. Then
the `effect/rpc` bundle check, the `unified-latex` spike, and the
reply-document route counts.

**4. The freeze.** Reset row versions and drop retired row kinds,
regenerate the golden store, remove the duplicated test support,
`storage:freeze`, the R1 to R24 acceptance, publish.

**After the freeze.** The UX roadmap, the full TUI validation in CI, the
packaged smoke launcher.

Work with no place in the order, safe at any time: store-debts A6 and A8; `RunCell.commit` applying a batch once; deriving
`referencedAggregates`; one string for the tool-edit diff title;
`KEY_PAGES` in one module; the shared wording of the rejected-token
notice; the one symbol table; the media classifier; tooltip ids carried by
the data; prompt items I-C4 and I-C16; the `ScriptTool` description; the
spec wording R6-T7 b; deleting `model.useGoogleBackgroundResponses`.

## In flight

Started from this note on 2026-11-17, one pull request each:

- #15018: a full store reads as disk-full; a run's deletion takes its
  children (defects 3 and 4).
- #15019: the decided items left in the fewer-processing-options note.
- #15020: programs phase 3, the `lean4` plugin's two programs.
- Not yet a pull request: the turn end the run state forgets with the
  smaller items of peers round 3 (defect 1); the desktop terminal's early
  input with UX roadmap items 3, 5 and 6 (defect 2); §3 and §4 of the
  storage-errors note; the llm cassettes (tech-debt M6 to M8).

Not started because each needs a word from the owner first: the schema
half of the global store split (its code half is in: the global store has
its own layer) and the row-version changes (what happens to the old file);
§5 and §6 of the storage-errors note (after §3 and §4 merge, same files);
a limit on a service that crashes at every start (no design); programs
phases 4 and 5 (question 1).

## Who decides

About 130 entries once sub-questions are counted. The rules applied: before
1.0 a stored format, a public name or a behaviour may change when that is
simpler, as its own commit under "Needs your eye"; no compatibility reader
and no migration; delete what nothing reads; a rename or re-layout for
tidiness alone is rejected and recorded; nothing speculative; a note's own
recommendation stands unless something argues against it.

**Already ruled or overtaken (about 10).** The one-shot follow-up rule
(#14986). The `entry-files` count that blocked the dispatcher split: no
such check exists in the tree. "S4 first, or keep `owner_id`": the column
is gone. The Google `replayableHistory` question: Google calls it. SDK
publishing questions 1 and 2: the code is on `main`. Whether `texra.*` keys
stay: no stored byte changes.

**The rules decide; do it (about 40).** The row-version changes above. The
global store's old file stays where it is and the new one is created
beside it. No upcaster frame until the first upcaster. `IS_ANTHROPIC_MODEL`
goes with no alias. `facts` and `consumedFollowUps` are returned by
`execute`, not collected through `ToolContext`. The golden store is
regenerated by one job after a merge. The rest are the "safe at any time"
list above. Each change a person can see is its own commit under "Needs
your eye".

**The rules decide; do not do it (about 13).** A terminal row for an
in-flight call at Stop (tech-debt D2). A version per current-value family
(S1). A second turn on a process run. Moving 110 lines for no net change
(store-debts A9). `run.steps` as a `ScopedRef`. The `default` half of
`edgesOf`. `formTitle`. W3's alternative, a `list_cost` column and the
third slice of #14728. The `AgentConfig` union before phase 5. Issues for
the store review's slices.

**Not a decision; evidence first (about 15).** Measurements: PRD R12,
`EARLIER_RUNS`, reply-document route counts, the code-mode fallback list,
the result-reader comparison. Spikes: `unified-latex`, `effect/rpc` in the
webview bundle, tar extraction as a stream. Reproductions: SQLite full;
whether `crashAt` needs only `projection_state` cleared. A check against
the live API: OpenAI background submit without streaming. A scripted
server before the model socket. A design: how the usage log closes;
`PreventSchedulerYield`.

**The owner's (about 37).**

- _Behaviour._ A second window on Windows. Replaying another protocol's
  turns. What a saved `endpoint.<provider>` means after a protocol change.
  What `plan: null` means when an approval is rejected. Programs questions
  1 and 2. In nothing held: busy as an answer to a second `lake build`; a
  failed refresh no longer signs out; a launcher's interruption is not a
  `user` stop; who owns the view. Whether `history delete` waits for its
  own cleanup. The dependency banner on the desktop. Labels for delegated
  Claude Code calls. `file.write` as a public request, and a save while
  the service is away. The transcription credential. `StartOptions.continues`.
  Whether `definition.ts` re-fails a cause. Whether a script's awaits set
  the order. Where selection-first and saved prompts live in the composer.
  Which place decides the GitHub account-age rule.
- _Copy._ The local banner and the missing-key wording. The three display
  rules of the LaTeX card. "Ready" and "Needs approval" against the run
  status words. Prompt items I-C1 and I-C5. An SDK changelog.
- _Only the owner can act._ An Anthropic key and budget for acceptance.
  The first npm publish and the Trusted Publisher. Whether the CI action
  reads the inline allowed-tools list (S9). Which tree the 0.40 server runs
  (W7). Asking Anthropic about the Claude plan route. The full TUI
  validation in CI. The date of the freeze.

**On hold with a stated reopening event (about 16).** These are answered
and should not be listed as waiting: the `session/` directory merge, the
builtins fence, timed follow-ups, `defineTool({ deferred })`, a storage
port, workspace import, the orchestrator, Copilot, the performance
readings, a background capability from llm-zoo, the bounded closer, and a
fourth protocol reopening the history-walk design.
