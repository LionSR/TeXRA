# Round 3: the red flags left, ordered by _A Philosophy of Software Design_

**Status:** proposed, 2026-11-07. Evidence:
`.agents/docs/evidence/2026-11-07-design-red-flags-round-3/` (areas P to V,
read at main `4e32bb9`). Rounds 1 and 2 and their order:
[root designs, Effect-native](./2026-11-05-root-designs-effect-native.md),
[round 2 and the order](./2026-11-07-red-flags-round-2-and-order.md).

## What has landed since the round-2 order

Packages B (#14791, less step 3.3), C's first half (#14790), D (#14792), E
(#14785, #14787, #14788, #14793), A's first half (#14789) and the document
task's follow-up (#14713) are on main. Open: A's #14794 and one more A PR,
C's 4.3, B's 3.3, and #14795 (P1, below). Round 3 found what is left.

## How this note orders the work

Ousterhout names three symptoms of complexity (ch. 2): change amplification,
cognitive load and unknown unknowns. The last is the worst, because nothing
tells the next developer what they broke. The order below follows the
symptoms, worst first:

1. **Unknown unknowns.** Code that is already wrong, or a copy that has
   already drifted, so the next change breaks something silently.
2. **Cognitive load.** What a reader must hold in mind to make one change:
   three entries to write one tool, a setting typed by its caller.
3. **Change amplification.** One decision written in several places, so a
   change edits all of them.

Each finding is then traced to the principle it breaks, and the findings
that break one principle in the same way share one decision. For each
decision, two designs are compared and one is chosen (ch. 11, "design it
twice").

## 1. Unknown unknowns: wrong now, or drifted

| Id  | What is wrong                                                                                                                                                                                                                        | Principle                                                      | Fix                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| P1  | The CLI read a malformed telemetry opt-out as consent, and a misspelled approval policy as the user-wide Auto-approve.                                                                                                               | Define errors out of existence (ch. 10)                        | **#14795**, open                                                                                                          |
| S1  | The release gate reads the newest `validate` run. A nightly run skips the static checks, the build and the e2e suites but still reports `validate` green, so a failed push run can be released.                                      | Define errors out of existence                                 | The gate reads the push run's required jobs; the release jobs stop re-running checks; `build` stops carrying a type check |
| U5  | Storage keeps its own copy of llm's finish reasons, media kinds and content part kinds, with no compile-time check that the copies match. A new llm finish reason compiles, then fails while storing a turn that was already billed. | Two representations without the check that keeps them equal    | Three `AssertNever<Exclude<…>>` lines in `agent/runtime/storedTurn.ts`, as the provider enums already have                |
| T1  | The "new document task" template's loops run when the agent is created, not when the task runs, so it writes an agent that asks for 17 documents named `{`, `I`, `N`, …                                                              | Information leakage (a two-pass render every author must know) | A template is rendered once, at run time; creation copies it with its name filled in                                      |
| T2  | Customizing a bundled task copies its YAML but not the files its `task.files` names, so `paper2poster` and `paper2slide` lose their templates, with only a log warning.                                                              | Information leakage, silent degradation                        | The copy takes the agent and its bound files as one unit, and the digest covers them                                      |
| P7  | A subscription session that cannot be read loses its "sign in again" fact across three error wrappings.                                                                                                                              | Define errors out of existence                                 | One error with `needsReauth`, decided where `credentials.ts` already decides it; lands with O3                            |
| U1  | Which grant an approval request offers is decided in 9 places across 3 packages, and they disagree: a bash prompt raised by a hook hides "approve commands", while an edit raised the same way offers it.                            | Information leakage; special code in the general mapper        | One function in the harness decides the offer from the request; hosts render it                                           |
| P2  | The scope rule for config tiers is written twice, and for telemetry the settings view and the runtime disagree.                                                                                                                      | Two representations                                            | `Settings` reads through `config.get` and states no tier rule                                                             |
| R1  | The run-loop suites fake the model by re-implementing `ModelInvoker`, and the copy has drifted from the rows the real one writes.                                                                                                    | A fake that is a second implementation                         | The real `modelInvokerLayer` over a scripted `Model`, already done inside `RetryState.vitest.ts`                          |
| R3  | The TUI's hand-built `SessionView` has drifted from the view update: six required fields are `undefined`, so every fixture run offers `compact` and `fork`.                                                                          | A helper restating production rules                            | Build the fixture view by applying rows through the real view update                                                      |
| R4  | The golden store generator re-implements the row codec.                                                                                                                                                                              | A second implementation                                        | Write through `rowCodec`                                                                                                  |
| T6  | The creator agent's reference docs are a hand-kept copy of the tool registry and have drifted: they say scripts have "no imports", and `self` is missing.                                                                            | Two representations                                            | Generate the tool list from the registry, or check the names against it                                                   |

## 2. The decisions behind the rest

### 2.1 A vocabulary has one owner, which exports it as data (information hiding, ch. 5)

**Findings:** U1, U2, U3, U4, U6, P3, P4, P5, P6, T3, T4, T5, T7, R5, S3,
S4, S7, S8, S9.

A fact such as a grant, an approval policy, a credential's origin, a display
order, a setting's type, the `<documents>` reply format or the list of lint
aliases is spelled wherever it is used.

- **Design A:** a shared constants module that everyone imports. It moves
  the copies into one file but gives the fact no owner. A shallow module of
  facts is a pass-through by another name.
- **Design B (chosen):** the module that owns the decision exports it as data,
  and every reader derives from it. Where order matters, the order is a
  `Record<Member, …>` keyed by the literal set, so a missing member fails to
  compile; this is what U4's `satisfies readonly K[]` cannot catch. Examples:
  - **P3:** a setting is read by its catalog row (`SettingRow<A>`), not by a
    string key and a caller-supplied type.
  - **T3:** the recipe that parses the `<documents>` reply also renders its
    format into the prompt.
  - **S3, S7:** the lint alias list and the list of harness entries are
    generated from `tsconfig` and `package.json`.

### 2.2 Errors are defined out of existence at the boundary (ch. 10)

**Findings:** P1, P7, Q4, Q5, S1, T1, T2, U5.

Each reader catches the failure and picks its own fallback, so readers
disagree, and some fallbacks fail open.

- **Design A:** keep the per-reader handling and test each reader. That
  needs more tests and keeps every copy.
- **Design B (chosen):** decide each case once, where the value enters:
  - one decode with one reading;
  - one error type that carries the fact a caller branches on (P7's
    `needsReauth`, Q5's one launch refusal);
  - a compile-time gate where a runtime check would come too late (U5).

  Q4's app-only errors, `Internal` and `Invalid`, leave the harness request
  contract for the app's own bridge.

### 2.3 A test fake is the production layer over a scripted edge (deep modules, ch. 4)

**Findings:** R1, R2, R3, R4, R6, R7, R8.

The test infrastructure has re-implemented the modules it exercises
(`ModelInvoker`, the tool dispatch, the view update, the row codec), and each
copy drifts.

- **Design A:** keep the fakes and add tests that catch drift. The testing
  budget forbids that, and it adds one more copy.
- **Design B (chosen):** provide the real layer, faked only at its edge:
  - a scripted `Model` under the real invoker;
  - the real `callRequests` for a test tool call;
  - rows applied through the real view update for the TUI fixture;
  - the codec for the golden store.

  The fake host stops reading through a module-level slot (R6). A suite's
  tier is decided by what it imports at run time, not by how its imports are
  spelled (R7).

### 2.4 An entry is the closure of one audience's task (deep modules, overexposure)

**Findings:** Q1, Q2, Q3, Q6, Q7, Q8, S7.

Writing one tool imports the harness root, `./plugins` and `./host`, the
last for 30 names. The store's write interface sits in every tool's context
type. 14 names are exported twice.

- **Design A:** one root entry for everything. Rejected: `./schemas` and
  `./transcript` must stay browser-safe.
- **Design B (chosen):** one entry per audience, each the complete set of
  names that audience needs, and each name in exactly one entry:
  - the root for an embedder;
  - `./plugins` for a plugin author, everything a tool needs, including
    `withLogChannel`, `Settings` and `WorkspaceFs`;
  - `./host` for a host;
  - `./node` for Node;
  - `./schemas` and `./transcript` for the browser.

  `ProjectDatabases` and `ProcessIdentity` leave the tool context (Q2). The
  app reads stored projects through the harness's own record (Q3). A
  transcript subscription is a scoped resource, not a port named by a string
  (Q7).

### 2.5 Complexity goes down into the module that knows (ch. 8)

**Findings:** S6, T8, T9, P5.

- **S6:** every host's bundler config restates what bundling the harness
  needs. The harness should ship that as one esbuild plugin, and each host's
  target should come from its `engines` field.
- **T8:** each command is spelled three times and seven ids twice. A command
  should be declared once, with its id, palette visibility (T7) and
  handler, and its contribution generated from that.
- **T9:** the standalone trace page is built twice. It should be one
  function that both host families call.

### 2.6 Strategic, not tactical (ch. 3)

A compromise made because of ordering, ownership or PR size was a tactical
decision. Now that those reasons are gone, it should be decided again on
its design alone. Audit V (`V-compromises.md`) found 86 compromises. 32 of
them, in 24 rows (R1 to R24), should be revisited now; 54 still stand,
each with its reason. 26 of the 38 accepted for ownership, order or scope
have lost their reason, and 5 of the design compromises have a better
design today. By owner:

- **A:** R1, the accept race left by #14713. It is smaller than the review
  reply said: the shared `acceptEditedFileReplace` already reads what it
  writes, so it returns that content and the diff uses it. R5, the orphaned
  R6 leftovers: C7's string error channel becomes a `Result`, and the
  listing's `actions`. R14, one `HostFailed`. R22, the headless denial
  notice. Drop "one view tag" from R8's second half: the refusal
  `SESSION-one-view-service` still holds.
- **B:** R15, the diff title as one string; R16, the desktop window as one
  state value; R17, one preview host; R18, N8 then J3, J4 and J2; R19, G7's
  request mask. All are in the window and bridge files 3.3 opens.
- **C:** R6, the user's edit recorded on the task's own revision record;
  R7, `LatexDiffManager` as one `Effect.fn`. Both go in 4.3.
- **E:**
  - R2: one storage-format PR. The verdict row, E4's `handedDown`, the
    awaited child's stop reason, the skip signal and `attemptStarts` share
    one golden-store regeneration.
  - R3 + R4: O3 as one `Layer.effect` account service, and `ApiKeyStatus`
    folded into `CredentialOrigin`.
  - R13, the llm §6 tail.
  - R23, `joinOpening`'s silent refusal.
  - R24, R9's unclaimed D3 and D7.
- **F:** R8, the dead `allSettledVoid`. R9, an interrupted model resolution
  written as an error (`Effect.catchCauseIf`). R20, the stale refusal
  records. R21, 8.1 for the CLI outside A's files. Then R10 (M1, which the
  sliding buffer of one from #14791 now answers), R11 (M6) and R12 (G9).

### Comments and names (ch. 12–14)

These comments are false: `addTurnUsage`'s promised compile error (P6),
`ToolDependencyStatusSchema` (U4), the error contract in `effect/errors.ts`
(Q8), the CI "packages" filter (S8), and `texra.execute`'s argument shape
(T8). `WorkspaceStateKey` is the wrong name for 8 of its 9 keys (P4). Each
is fixed in the PR that touches its file. A false comment is a bug.

## 3. Packages: one owner each, one PR each

Owners are the round-2 sessions, matched to the files they already know.

| Package                                     | Findings                                         | Owner        | Starts            |
| ------------------------------------------- | ------------------------------------------------ | ------------ | ----------------- |
| R3-E. Model-path errors and vocabulary      | U5, U3, P7 with O3, P6, and U7's provider copies | E            | now               |
| R3-Q. The public surface                    | Q1 to Q8, S7's entry list                        | E, second PR | after R3-E        |
| R3-R. Test infrastructure                   | R1 to R8                                         | D            | now               |
| R3-S. Build and repo tooling                | S1 to S9                                         | F            | now               |
| R3-T. Prompts, templates and bundled agents | T1 to T6, U6                                     | C            | after its 4.3 PR  |
| R3-B. Settings and commands                 | P2 to P5, Q4, T7, T8, T9                         | B            | after 3.3         |
| R3-A. Approvals and launch vocabulary       | U1, U2, U4, Q5                                   | A            | after its last PR |

Within each package, the first commit fixes that package's items from
section 1. Each report's batched smaller items go with the package that
owns their files: P8 to R3-B (settings) and R3-E (the llm reasoning
decision and the model copies); Q8 to R3-Q; R8 to R3-R; S's thin items to
R3-S; T10 to R3-B (the extension commands) and R3-T (the notice and tool
messages); U7 to R3-E (the provider copies, the network-failure regex) and
R3-B (the log-severity sinks, `HostFrameSchema`, `DECLINE_RANK`). An owner
who drops one records why in its PR body. The rules of the round-2 note's "What every owner follows" apply
unchanged.

## 4. The lens audits and the catalogue

The area audits searched one list of red flags. Six whole-repo lens audits
(`.agents/docs/evidence/2026-11-07-design-red-flags-lenses/`) searched the
flags no area audit had: pass-through variables (PT), interface comments
(IC), names (NM), nonobvious code (NC), temporal decomposition and conjoined
code (TC), and general versus special purpose (GS). A catalogue
(`catalogue.md`) tags all 208 distinct findings of rounds 1 to 3 with
Ousterhout's flags and their status. On 2026-11-07 the counts were:

- 83 landed;
- 118 assigned;
- 5 refused;
- 19 open with no owner;
- of those 19, 3 held by the owner with #14773.

The flags that cluster in one package point to one cause each:

| Package                           | Cluster                                       | Cause                                           |
| --------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| harness                           | pass-through variable, temporal decomposition | the lifecycle split across files by time        |
| cli                               | reinvented primitive                          | the exit held in no Effect value                |
| desktop                           | reinvented primitive                          | no `Scope` per window                           |
| llm                               | repetition                                    | each provider restating the route decision      |
| prompts, hosts, tooling and tests | information leakage                           | facts hand-copied into files no compiler checks |

### 4.1 Unknown unknowns the lenses found

| Id  | What is wrong                                                                                                                                                                                       | Owner    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| NC1 | Text replacement runs in object-key order: 318 of the 2,535 default rules can never produce their output. Sorted longest key first, none is shadowed.                                               | C (R3-T) |
| NC5 | `submit_output` accepts once per activation, though it says once per run, so a run behaves differently live and after a resume.                                                                     | E        |
| PT1 | A launch's API keys ride on the run record that every plugin tool can see. `wakeRun` resumes a run with no keys; check whether a service run started with a client's keys then fails.               | E        |
| IC  | 32 false comments in source and 2 in guidance, among them the public tool error contract, a deadline #14772 removed, two "only writer" claims, and eight comments that cite checks that do not run. | F        |

### 4.2 By owner

Each owner adds these to the round-3 PR it already has (section 3); none needs
a new PR.

- **A (R3-A):**
  - PT3: `CliContext` as a service, not a parameter 30 functions only forward.
  - NM3: `RunPosition` names two types.
  - NM5: the four names for a pending request, with U1.
  - Q5: A's alone.
  - V-R5 and V-R22: A's alone.
  - K11: the headless result built three times; `runtime/` as one directory.
- **B (R3-B, and R18's PR):**
  - GS2: the dialog ports reduced to three members.
  - GS3: the settings view asks what the editor can do, not which host it is.
  - GS5: one `select` for the workspace agents.
  - GS6: a per-kind pane table.
  - TC1: one PDF display operation.
  - TC2: the progress view built in its owner's scope.
  - NC7: the viewer opens when the build finishes.
  - PT4: log channels through the fiber's annotation.
  - Q4: B's alone, with J2.
  - J8, J10 (lands with T7), J-b, J9's rest, N11's rest, G11, U7 (d, e).
- **C (R3-T):**
  - NC1.
  - NC6: GitHub bodies decoded with their schemas.
  - PT5: the Zotero port read where it is used.
  - I12's rest, H11's rest.
  - I2's `diffBaseOf` and I4's recipe half.
  - NM4: "task" and "workflow".
- **D (R3-R):**
  - E11's test half, if R2 reaches `callRequests` first.
- **E (R3-E, R3-E2, R3-Q):**
  - NC5, PT1.
  - PT2: `Sessions` yields `AgentCatalog` once.
  - PT6.
  - GS1: a tool declares its card; `tool.start` changes, so it goes in R3-E2.
  - GS4: no "outside any run" tool context.
  - TC3, TC4, TC5, TC6: the attempt, background compaction, the launch trace, the upload cache.
  - NC2, NC3, NC4.
  - NM2: `SessionEvent` as `SessionRow`, in R3-Q.
  - NM6.
  - E11, C11, O9, M11.
  - S7: E's alone, in R3-Q.
  - E5 with Q2: one owner for the tool context type.
- **F:**
  - IC: one PR for the false comments.
  - The three refusals with no record: M2, E10 and I8's two parts.
  - NM7, the basename pairs, and NM8, the project folder's spellings, once the packages touching those files have landed.

NM1 ("settle" for eight things) and the banned-word counts (NM9) are not a
mass rename. Each owner renames what it touches, as root `AGENTS.md`
"Terminology" asks.
