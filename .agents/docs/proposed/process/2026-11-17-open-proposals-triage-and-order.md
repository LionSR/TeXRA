# Open proposals: what is left, who decides, and the order

Date: 2026-11-17, rewritten 2026-11-19
Status: proposed

A reading of every note under `.agents/docs/proposed/` at `main` `8439d64`
(2026-11-19): what each still asks for, which waiting items were decided and
on what basis, which stay with the owner, and the order that follows. It is a
snapshot for planning. The notes stay the owners of their items; when one of
them and this note disagree, fix this note or delete it.

The 2026-11-17 version of this note read `c78e9f9`, 59 commits earlier. Its
five defects are all fixed (#15018, #15024, #15026, #15071), every entry of
its "In flight" list has merged, and its table was wrong for every note it
covered, so it is replaced, not patched.

How it was made: four read-only passes, one per area, read each of the 49
other notes in full and checked every item it lists as open against the tree
by name, trusting neither the note's line numbers nor its own "done" and
"open" labels. A second pass read, for each item waiting on a decision, what
the note itself recommends, whether taking it makes data an install holds
unreadable, changes something a person sees by default, needs a provider key
or a third party, and whether a revert restores it. Items counted done from
a note's own "landed" list were confirmed by the symbol's presence, not by
behaviour.

## What is left

| Area                                       | Notes | Do now | Waits on a decision | Needs evidence | On hold |
| ------------------------------------------ | ----- | ------ | ------------------- | -------------- | ------- |
| Storage and row shapes                     | 12    | 16     | 18                  | 4              | 3       |
| Run runtime and architecture               | 11    | 17     | 17                  | 7              | 8       |
| App, hosts, UI, LaTeX, programs, features  | 16    | 21     | 37                  | 6              | 7       |
| Model layer, SDK surface, release, process | 10    | 8      | 20                  | 8              | 14      |

About 60 items of work after overlaps, about 90 decisions before this note's
rulings below, about 25 items that need a measurement, a spike or a live
provider key, and about 30 on hold with a stated reopening event. Decisions
outnumber work: what limits progress is no longer hands.

The notes are stale as a rule. None is right throughout, and more than
twenty items still marked open are done. One note was finished and is
deleted: `architecture/2026-11-09-decisions-read-the-log-not-the-view.md`
(the one decision reader of the view left, `submitFollowUp`, stays by the
ruling in #14986). Correcting the other notes item by item is step 5 of the
order, after the work in flight has landed and edited them.

## In flight

Started on 2026-11-19, one pull request each:

- Requests and input: a decision wakes a run nobody holds; one send verdict;
  a run's input read once per step (peers round 3, findings 1 and 2; PRD
  row 8; nothing held, row 14).
- One writer per project file, and issue #15083 (`texra service stop`
  returning while the service still holds a project store).
- The terminal and the web paint the same row (four differences).
- Storage: one connection module under both stores; bounded read retry and
  event hub (store review S5, F5, F6, F11; nothing held, rows 19 and 20).
- Run lifecycle shapes: one `RunOpening`, a child's end report from its
  launch, typed failures, rejection reasons nothing reads.
- The `latex-extract` plugin goes (ruled by the owner on 2026-11-14 and never
  done), and the LaTeX status becomes one record keyed by tool.
- CLI and memory tool: the memory tool's two line counts, one usage-logging
  sentence, one CLI entry, the CLI's roots.
- The TUI validator waits on state, not on the clock.
- Programs phase 4: an installed plugin carries programs. The programs note
  records it as accepted (its ruling 7); it had been treated as waiting on
  that note's question 1, which holds only two slices of phase 5.

## Decided on 2026-11-19

The owner's instruction for this pass was to use best judgment. Each ruling
below is reversible by a revert, makes no data an install holds unreadable,
and changes no default a person sees unless it says so. The basis is named:
the note's own recommendation, a rule in `AGENTS.md`, or the code as it
stands. The owner can overturn any row; the work it unblocks is queued, not
started, unless listed under "In flight".

**Do it.**

| Item                                                                                               | Basis                                                                                                                                                              | Size |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `run.steps` is a `ScopedRef`, as `run.model` is (session surfaces 1)                               | the note's recommendation                                                                                                                                          | S    |
| `RunCell.commit` reduces a batch once, inside the store's job (session surfaces 2)                 | the note's recommendation                                                                                                                                          | S    |
| `SessionKey` reads only `storage`; the eight-field copy of the roots goes (store debts A6)         | the note's recommendation                                                                                                                                          | S    |
| The six cause-shape assertions assert rows and behaviour (store debts C6)                          | the note's recommendation                                                                                                                                          | S    |
| A malformed draft from our own code is a defect, not `DatabaseWriteFailed` (store debts A8)        | `AGENTS.md`: trust data from code you control                                                                                                                      | S    |
| The two module mocks in `sessionEvents.vitest.ts` go (store debts C7)                              | the note: the `SqliteClient` mock only spreads the original; `src/test-kernel/AGENTS.md`: the `leanServerPool` one mocks a repository module                       | S    |
| A child's delivery stores `wallTimeMs` as a number and cuts its prompt (tool card 3, run end 1)    | the note's recommendation; one `followup.queued` bump, cheapest before the freeze                                                                                  | M    |
| A model switch for a run not held here is a queued row the loop applies or refuses (R2, R7)        | the note's recommendation; `/model` is already a queued row                                                                                                        | M    |
| The full `validate:tui` runs nightly, once it waits on state (test launches)                       | the note's recommendation; the nightly now announces a failure (#15078)                                                                                            | S    |
| M4 (the plan tool reads its fact row) and H9 (one host route) return to the order                  | the programs note's recommendation                                                                                                                                 | M, L |
| TeXRA's plugins import nothing from `./host`: each of the twelve helpers moves or stops being used | `AGENTS.md`: the app reaches the harness through its entries; decided per helper, not as a block                                                                   | M    |
| The MCP client name is the app's, passed as data (general package, D2)                             | `AGENTS.md`: a general core takes the app's vocabulary as data                                                                                                     | S    |
| `./plugins` splits authoring types from the built-in plugins before the first publish              | after the publish it is a breaking change; needs a two-design comparison first                                                                                     | M    |
| Image limits are stated per protocol in `packages/llm`, as a table there                           | the note's recommendation for the owner; a table needs no llm-zoo release                                                                                          | M    |
| A finished run that takes a follow-up shows the status table's word; the header override goes      | `AGENTS.md`, UI anti-patterns: no render-time override                                                                                                             | S    |
| The key-pages link reads `KEY_PAGES` from a leaf module                                            | the option that changes nothing a person sees                                                                                                                      | S    |
| Request nouns come from one table keyed by request kind                                            | no decision was needed; only the badge's source is one                                                                                                             | S    |
| The file-tool text leaves the prompt of a run without file tools (I-C16)                           | the earlier triage's "safe at any time"; review as the resolved prompt                                                                                             | S    |
| R17 gets one kernel case that interrupts inside its handoff window                                 | the evidence of 2026-11-19 (`release-acceptance-rows`) covers either side and says the window itself is hit by no check; a small check is better than a waived one | S    |

The earlier version's list of work "safe at any time", read again on
2026-11-19:

- Landed in one pull request: `RunCell.commit` applies its batch once,
  inside the store's job; the key-pages links read `KEY_PAGES` from
  `packages/texra/src/shared/model/keyPages.ts`; the rejected-token notice
  is worded at its one follower; R6-T7 b, by correcting the store review
  (its codec ratchet is gone and SQL reads a payload field).
- Already on `main`: the tool-edit diff title (`toolEditDiffLabel`), the
  one symbol table (`MATH_SYMBOL_SPELLINGS`), the `script` tool's
  description (#15024), and the `model.useGoogleBackgroundResponses`
  deletion (#15081).
- Waiting for open pull requests on their files: store debts A6 and A8
  (`controllers/session/`) and deriving `referencedAggregates`
  (`shared/schemas/sessionEvent.ts`).
- Not to be done: the media classifier (below). Left to whoever owns the
  bundled prompts: I-C4, and I-C16 as ruled above. Left to the UI work:
  tooltip ids carried by the data.

**Keep what the code does; close the item.**

- A stop of a run no fiber drives commits its `run.end` with the stop
  (one-fact A6 proposed writing nothing). The harness guide and the spec
  state the current rule, and Stop is offered only on a run this process
  holds, so the path is reached by a cascade or a race.
- A terminal row at Stop for an in-flight call (tech debt D2): the note
  recommends today's rule.
- One turn per call on an agent-CLI process run (PR-1 compromises 1.2).
- `RunServices` and `PlatformServices` stay on `./host`; the entry's header
  states the exception.
- A request with no surface attached waits for the next one (CLI service
  note); the code already does this.
- The launch cap counts in memory; the later record ("kept: a policy
  decision") stands over the earlier note.
- The three behaviour changes the nothing-held note landed and asked to have
  confirmed stay. Each is one commit to revert.
- `edgesOf` keeps a case per kind: its own comment gives the reason.
- `LabelsRootRuns` stays a `Context.Reference` with a default.

**Do not do it.** Each is recorded in `.agents/docs/refuted-candidates.json`
(2026-11-19), with its symbols and a `ruling` anchor to this section.

- A shared media-capability classifier: the two notes disagree and the
  verification scored it at zero net elements.
- Moving the transcript's pure functions out of `sessionViewUpdate.ts`
  (store debts A9): a move for tidiness alone.
- A version per current-value family, forward steps and a guarded
  `ADD COLUMN` before the freeze (store review S1, S4): the PRD and the
  storage-format rule already say no.
- An execution port on `AgentPlatform`: no consumer.
- Unifying the CLI approval stack with the web request panels: both concrete
  forms are refused already; it reopens with a new design.
- Replaying another protocol's assistant turns: the code rejects, and the
  design note lists it as a non-goal.

**Not ruled, though a note leans.** Left as it is until someone argues it.

- "Busy" as the answer to a second `lake build` on a root. The note designs
  it; the earlier triage kept it for the owner; a caller that waits is the
  friendlier default for an agent.
- Regenerating the golden store only on `main` by a post-merge job (store
  review F14): a pull request that commits no dump fails the suite that
  reads it until the job runs, so the design has a gap.
- The script delivery's `stopped` literal: one note renames it, the delivery
  note keeps it. The delivery union it rode with was kept as one struct
  (2026-11-19), so it stays as it is.
- `definition.ts` ending a run through `readCause`; the TUI's local rows
  through `LocalSession.emit`; a slot-agnostic `rowDefault` export: none has
  a recommendation, and none blocks other work.

## The owner's

What is left for the owner falls into five kinds. Nothing below was touched.

**It makes data an install holds unreadable or unreachable.**

- The two-DDL split of the stores. `AGENTS.md` rules out copying the old
  data forward, so the choices are a new global file beside the old one or a
  "move it away" message, and either leaves today's settings, project
  records and input history unread.
- A bounded `quick_check` at open that moves a failing file aside (store
  review F12). A file moved aside stays aside.
- Renaming `texra.db` and the `TEXRA_*` variables to app-supplied names.
  Whether `release/0.40` writes a `texra.db` was not established; if it
  does, the rename is of this kind.
- Programs phase 5 and its question 1 (are project and user skill
  directories still loaded; are an installed plugin's agents kept as
  sub-runs or not loaded). Phase 5 deletes the agent catalog and changes
  `run.config`, so custom agents stop working and older runs read as an
  earlier build's. Only two of its slices wait on the question.

**It changes what a person gets by default.**

- Model access: which models the launcher lists; whether a delegation may
  name a model the list hides; what the GUI does when a plan is turned on
  while signed out.
- Subscriptions: which credential serves a person who holds both a plan and
  a key (it decides who is billed); dropping "Experimental" from the ChatGPT
  plan; the four features of that note (limit reset time, helper model,
  first-run list, paste-the-URL sign-in).
- Windows: accept that a second window or the CLI is rejected, or build the
  named-pipe service first.
- What a saved `endpoint.<provider>` means after a backend changes protocol.
  It is urgent in one respect: `config.json` is additive-only from 1.0, so
  the choice is cheap only before the release.
- Whether `history delete` waits for its own cleanup; `StartOptions.continues`;
  the meaning of `plan: null` on a rejected plan; the facts-on-the-result
  shape for tools; the `ToolFileAttachment` content union for outside
  plugins; who owns the session view; how `texra run` and the listings
  attach to the store's holder.
- Wording and small display choices with no recommendation anywhere: one
  word for a cancelled run (the headless word is pinned public vocabulary),
  "Pass" or "Revision", the build-folder layout, the dependency banner on
  the desktop, the terminal title's scope, the cost segment, the `superYolo`
  tone, the queued-message count, the ended-run line, the request badge's
  source, how a delegated Claude Code call is labelled, the five prompt and
  copy texts of round 3. A draft of each can be prepared for the owner to
  pick from.

**It needs a provider key or a third party.**

- Live acceptance on the Anthropic route, `npm run test:live`, and the
  journeys.
- Whether a tool-use turn on a background-capable route should stream in the
  foreground. Today every GPT turn on the HTTP route goes out as background
  work; the setting that claimed otherwise was deleted in #15081.
- OpenAI: whether a background response created without a stream can be
  read with one. Google: a capture of `requires_continuation` and of
  `incomplete`, before either design is chosen.
- The keyed wire cassettes; the reply-document recovery counts; the xAI
  transcription question; the transcription credential.
- Which copy of the server half is deployed; who owns the GitHub account-age
  rule; whether the CI action reads the inline allowed-tools list; the
  Claude plan route, which waits on Anthropic's written answer.

**It is a release step.**

- R12's "old paths deleted" clause. Its mechanical clause is `npm run gate`,
  which passes; the acceptance evidence of 2026-11-19 says the rest "needs a
  person", and no check decides it.
- The date of the storage freeze, and zeroing the row versions with it.
- The first npm publish and the Trusted Publisher for both names.
- An SDK changelog section or file.

**It is a feature.** The UX roadmap's selection action, saved prompts and
cross-tab filter; the two Unix ideas of the programs note; tools as
command-line programs (the programs note recommends accepting, `arxiv`
first, as its phase 7).

## Order

1. **Land what is in flight**, one pull request at a time, each checked on
   the tree merged with `main` before the next: two pull requests that were
   each green broke `main` together on 2026-11-19.
2. **The work this note's rulings unblock**, grouped by the files it shares:
   stop and resume (one stop-or-failure decider, one rejection decider per
   resume, the model switch as a queued row); the store's small rulings;
   the app's entries (`./host` helpers, the MCP client name, the
   `./plugins` split); the dispatcher split (tech debt T1, PRD row 10),
   which waits for the requests work to leave the run loop. The row-version
   pass is done (2026-11-19): `finishEvidence` and `refusalEvidence` were
   already gone (`model.message` v21, #15017); the delivery stores
   `wallTimeMs` and its prompt as a cut attribute (`followup.queued` v11);
   the delivery union was compared and kept as one struct
   (`refuted-candidates.json`, `DELIVERY-union-on-family-and-outcome`); and
   the recorded request is held under the `context.blob` version (store
   debts B5).
3. **Programs.** Phase 4 is in flight. Phase 5 follows on the owner's answer
   to question 1; its slices that do not depend on the answer can be
   prepared.
4. **Evidence that needs no key**: the `unified-latex` spike, the tar
   stream spike, the `EARLIER_RUNS` scan and the cold-read measurements, the
   packaged smoke before the banner script stops rebuilding `__dirname`.
5. **Correct the notes**: mark the stale items. Last, because every pull
   request before it edits notes. Done on 2026-11-19: the finished note is
   deleted, the items above that are not to be done are recorded in
   `refuted-candidates.json` (whose entries were re-read against the code),
   and the ledger's publishing line (D11) is fixed.
6. **The freeze and the first publish**, on the owner's date, after the two
   live routes pass.
