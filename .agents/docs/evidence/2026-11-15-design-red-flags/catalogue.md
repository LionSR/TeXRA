# The 2026-11-15 design red-flag catalogue: every finding, by owner and status

Compiled from the sixteen reports in this folder (the [brief](./BRIEF.md)
lists their scopes): eleven area audits (`HR`, `HS`, `HT`, `TC`, `TT`, `TU`,
`CL`, `DT`, `EX`, `LM`, `RT`) and five whole-repo lenses (`LS`, `LI`, `LT`,
`LC`, `LN`). Every report read the code at `main` `d70ad92`. Each finding was
re-read and refuted where it could be before it was written; the reports
record about 225 candidates dropped that way. Findings an earlier round made
appear only as remainders or regressions and name the earlier id.

**Line citations and "open PR" fields are as of `d70ad92`.** Several PRs
the reports name as open have merged since (#14949, #14955 among them), and
some cited lines have moved. Each owner re-verifies its rows on current
`main` before building them; that reading supersedes the reports' citations.

**Ownership.** Each package has one owner session and one PR, which builds
every row in its table below. A row belongs to the package that owns most of
the files it changes; it may touch others. The yardstick is the root
`AGENTS.md` "Design guardrails"; the flag names are the brief's.

**Statuses.**

- **assigned**: in an owner's table, not yet merged.
- **landed (#n)**: merged on `main` in PR #n.
- **refused (`id`)**: the owner re-verified it on `main` and found it does
  not hold or the fix would be a loss; the reason is the
  `.agents/docs/refuted-candidates.json` record `id`.
- **held**: needs a decision only the repo owner can make. The decision is
  written under "Held for the owner".
- **merged into X**: the same problem as row X, built and counted there.
- A row built except for a part the owner refused counts as **landed**; its
  status names the refused part and its record.

The counts below are updated after each merge wave in a docs PR; the newest
"Status at main" section is on top of the "Waves" log at the end.

## Counts

### By status and owner

| Owner     | assigned | landed | refused |  held |    rows |
| --------- | -------: | -----: | ------: | ----: | ------: |
| harness   |       33 |      0 |       0 |     0 |      33 |
| texra     |       40 |      0 |       0 |     0 |      40 |
| llm       |        0 |      8 |       0 |     0 |       8 |
| cli       |       11 |      0 |       0 |     0 |      11 |
| desktop   |       11 |      0 |       0 |     0 |      11 |
| extension |        8 |      0 |       0 |     0 |       8 |
| root      |       10 |      0 |       0 |     0 |      10 |
| **all**   |  **113** |  **8** |   **0** | **0** | **121** |

Not counted above: TC-5, merged into another row (status "merged into" in its owner's table).

### By red flag and owner

A row counts once under each flag it names.

| Flag                   | harness | texra | llm | cli | desktop | extension | root | all |
| ---------------------- | ------: | ----: | --: | --: | ------: | --------: | ---: | --: |
| shallow module         |       6 |     7 |   1 |   0 |       1 |         1 |    2 |  18 |
| information leakage    |      19 |    17 |   2 |   6 |       7 |         1 |    6 |  58 |
| temporal decomposition |       2 |     4 |   1 |   3 |       1 |         1 |    0 |  12 |
| overexposure           |      11 |     8 |   4 |   3 |       1 |         2 |    2 |  31 |
| pass-through           |       3 |     7 |   1 |   2 |       3 |         2 |    0 |  18 |
| repetition             |      17 |    25 |   3 |   6 |       6 |         5 |    6 |  68 |
| special-general mixed  |       9 |     5 |   1 |   4 |       2 |         3 |    1 |  25 |
| conjoined methods      |       4 |     7 |   1 |   2 |       1 |         3 |    0 |  18 |
| comment restates code  |       8 |    16 |   5 |   4 |       4 |         2 |    4 |  43 |
| vague name             |       8 |     6 |   1 |   1 |       3 |         1 |    2 |  22 |
| non-obvious code       |      11 |    16 |   2 |   6 |       5 |         2 |    6 |  48 |

### By kind and size

| Kind     | rows |     | Size | rows |
| -------- | ---: | --- | ---- | ---: |
| bug      |   21 |     | S    |   84 |
| docs     |   10 |     | M    |   33 |
| refactor |   90 |     | L    |    4 |

## Where the flags cluster

- **Repetition and information leakage** are the most common flags in every
  package. Most are one fact with two or more owners: the git reads in the
  harness and the app (LI-2, TC-5), where a setting lives in fifteen
  messages (LI-1), a plan route's price in llm and the harness (LM-2), the
  install advice for each agent CLI (TT-10), the temp-home environment at
  seven launch sites (RT-2).
- **Bugs** (kind `bug`) come out of those duplicated facts more often than
  from new code: TC-4 and TC-10 (two validators that disagree), LM-2, TT-3,
  TT-10, HT-4, LS-2 and LI-1 are copies that drifted apart.
- **Non-obvious code** clusters in the CLI (CL-3, CL-4, CL-9, LN-3: what
  the user sees when output or a deadline goes wrong) and in file writes
  across processes (LN-1, LN-4).
- **Comment restates code** is mostly false comments and module maps that
  name deleted files (HR-2, TT-8, LM-7, EX-7, RT-9, LC-1, LC-2, LC-6).
- **Shallow modules and pass-through** are thin this round (the LS lens
  found three); the remaining instances are props and option bags threaded
  through layers (CL-1, CL-5, EX-8, DT-6).

## Owners and boundaries

- **Overlaps resolved.** TC-5 (the app's git reads) is built with LI-2 (the
  harness's) by the harness owner, so one module owns repository reads.
  LT-4 (b) is HS-6's `registrationDrafts` item. LC-3's renames are split by
  package; every owner renames the refused words in the code it owns, using
  LC-3's per-package table, and the persisted and wire strings keep their
  spelling.
- **Shared files.** TC-1 and TU-5 (texra) both change the output file verbs;
  LN-1 (texra) and LN-4 (desktop) both change how an accepted file is
  written. Owners keep edits to another package's files to what their row
  requires, and merge `main` in before asking for a merge.
- **Order.** No row waits on another to start. When two PRs touch one file
  the second to merge resolves the conflict against `main`.

## Held for the owner

None yet. Owners hold a row in their PR body when re-verification shows it
needs a product or format decision; the orchestrator lists it here and
brings it to the repo owner.

## Rows by owner

Each owner's PR builds every row in its table. `report` is the file in this folder that holds the evidence.

### harness (33 rows)

| id   | flags                                                                    | kind     | size | finding                                                                                                                                                                                                                                                                                                           | status           |
| ---- | ------------------------------------------------------------------------ | -------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| HR-1 | information leakage, repetition, special-general mixed                   | refactor | S    | "can this agent run here now" is decided twice, and a resume decides it twice in a row                                                                                                                                                                                                                            | assigned         |
| HR-2 | comment restates code, vague name                                        | docs     | S    | the runtime's module maps and file-level comments describe modules that are gone                                                                                                                                                                                                                                  | assigned         |
| HR-3 | information leakage, overexposure, repetition, special-general mixed     | refactor | S    | a refused message or resume is worded by two functions keyed differently, and a withdrawn sender rule is still threaded through three interfaces                                                                                                                                                                  | assigned         |
| HR-4 | information leakage, repetition, non-obvious code                        | refactor | S    | the trace's log methods take any data with any message type; the pairing is checked only when the transcript reads the row back                                                                                                                                                                                   | assigned         |
| HR-5 | information leakage, special-general mixed, non-obvious code             | refactor | M    | whether a run ends after one cycle, and whether a later turn reaches it, is re-derived at eight sites with three formulas                                                                                                                                                                                         | assigned         |
| HR-6 | temporal decomposition, conjoined methods, non-obvious code              | bug      | S    | the opening's echo of the user's instruction is decided in two places, and a task or fork launched with media never echoes it                                                                                                                                                                                     | assigned         |
| HR-7 | overexposure, repetition, special-general mixed                          | refactor | S    | "is the model Anthropic" is decided twice and published on the plugin contract, where no plugin reads it                                                                                                                                                                                                          | assigned         |
| HR-8 | shallow module, pass-through, comment restates code, non-obvious code    | refactor | S    | single-caller files and one-step wrappers in the run layer, and a guard over an effect that cannot fail                                                                                                                                                                                                           | assigned         |
| HS-1 | information leakage, repetition, comment restates code, vague name       | refactor | S    | The trace export's result has three owners, a legacy vocabulary and two false comments                                                                                                                                                                                                                            | assigned         |
| HS-2 | overexposure, comment restates code, vague name                          | refactor | S    | The public `Session` carries a read nobody makes and an open option every production caller passes as `{}`                                                                                                                                                                                                        | assigned         |
| HS-3 | shallow module, overexposure, repetition, special-general mixed          | refactor | S    | The approval policy names seven denial reasons that nothing branches on, each mapped back to its message by its own function                                                                                                                                                                                      | assigned         |
| HS-4 | information leakage, conjoined methods, non-obvious code                 | refactor | S    | A compaction's result is written as a second row that one reader drops and another pairs back by position _(stored `log` payload changes, row version bump; Needs your eye)_                                                                                                                                      | assigned         |
| HS-5 | information leakage, vague name                                          | refactor | S    | `SessionView`, `RunView` and `TranscriptView` each name two types, and the module that defines them aliases its own exports to tell them apart                                                                                                                                                                    | assigned         |
| HS-6 | information leakage, overexposure, repetition, conjoined methods         | refactor | S    | Smaller instances of two representations, a flag pair, and speculative generality in the shared contracts _(includes LT-4 (b))_                                                                                                                                                                                   | assigned         |
| HT-1 | information leakage, pass-through, repetition                            | refactor | S    | The tool switch record has one decoder but five hand-written readers and writers in four modules across two layers                                                                                                                                                                                                | assigned         |
| HT-2 | temporal decomposition, overexposure, repetition, non-obvious code       | refactor | S    | A plugin's fact kinds are checked and indexed outside the plugin table, twice per session and by linear scan per fact                                                                                                                                                                                             | assigned         |
| HT-3 | shallow module, overexposure, repetition, special-general mixed          | refactor | M    | Skill discovery is an open contribution system with one producer, and it de-duplicates skills three times                                                                                                                                                                                                         | assigned         |
| HT-4 | information leakage, repetition, non-obvious code                        | bug      | M    | Four JSON Schema walkers keep four readings of which keywords hold subschemas, and the provider-facing one treats a property named `default`, `enum`, `const` or `examples` as a keyword                                                                                                                          | assigned         |
| HT-5 | shallow module, information leakage, overexposure, special-general mixed | refactor | L    | The documents plugin's run workspace (snapshots, dependency mirrors, round-directory links) is a harness class every run carries _(SDK break: `RunFileService` and `ToolRun.fileService` leave `/plugins`; Needs your eye)_                                                                                       | assigned         |
| HT-6 | information leakage, repetition, comment restates code                   | refactor | M    | "Keep a long output's head and tail and say how much was left out" is written by hand four times, with four spellings of the elision note and a comment naming a function that no longer exists                                                                                                                   | assigned         |
| HT-7 | information leakage, repetition, non-obvious code                        | refactor | S    | The three file-viewing tools take a line range in two shapes under two names, the view formatter takes a third, and the transcript reads each by hand                                                                                                                                                             | assigned         |
| HT-8 | shallow module, repetition, comment restates code, vague name            | refactor | S    | Smaller items, batched: prompt modules filed under `utils/`, a JSON store that parses its file two ways under a false comment, and crossed file names in `platform/defaults/`                                                                                                                                     | assigned         |
| LC-3 | vague name                                                               | refactor | L    | The refused words, counted per package: "as a rule, not a PR" moved `settle` by a quarter and left the small words untouched _(split: each owner renames its own package's share from the per-package table in LC-comments-names.md; the harness owner takes the harness share and the public `settled` members)_ | assigned         |
| LC-4 | vague name, non-obvious code                                             | refactor | S    | `ResumeRefused` is two error classes with one `_tag` and different fields                                                                                                                                                                                                                                         | assigned         |
| LC-5 | vague name                                                               | refactor | M    | Names that call two things by one word, still open from NM10, and one new pair                                                                                                                                                                                                                                    | assigned         |
| LC-6 | comment restates code                                                    | docs     | S    | The shipped API reference still names internal source files, and `ModelInvoker`'s header narrates its steps                                                                                                                                                                                                       | assigned         |
| LI-1 | information leakage, repetition, special-general mixed                   | bug      | S    | Where a setting is changed is written into fifteen messages in four packages, and the places they name disagree with the UIs                                                                                                                                                                                      | assigned         |
| LI-2 | information leakage, overexposure, repetition                            | refactor | M    | Running git has owners in two packages: the app's "one owner of repository reads" sits above the harness that needs the same reads, and the machine-git runner is written once in each _(with TC-5: one owner of git reads, in the harness)_                                                                      | assigned         |
| LI-4 | information leakage, repetition, comment restates code                   | refactor | S    | Three smaller facts restated across a package boundary instead of read from their owner                                                                                                                                                                                                                           | assigned         |
| LN-2 | information leakage, non-obvious code                                    | bug      | S    | A hook's output is cut before it is parsed, and the runner drops the fact that it was cut, so a long JSON answer becomes raw context or no effect with no warning                                                                                                                                                 | assigned         |
| LS-3 | shallow module, overexposure, pass-through                               | refactor | S    | Two renames that add a name and nothing else, one of them on the public surface                                                                                                                                                                                                                                   | assigned         |
| LT-1 | information leakage, conjoined methods, non-obvious code                 | refactor | M    | How a command ended is a tagged type for one function, then four flags with made-up exit codes that every reader decodes back                                                                                                                                                                                     | assigned         |
| LT-3 | information leakage, overexposure, special-general mixed                 | refactor | S    | Whether a notice offers "never remind me" is decided by whoever emits it, beside a table that says the app decides each key's affordances once                                                                                                                                                                    | assigned         |
| TC-5 | shallow module, overexposure, repetition, comment restates code          | refactor | S    | The git reads have one owner except a commit lookup and the commit log; the lookup runs two processes with no timeout for a yes/no                                                                                                                                                                                | merged into LI-2 |

### texra (40 rows)

| id    | flags                                                                             | kind     | size | finding                                                                                                                                                                                                                                   | status   |
| ----- | --------------------------------------------------------------------------------- | -------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| EX-2  | information leakage, overexposure, pass-through, comment restates code            | refactor | M    | Both GUI hosts hand the shared settings body and window four values that are the same on every host, and the process already holds the resources root they restate                                                                        | assigned |
| LC-1  | comment restates code                                                             | bug      | S    | Comments name symbols, files and service keys that were renamed or deleted                                                                                                                                                                | assigned |
| LC-2  | comment restates code                                                             | docs     | S    | Comments that narrate the code they replaced, or cite a design section, in place of the reason                                                                                                                                            | assigned |
| LN-1  | repetition, special-general mixed, non-obvious code                               | bug      | S    | Accepting a document task's output writes the user's file with its own staged rename, outside the file's write lane, and breaks a symlinked target _(LN-4 removes this staged write if it lands first; build LN-1 so LN-4 can delete it)_ | assigned |
| LS-1  | shallow module, overexposure, pass-through, conjoined methods                     | refactor | M    | The Overleaf clone workflow reports each outcome twice, through a 12-member port of callbacks and through a returned status, and each host writes all twelve                                                                              | assigned |
| LS-2  | shallow module, information leakage, repetition, comment restates code            | bug      | S    | The CLI status bar names a run grant with its own one-consumer table in the shared copy, in different words and in the reverse order from every other surface, under a comment saying all three hosts share it                            | assigned |
| LT-2  | repetition, special-general mixed, comment restates code                          | refactor | S    | The shared conversation shell asks "am I on the desktop" and answers it twice, in TypeScript and again in CSS                                                                                                                             | assigned |
| TC-1  | information leakage, temporal decomposition, pass-through, repetition, vague name | refactor | M    | The same four file verbs arrive as two host requests with two vocabularies, and are dispatched in two places                                                                                                                              | assigned |
| TC-2  | information leakage, repetition, comment restates code                            | refactor | S    | A pack or clean result has three types and two message functions; `FileOpResult` only renames the harness's result                                                                                                                        | assigned |
| TC-3  | repetition, conjoined methods, non-obvious code                                   | refactor | M    | Why the service cannot be reached is three optional flags and a sentinel reason string, and the client restates "transport failure" at six sites                                                                                          | assigned |
| TC-4  | information leakage, repetition                                                   | bug      | S    | "Create agent" checks the name with its own rules, which admit names the agent schema refuses, so the new agent never loads                                                                                                               | assigned |
| TC-6  | information leakage, repetition, non-obvious code                                 | refactor | S    | The app serves its command directories as the harness's `CommandDirs`, then four callers bypass the service and read a module-level cache                                                                                                 | assigned |
| TC-7  | overexposure, pass-through, special-general mixed                                 | refactor | S    | Which agents lead a built-in team is an option every caller passes as the same constant                                                                                                                                                   | assigned |
| TC-8  | overexposure, repetition, conjoined methods, comment restates code                | refactor | S    | The chat export's input loader answers four fields its two callers re-derive from, and declares schemas nothing decodes                                                                                                                   | assigned |
| TC-9  | information leakage, non-obvious code                                             | refactor | M    | Every inbound settings and desktop message has a schema, and every sender posts an untyped `(command: string, payload: Record<string, unknown>)`                                                                                          | assigned |
| TC-10 | information leakage, repetition, non-obvious code                                 | bug      | S    | "Which input does a model-reported document name" has two matchers that disagree on an ambiguous name, and a third rule in one of their two consumers                                                                                     | assigned |
| TC-11 | shallow module, overexposure, repetition, comment restates code                   | refactor | S    | Smaller instances of one owner per fact: a dead module, a one-implementation port, a fact carried twice, a type restated as a schema, and false comments                                                                                  | assigned |
| TT-1  | information leakage, comment restates code, non-obvious code                      | refactor | S    | An inquiry request says which turn it opens four ways, and copies its last turn beside the transcript that holds it                                                                                                                       | assigned |
| TT-2  | special-general mixed, non-obvious code                                           | bug      | S    | `open_pdf` is offered on every host and fails on the two that have no PDF viewer, while its sibling `diagnostics` is gated on the same registry                                                                                           | assigned |
| TT-3  | non-obvious code                                                                  | bug      | S    | `extract_tikz_figures` compiles by default on some providers and never on others                                                                                                                                                          | assigned |
| TT-4  | information leakage, repetition, comment restates code                            | refactor | S    | Setup and inquiry tools check closed choices in the body and restate their tables in prose; one description has already drifted                                                                                                           | assigned |
| TT-5  | shallow module, temporal decomposition, pass-through, repetition, vague name      | refactor | M    | The agent-CLI "shared" module is three steps each provider must chain in order, with the thread claim threaded through four calls and the card teardown left to each driver                                                               | assigned |
| TT-6  | repetition, conjoined methods, non-obvious code                                   | refactor | S    | `downloadArxivSource` takes "indent or not" as two parameters, its callers resolve the formatter for it, and "the root is never indented" is decided twice                                                                                | assigned |
| TT-7  | shallow module, information leakage, vague name                                   | refactor | S    | Four modules under `tools/` serve no tool: the approval preview and its temp files, the draft recorder, and the Pack destination                                                                                                          | assigned |
| TT-8  | comment restates code                                                             | docs     | S    | The `latex/` README and the agent-CLI import headers state things the code no longer does                                                                                                                                                 | assigned |
| TT-9  | repetition, non-obvious code                                                      | refactor | S    | "Keep a found binary for the process, retry a miss" is written three ways, one of them a module singleton made at import                                                                                                                  | assigned |
| TT-10 | information leakage, repetition, non-obvious code                                 | bug      | S    | Each agent CLI's install advice is written five times and the copies disagree; on Windows two of them prescribe an install the resolver cannot use                                                                                        | assigned |
| TT-11 | shallow module, repetition, vague name                                            | refactor | S    | Smaller instances of one fact with two spellings or two owners                                                                                                                                                                            | assigned |
| TU-1  | information leakage, overexposure, repetition                                     | refactor | M    | Every action menu writes each item twice, a value string in the template and a branch that decodes it                                                                                                                                     | assigned |
| TU-2  | repetition, conjoined methods, comment restates code                              | refactor | S    | The in-place rename hands its callers a once-only protocol, and each caller re-implements it                                                                                                                                              | assigned |
| TU-3  | temporal decomposition, conjoined methods, comment restates code                  | refactor | S    | The transcript's scroll-follow is split between `log-list` and `stage-list`, driven by a flag and three public methods                                                                                                                    | assigned |
| TU-4  | information leakage, repetition, comment restates code, vague name                | refactor | S    | Design tokens have second spellings: local fallbacks that contradict the token, and an `sp` alias that renames three spacing steps                                                                                                        | assigned |
| TU-5  | information leakage, repetition, non-obvious code                                 | refactor | S    | The file list decides which workspace file each output verb compares with or writes into, and the host takes that path from the webview                                                                                                   | assigned |
| TU-6  | temporal decomposition, overexposure, pass-through, repetition                    | refactor | S    | Each root re-wires the shell's four events to the session surfaces by hand                                                                                                                                                                | assigned |
| TU-7  | repetition, conjoined methods, non-obvious code                                   | refactor | S    | A request in flight is tracked twice: the surface's `busyWhile`, and a private set in `run-tabs` that guesses when a delete ended                                                                                                         | assigned |
| TU-8  | comment restates code, vague name                                                 | docs     | S    | The progress view's request path cites planning documents and names its parts with words the "Plain names" table refuses                                                                                                                  | assigned |
| TU-9  | shallow module, overexposure, pass-through, special-general mixed                 | refactor | S    | `formatters/constants.ts` is a drawer of single-reader values, one a tool-name table that names no live case and threads `toolName` through three painters                                                                                | assigned |
| TU-10 | information leakage, repetition, non-obvious code                                 | refactor | M    | An answer being typed into a request card survives a run switch only on the inquiry card; the other cards keep it in element state                                                                                                        | assigned |
| TU-11 | comment restates code, non-obvious code                                           | bug      | S    | Two questions with the same wording lose one answer, which the question card documents instead of preventing                                                                                                                              | assigned |
| TU-12 | information leakage, repetition, non-obvious code                                 | refactor | S    | "Which catalog option is this agent?" is written four times, and the terminal's copy matches across sources where the web's refuses to                                                                                                    | assigned |

### llm (8 rows)

| id   | flags                                                                  | kind     | size | finding                                                                                                                                                     | status                                                                         |
| ---- | ---------------------------------------------------------------------- | -------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| LM-1 | information leakage, conjoined methods, comment restates code          | refactor | S    | "This binding is on the ChatGPT plan" is said by the route and again by the credential's kind, and the files endpoint follows the credential                | landed (#14967)                                                                |
| LM-2 | information leakage, repetition, non-obvious code                      | bug      | S    | "A plan route costs nothing" has two owners that disagree on two of the four plans                                                                          | landed (#14967)                                                                |
| LM-3 | temporal decomposition, overexposure, pass-through                     | refactor | M    | The subscription account hands its sign-in steps to every caller, and the app passes the account back into llm's own login functions                        | landed (#14967)                                                                |
| LM-4 | overexposure, repetition, special-general mixed, comment restates code | refactor | M    | The rules around a codec's lowering (a model switch's replay, a stored continuation) are written per codec, and Google's copy differs                       | landed (#14967)                                                                |
| LM-5 | overexposure, comment restates code                                    | refactor | S    | Constant fields on the turn contract, two of them stored on every turn row                                                                                  | landed (#14967)                                                                |
| LM-6 | comment restates code, vague name                                      | docs     | S    | Refused words and false comments in the turn assembly, the Responses request and the OAuth coordinator                                                      | landed (#14967)                                                                |
| LM-7 | comment restates code                                                  | docs     | S    | The package README and the model-layer guide describe members and options that were deleted                                                                 | landed (#14967)                                                                |
| LM-8 | shallow module, overexposure, repetition, non-obvious code             | refactor | S    | Small instances, batched: a binder that throws and catches its own errors, a verdict rule that restates the error's default, and three hand-written helpers | landed (#14967); part (b) refused (`LLM-verdict-not-retryable-is-the-default`) |

### cli (11 rows)

| id   | flags                                                                                        | kind     | size | finding                                                                                                                                                                                        | status   |
| ---- | -------------------------------------------------------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| CL-1 | information leakage, temporal decomposition, pass-through, repetition, special-general mixed | refactor | M    | A slash command's form reaches its action through a 21-field bag of callbacks the one caller wires back to the handler it already has                                                          | assigned |
| CL-2 | information leakage, overexposure, repetition                                                | refactor | M    | Every headless result is still written twice by its caller, against a 33-member schema that is never decoded, and the line stamp has six writers                                               | assigned |
| CL-3 | special-general mixed, comment restates code, non-obvious code                               | bug      | S    | The chat TUI presents the session's notices through the headless presenter, which writes raw stderr (or NDJSON on stdout) under the Ink frame                                                  | assigned |
| CL-4 | information leakage, special-general mixed, comment restates code, non-obvious code          | refactor | S    | "The user passed `--quiet`" has three representations, and the headless run context overwrites the one named for it                                                                            | assigned |
| CL-5 | pass-through, repetition                                                                     | refactor | M    | The chat's one process runtime, stores and roots are threaded as props through about 20 component interfaces                                                                                   | assigned |
| CL-6 | information leakage, overexposure, repetition, comment restates code, vague name             | refactor | M    | Batched: an option, catches, parses and tables that restate what one owner already does, and false or doubled comments                                                                         | assigned |
| CL-7 | special-general mixed, conjoined methods, non-obvious code                                   | refactor | S    | `transcriptEntryLayout`'s three-valued `mode` is still two decisions, with one combination no caller reaches and a caller that redoes the tool lines after it                                  | assigned |
| CL-8 | information leakage, overexposure, repetition                                                | refactor | S    | The chat resolves its model at four sites, each restating the stores and a recovery sentence, and the in-chat reconnect uses the startup's sentence                                            | assigned |
| CL-9 | information leakage, temporal decomposition, non-obvious code                                | bug      | S    | Once a command's platform is up every diagnostic is dropped, so `--verbose` does nothing for the command's work and warn-level fallbacks are silent                                            | assigned |
| LN-3 | comment restates code, non-obvious code                                                      | bug      | S    | A deadline whose expiry is the case worth telling is written as `timeoutOption` with the `None` dropped, and one false comment left from FB1                                                   | assigned |
| LT-4 | temporal decomposition, repetition, conjoined methods, non-obvious code                      | refactor | S    | smaller instances of state set in one place and read in another, and of a helper that is only correct inside its caller's markup _(split: (a) and (d) cli; (b) is built with HS-6; (c) texra)_ | assigned |

### desktop (11 rows)

| id   | flags                                                                                     | kind     | size | finding                                                                                                                                                                                                                                                                                    | status   |
| ---- | ----------------------------------------------------------------------------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| DT-1 | information leakage, pass-through, non-obvious code                                       | refactor | M    | Every main-process push to the renderer is typed `unknown`; the outbound union types only the receiving end                                                                                                                                                                                | assigned |
| DT-2 | information leakage, repetition, special-general mixed, comment restates code, vague name | bug      | M    | Every desktop command is implemented once per process, each forwarding the other's half, and the two "New Task"s have drifted                                                                                                                                                              | assigned |
| DT-3 | repetition, non-obvious code                                                              | refactor | M    | Each native message box is its own `tryPromise` over `dialog.showMessageBox`, with its own error, parent choice and button-index decoding                                                                                                                                                  | assigned |
| DT-4 | pass-through, conjoined methods, comment restates code, non-obvious code                  | bug      | S    | The onboarding card's ChatGPT sign-in raises its "not attached" guard as a defect, past the typed error its `mapError` was written for                                                                                                                                                     | assigned |
| DT-5 | information leakage, temporal decomposition, repetition                                   | refactor | S    | The recent-projects list is stored once and mirrored into the registry's state by a re-read after every write                                                                                                                                                                              | assigned |
| DT-6 | information leakage, pass-through, repetition, non-obvious code                           | refactor | S    | Where the built main bundle sits is guessed at run time, and the bundle layout is restated in three modules beside a `mainDir` threaded four layers deep                                                                                                                                   | assigned |
| DT-7 | shallow module, information leakage, overexposure, special-general mixed, vague name      | refactor | S    | Smaller facts with two owners and options for one caller in the main process and the workbench                                                                                                                                                                                             | assigned |
| DT-8 | comment restates code, vague name                                                         | docs     | S    | Two false comments about the IPC schemas, and the words the "Plain names" table refuses                                                                                                                                                                                                    | assigned |
| LI-3 | information leakage, repetition                                                           | refactor | S    | "What a GUI-launched process lacks from the user's shell" is answered three ways in three packages: a hand-written login-shell read, the `fix-path` package, and two PATH lists that overlap                                                                                               | assigned |
| LI-5 | information leakage, repetition                                                           | refactor | S    | A settings page's icon is written once per host, though the command already names its page                                                                                                                                                                                                 | assigned |
| LN-4 | comment restates code, non-obvious code                                                   | bug      | M    | The file write lane that keeps an editor save and an approved edit apart is per process, and a folder's runs write from the service process while the desktop editor saves from the app's _(design B in the report; the offline-save policy follows FB1, held if it needs a product call)_ | assigned |

### extension (8 rows)

| id   | flags                                                              | kind     | size | finding                                                                                                                                                                                                                                                       | status   |
| ---- | ------------------------------------------------------------------ | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| EX-1 | repetition, special-general mixed, comment restates code           | refactor | M    | A VS Code call that fails has six spellings in the extension; `HostFailed`, the one tag defined for it, is used beside five local copies of its shape                                                                                                         | assigned |
| EX-3 | shallow module, pass-through, repetition, conjoined methods        | refactor | M    | "Which progress surface is on screen, and how to bring one forward" is still decided at six sites in three modules                                                                                                                                            | assigned |
| EX-4 | temporal decomposition, conjoined methods, non-obvious code        | refactor | S    | The two editor annotation surfaces are module-level `let`s that an activation function writes and a provider handed elsewhere reads                                                                                                                           | assigned |
| EX-5 | information leakage, special-general mixed                         | refactor | L    | The settings view's frontend is app UI two hosts mount, but it lives in the extension package, so the desktop imports a host package's source and four configs name it as an exception _(moves the settings frontend into `packages/texra/src/ui/settings/`)_ | assigned |
| EX-6 | overexposure, repetition, special-general mixed, conjoined methods | refactor | S    | The command surface has a second registration path that drops arguments and restates a sign-in, a mode flag with one value per caller, and a command option nobody sets                                                                                       | assigned |
| EX-7 | comment restates code, vague name                                  | docs     | S    | The extension's guide names deleted symbols and wrong homes, and its code carries false comments, comments that narrate the code they replaced, and refused words                                                                                             | assigned |
| EX-8 | pass-through, repetition                                           | refactor | S    | The progress view threads its roots, runtime, scope and a second copy of the global state store into three builders, each of which wraps the same `openBuilt` call                                                                                            | assigned |
| EX-9 | overexposure, repetition, non-obvious code                         | refactor | S    | Three small VS Code adapters are written by hand at each use: an event as a stream (five copies), the browser opener (seven instances of a stateless class), and the LaTeX-command guard's log channel                                                        | assigned |

### root (10 rows)

| id    | flags                                                                  | kind     | size | finding                                                                                                                                                                                                                                     | status   |
| ----- | ---------------------------------------------------------------------- | -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| RT-1  | information leakage, repetition                                        | refactor | M    | Four scripts stop a test home's background services, each re-reading the socket name and log line by hand                                                                                                                                   | assigned |
| RT-2  | information leakage, repetition, comment restates code                 | refactor | M    | The temporary-home launch environment is hand-written at seven launch sites beside the `isolatedHomeEnv` that owns it, each with a different subset of keys and kill switches                                                               | assigned |
| RT-3  | repetition, comment restates code, non-obvious code                    | refactor | M    | `verify-desktop.mjs` checks one artifact list twice (the build output and the packaged app), and its pass summaries are hand-kept lists that omit checks                                                                                    | assigned |
| RT-4  | information leakage, repetition, non-obvious code                      | refactor | L    | The desktop app has two Playwright launch harnesses with two definitions of "ready": the e2e fixture and `verify-desktop`'s packaged smoke                                                                                                  | assigned |
| RT-5  | shallow module, information leakage, vague name, non-obvious code      | refactor | M    | The fake host is spread over four support files under three names, `FakeHost` names two types, and its options take three storage paths where production derives two from one                                                               | assigned |
| RT-6  | information leakage, overexposure, special-general mixed               | refactor | M    | The harness's test kernel is built on the CLI's validation bundle layer and TeXRA's setup-tool port, so harness suites depend on two packages above the harness                                                                             | assigned |
| RT-7  | shallow module, overexposure, repetition, vague name, non-obvious code | refactor | S    | Batched remainders in the test support: the global `fetch` seam, the wall-clock poll, single-consumer support files and the "parked" vocabulary                                                                                             | assigned |
| RT-8  | comment restates code, non-obvious code                                | refactor | M    | The TUI frame validator drives its 144 scenarios by wall clock, so the full run takes about 11 minutes, CI runs 12 of them, and the rest have already rotted once _(long mechanical change; the full run joins CI once waits end on state)_ | assigned |
| RT-9  | comment restates code                                                  | docs     | S    | CI and test-config comments that are false or cite a deleted document                                                                                                                                                                       | assigned |
| RT-10 | information leakage, repetition, non-obvious code                      | bug      | S    | Scripts reach production TypeScript through two hand-built esbuild bundles, and the desktop fixture's hand-written type already declares three exports the bundle does not have                                                             | assigned |

## Waves

### Status at main `ab4b379` (wave 1: #14967)

The llm owner's PR merged. LM-1 to LM-7 landed whole. LM-8 landed except part
(b), which the owner refused on re-reading: `notRetryable` reads a status
taken from the reply body, which the error's own default does not, so
deleting it would leave every producer to keep a `transport` error and a
non-retryable body apart (`LLM-verdict-not-retryable-is-the-default`). The
row counts as landed. The llm share of LC-3 landed too; LC-3 stays assigned
until every owner's share has.

Four changes in #14967 were marked "Needs your eye" and merged by the repo
owner: `model.message` row v20 (LM-5), `BindSpec.bearer` and the sign-in
exports on `./node` (LM-1, LM-3), plan rows in the picker priced at $0 (LM-2),
and the Google codec refusing another protocol's reasoning (LM-4).

The other six owners were stopped by the usage limit at 01:57 and resumed at
05:45; none has opened its PR yet.

### Status at main `5f5488c` (compiled)

All rows assigned. The seven owner PRs open from here; each merge wave adds
a section above this one.
