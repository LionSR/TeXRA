# Round 7: fallbacks, by the design decision behind them

Read at `main` commit `b4b0132` (`simplify: package E format batch
(section(), Y3 gap row, event_blob.inline, Q1, Q8 b) (#14843)`). Read-only:
no production code changed. Rules and scope: [`BRIEF.md`](BRIEF.md). Every
`path:line` is on that commit.

The owner asked for the fallbacks to be read as symptoms. So each finding
below is a **design cause**: the decision the design refused upstream. Its
fallback sites are the evidence, with consumer counts. Each finding gives the
shape that removes the whole cluster and its size. A lone `catch {}` with no
cluster behind it is a batched item (FB10), not a finding. Findings are
ranked by how many fallbacks one decision removes, with a reachable defect
first.

## Numbers

Production sources under `packages/*/src` with `*.test.*` excluded. Tests
live in `packages/*/test` and `src/`, so none are in the counts.

| Shape                                                             | harness | texra | llm | extension | desktop | cli | Total |
| ----------------------------------------------------------------- | ------: | ----: | --: | --------: | ------: | --: | ----: |
| bare `catch {`                                                    |       7 |     2 |   2 |         0 |       5 |   6 |    22 |
| `Effect.ignore` / `ignoreCause`                                   |       9 |     8 |   0 |         3 |       0 |   3 |    23 |
| `orElseSucceed`                                                   |       5 |     2 |   1 |         0 |       0 |   0 |     8 |
| `catchDecoding`                                                   |       0 |     1 |  10 |         0 |       0 |   1 |    12 |
| `catchTag(s)` lines                                               |      22 |    45 |   5 |         5 |       2 |   7 |    86 |
| `catchIf` lines                                                   |      35 |    21 |   1 |         1 |       4 |  10 |    72 |
| `catchCause` lines                                                |      27 |    16 |   0 |        19 |       7 |  16 |    85 |
| `Effect.catch(` lines                                             |      71 |    98 |   4 |        27 |      17 |  25 |   242 |
| `Option.getOrUndefined`                                           |      16 |     5 |   1 |         2 |       1 |   1 |    26 |
| `Option.getOrElse`                                                |       5 |     2 |   1 |         0 |       0 |   1 |     9 |
| `?? []`                                                           |      95 |    50 |   6 |        14 |       1 |  35 |   201 |
| `?? ''`                                                           |      47 |    56 |   6 |        10 |      12 |  29 |   160 |
| `?? null`                                                         |      76 |    33 |  25 |         8 |       7 |   8 |   157 |
| `?? undefined`                                                    |      21 |    23 |  11 |         2 |       1 |  17 |    75 |
| `default:` lines                                                  |      30 |    27 |   5 |         3 |       3 |  33 |   101 |
| `Promise.allSettled`                                              |       0 |     0 |   0 |         0 |       0 |   2 |     2 |
| lines saying "fallback" (any case)                                |     110 |   108 |   3 |         4 |      30 |  55 |   310 |
| handlers that succeed with a default (`catch*`, `orElseSucceed`)¹ |      71 |    68 |   2 |        16 |       7 |  20 |   184 |
| … of which log at warn or error first¹                            |      24 |    24 |   0 |        12 |       1 |   2 |    63 |
| … of which separate absence with `absentReason`¹                  |      22 |    12 |   0 |         0 |       3 |   4 |    41 |

¹ A heuristic pass: each handler with the six lines after it, kept when it
ends in a default and does not fail again, about ±10%. Most of the 80 that
neither warn nor check absence turn the failure into a visible value: a
doctor row, an `issue(...)`, an `errorResult`, a `Rejected`.

The `default:` count is higher than the brief's 61 because it counts every
line. About 40 of the 101 are CLI argument `default:` keys or comments. Of
the switch defaults in harness, texra and cli, 23 are exhaustive (`absurd`,
`satisfies never`, throw or fail), 22 are deliberate subset selectors or
generic renderers, and 5 drop an unknown case silently (FB3). The `Promise.allSettled`
hits are a doc comment and a script template
(`packages/cli/src/runtime/models/validationModel.ts:58,70`), not live code. No
retry drops its last error: `Database.ts:390` and the other retries end in
`Effect.orDie` or a `logError` (`packages/harness/src/tools/pluginCatalog.ts:111-116`).
"fallback" appears in 137 files. The heaviest are
`packages/harness/src/model/runModelDecision.ts` (23),
`packages/texra/src/ui/copy/modelAccess.ts` (13),
`packages/texra/src/ui/wa/statusIcons.ts` (11) and
`packages/desktop/src/main/desktopProjects.ts` (10).

## The area's questions

**How many fallbacks, by shape and package?** See the table. Two packages
hold three quarters of the default-returning handlers: harness (71) and
texra (68). llm's 12 `catchDecoding` are all provider or JWT boundary
decodes.

**How many log at warn before degrading?** 63 of 184 default-returning
handlers (34%) log at warn or error first. Another 41 (22%) default only on
absence (`absentReason`). Of the 23 `Effect.ignore`, 17 carry
`{ log: 'Warn' }` or `'Error'`. The six without are `resumeRun.ts:187`,
documented, where the launch reports the failure; `mcpServer.ts:262,291` and
`leanServer.ts:255`, waits on a process exit or a stderr tail; and the two
CLI `ignoreCause` on a run's own outcome
(`sessionExitController.ts:218`, `chatSessionController.ts:912`). The 22 bare
`catch {` all carry a comment but two: `cliContext.ts:263`, which has its
comment above the `try`, and `CopyButtonController.ts:15`, which returns
`false` to its caller.

**How many have a test that exercises the degraded path?** Almost none. The
three sweeps grepped `packages/*/test` and `src/` for every function named in
FB1 to FB9. They found one test of a degraded path:
`src/test-kernel/cli/ModelAccess.vitest.ts:69-115`, which covers the CLI's
model notice (FB2's one honoured caller). The delegation test
(`packages/harness/test/tools/DelegationAvailability.vitest.ts`) covers only
the rejection of an explicit model. Nothing covers the parent-run fallback
FB2 finds. No spec asserts "runs here only", the `serviceOffline` banner or
`QUOTA_FALLBACK`.

**Which fallbacks fire in a normal run today?**

- The golden store `src/test-kernel/fixtures/storage/golden-1.0.sql` has no
  `fallback`, `QUOTA_FALLBACK`, `unavailable` or `notice` row. A recorded
  CLI run fires no model, quota or service fallback.
- The desktop e2e suite runs on a fallback. `reachDesktopService` fails
  whenever the data root is not `defaultNodeStorageRoot()`
  (`packages/desktop/src/main/desktopService.ts:39-45`), and `launchTexraApp`
  always gives the app a temp user-data path
  (`packages/desktop/tests/e2e/electronApp.ts:114-126`). So every spec but
  `serviceClient.spec.ts` runs a folder's tasks in-process, the path
  production takes only when the service is out of reach (FB1).
- The desktop's "fallback project" (`desktopProjects.ts:302-312`) is the
  no-folder session. It is active at launch until the remembered folders
  reopen. That is a real alternative, decided from a fact the code holds,
  under a misleading name.

**Which recorded compromises are fallbacks whose reason is gone?**

- Root-designs PR 1, §1.4
  (`.agents/docs/proposed/architecture/2026-11-06-root-designs-pr1-compromises.md`):
  headless denials no longer reach stderr. This has ended:
  `packages/cli/src/runtime/headless/executeCli.ts:236-252` writes each denied
  `request.decided` as a `[warn] [cli.approval]` line. The stated cost no
  longer holds, so the entry can be closed.
- Round 4's X report, R8
  (`.agents/docs/evidence/2026-11-07-design-red-flags-round-4/X-compromises-today.md`):
  three copies of the session open where the in-process fallback is decided.
  Resolved: `openLocalSession`
  (`packages/texra/src/controllers/session/openProjectSession.ts:53-64`) is now
  the one copy.
- X's S2 (`connectService?`, `resourcesRoot?`) still holds.
- PR 1 §1.10, the erased `ClaudeAgentResumeFallback` suite, is a coverage note,
  not a runtime fallback.
- No other compromise in either document is a fallback.

## Findings

### FB1. Where a window's tasks run is decided once at open, behind a fallback the desktop never shows (defect)

**Red flags:** silent degradation; two policies for one failure; a mode that
is the main path in one host's tests; a false comment.

**Design cause.** Whether this window's tasks run in the background service
is a fact with no owner across the window's life. Each host decides it once at
open and handles "the service is out of reach" itself. The window's state
then never records the choice.

**Evidence (9 sites, 4 hosts):**

- Desktop: a failed `reachDesktopService` only logs at warn
  (`packages/desktop/src/main/index.ts:143-150`) and passes `service:
  undefined` on. The person is never told.
- Extension: the same text goes through `warn`, a VS Code notice
  (`packages/extension/src/extension.ts:425-433`).
- CLI: the same text goes to stderr or into a transcript notice
  (`packages/cli/src/chat/tui/runChatTui.tsx:175-200`). The ternary at `:199`
  inside `if (!served)` can never take its first branch.
- Shared: `openProjectSession` (`openProjectSession.ts:34-42`) takes
  `service | undefined`.
- The banner never covers the startup case. `serviceOffline`
  (`packages/texra/src/shared/session/hostSnapshot.ts:114-118`) comes from
  `linkOutage` (`packages/texra/src/controllers/session/openGuiWindow.ts:317`,
  `packages/texra/src/controllers/server/client.ts:528`), and a local window's
  link is `HostWindows.localLink`, whose `away` is `''` from birth
  (`packages/texra/src/controllers/server/hostWindows.ts:382-394`). A desktop
  window that never reached the service shows no banner and no notice.
- Two policies for one outage. Out of reach **at open**, the window runs its
  tasks in-process. Lost **mid-session**, the same window refuses with the
  offline reason and reconnects (`client.ts:510-536`).
- `attachWindowHost`'s doc says "the window goes on with its own process's
  capabilities" (`packages/texra/src/controllers/server/windowHost.ts:113-117`).
  The code only clears the attachment and waits for the next client
  (`windowHost.ts:160-168`). The comment describes a fallback that does not
  exist.
- Tests: the desktop e2e suite runs the in-process path
  (`desktopService.ts:39-45` with `electronApp.ts:114-126`). The service path
  has one spec (`serviceClient.spec.ts`), flaky by round 4's X R10.

**Prior rounds.** Round 1 F (`../2026-11-05-design-red-flags/F-hosts.md:631`)
left the per-host decision alone as "already in table C". This round adds
what that missed: the desktop never surfaces the choice, the banner cannot
see it, and the e2e suite runs the fallback as its main path.

**Design it twice.**

- **A. One owner, one surface.** `openProjectSession` returns the session
  with a `where: 'service' | { local: reason }` value. Every window's
  `HostSnapshot` carries it, and `serviceOffline` becomes a projection of it,
  so the banner shows the startup case as well. The desktop's log-only branch
  is deleted. The e2e suite either gives the app the default data root
  under a temp HOME (as `serviceClient.spec.ts` does) or asserts the local
  banner.
- **B. No local fallback for a folder.** A window that cannot reach the
  service refuses folder tasks, as it already does mid-session. That is one
  policy for one failure. But it gives up running offline from a stale
  install, a real case for the CLI.
- **Choose A:** it keeps the capability and makes the one fact visible.
  Revisit B once the service is reliably present in every host.

**Fix and size.** About 6 files and ~60 lines: `openProjectSession.ts`,
`hostSnapshot.ts`, `openGuiWindow.ts`, the three hosts' open branches, the
`windowHost.ts` doc, plus an e2e launch option. Owner **G**. The surface
copy goes to **B**.

### FB2. The run-model decision's notice is an optional field; two of four callers drop it (defect)

**Red flags:** silent degradation; a special case written as data (a constant
column, a row with no producer); two representations of one fact.

**Design cause.** `decideRunModel` decides whether a fallback must be told,
and returns that as `fallbackFrom?: { mode }`
(`packages/harness/src/model/runModelDecision.ts:44-48,93-97`). A caller may
read it or not. The decision "tell the person" was refused at the owner and
pushed to each caller as an optional field.

**Evidence:**

- There are 4 callers. Only the CLI reads `fallbackFrom`
  (`packages/cli/src/runtime/models/modelAccess.ts:423-445`), and it is the
  only one with a test (`src/test-kernel/cli/ModelAccess.vitest.ts:110`).
- Delegation drops it. In
  `packages/harness/src/agent/runtime/delegation/delegationAvailability.ts:241-262`,
  the `'parent-run'` candidate is `notice` mode. When the parent's model is not
  in the access list, the child runs on `availableModels[0]` and nobody is
  told. Reachable today: start a run with a hidden model by explicit id (the
  CLI's `modelsWithHiddenEntry`, `modelAccess.ts:396-404`), then delegate.
  Both callers miss it: `AgentTool.ts:451` and `proposalFlow.ts:277`.
- The compile fixer drops it. In
  `packages/texra/src/controllers/progressView/compileFixer.ts:83-101`, an
  `'agent-config'` model that is unavailable is swapped for the first available
  model with no notice.
- `chatDefaults.ts:58-63` cannot fall back: every candidate is runnable.
- The `'credential'` reason (`runModelDecision.ts:20`) has no producer in any
  package.
- `'silent'` is reached only from `'builtin-default'`, and only the CLI reads
  it.
- The CLI's configured model has two reasons for one fact. It is
  `configured.modelScope ?? 'user-config'` in `chatDefaults.ts:61` but
  `'command-config'` in `runModel.ts:41`.

**Design it twice.**

- **A. A union the caller must match.** The result is
  `{ kind: 'chosen' } | { kind: 'fallback', notice } | { kind: 'unavailable' }`,
  with the notice text built by the owner. Every caller must handle
  `'fallback'` to compile.
- **B. The harness tells.** `decideRunModel` stays pure, and the harness's
  launch path writes the notice to the run's trace. Hosts that decide before
  any run, the CLI and the compile fixer, still need A.
- **Choose A.** Delete `'credential'` and the `mode` field: `silent` follows
  from the reason, so it is no longer a column. Pick one reason for the CLI's
  configured model.

**Fix and size.** About 5 files and ~50 lines, net negative. Owner **E**:
`runModelDecision.ts`, `delegationAvailability.ts`. **C** follows for
`compileFixer.ts`, **A** for `modelAccess.ts`, `chatDefaults.ts`,
`runModel.ts`.

### FB3. An unknown kind becomes a plausible default: `default:` over closed unions, a `Partial` table read as success

**Red flags:** errors not defined out of existence; silent degradation
(a privacy risk in one case); a special case written as an option.

**Design cause.** Each switch on a closed union chose "everything else"
instead of an exhaustive match. The compiler would name the new case. The
`default:` hides it. At open input, the unknown case is dropped where it
enters instead of being normalized once with a warn.

**Evidence (7 sites):**

- a. `packages/harness/src/transcript/traceAssembler.ts:54`: the redaction
  switch over `RequestDecision['action']` returns any other action unchanged.
  The comment lists the four it means. A fifth action that carries user text
  would be exported unredacted in a trace.
- b. `packages/harness/src/agent/runtime/RunHistory.ts:106`: a new
  `model.message` kind carrying a `ModelOrigin` skips the origin-binding check
  (`default: return []`).
- c. `packages/harness/src/agent/runtime/storedTurn.ts:331,385`: a new message
  role passes through unresolved. Its sibling at `:361` throws on a missing
  digest.
- d. `packages/harness/src/shared/session/sessionViewUpdate.ts:813`: handles 3
  of `DisplayRow.type` with `default: return`. Borderline: the subset is
  deliberate, but uncommented.
- e. `packages/texra/src/ui/wa/statusIcons.ts:82-100`: `renderSetStatusIcon`
  shows any status missing from a `Partial<Record<Status, …>>` as a green
  "Set" check. A new `CredentialOrigin` literal
  (`packages/llm/src/providers/credentials.ts:56-60`) or a misspelled key
  renders as success. Callers: `statusIcons.ts:118-125`, the Git tab and the
  LaTeX tab.
- f. Open input: `packages/texra/src/tools/agentCli/codex.ts:160` returns
  `null` (no card) for an unknown Codex `ThreadItem.type`, and `logCodexItem`
  (`codex.ts:112-136`) has no default. A newer `codex` binary's item is
  dropped with no warn.

**The shape.** For a closed union, an exhaustive switch ending in `absurd`.
For a "subset of rows" reader, a named predicate over the literals it
takes. For the status table, `Record<Exclude<Status, SuccessStatus>, …>`, total
and with success named. For open input, one decode at the Codex boundary that
logs an unknown type once at warn and renders it as a generic item.

**Size.** 7 sites, ~40 lines. Owner **E** for a to d, **B** for e, **C** for
f.

### FB4. A fact the code just established, read back through `??` as if it could be missing

**Red flags:** errors not defined out of existence; two policies for one
failure; information leakage (an id joined across two structures).

**Design cause.** The value is carried as an id or a digest and looked up
again in a second structure. Each reader then guesses a default for a miss
that would mean a broken invariant. The owner of the lookup does not make
the fact required.

**Evidence (6 sites):**

- a. `packages/harness/src/agent/runtime/loop/toolUseDispatch.ts:1000`:
  `base64: bytes.get(part.digest) ?? ''` uploads an empty file when a blob is
  missing, so the model sees an empty attachment. The same invariant throws in
  `storedTurn.ts:361`, in
  `packages/harness/src/shared/schemas/requestPayloads.ts:93-95` and in
  `rowReader.ts`'s `blobs` (`packages/harness/src/controllers/session/rowReader.ts:262-267`).
  That is two policies for one miss.
- b. `toolUseDispatch.ts:590`: `dispatch.pluginOf.get(fact.toolName) ?? ''`.
  An unmapped tool reaches `checkOwnFacts` with no entry. With facts, it throws
  a misleading "fact is not its plugin's"
  (`packages/harness/src/tools/plugins.ts:291`). With none, it is silent.
- c. `packages/harness/src/agent/runtime/historyQuery/HistoryQuery.ts:163`:
  `args[index] ?? ''` joins persisted calls to parts by position. A count
  mismatch in stored data gives rows with empty arguments instead of an error.
- d. `packages/cli/src/chat/chatSessionController.ts:727-731`: a root run
  missing from the view, or one with no outcome, maps to `CliExitCode.Success`.
  A script that drives the CLI gets exit 0 for a lost run.
- e. `packages/cli/src/chat/tui/state/cliState.ts:177` and
  `sessionViewUpdate.ts:441`: an id in `order` or `childIds` with no run.
  The first drops the run from the list. The second undercounts `treeUsage`
  (cost and tokens).

**The shape.** One reader per structure that fails by name on a miss: a
`requireRun(view, id)` beside `view.runs`, and `blobs()` (which already throws)
for the upload's bytes. Where the join is positional (c), carry the pair
as one value at write time. For d, an absent outcome after `settledHere`
is a defect, so take the outcome from the run's own `run.end` instead.

**Size.** 6 sites and 2 small helpers, ~40 lines. Owner **E** for a, b, c
and the view half of e; **A** for d and `cliState.ts`.

### FB5. A withdrawn plugin on resume: its tools warn, its skills vanish

**Red flags:** two policies for one failure; silent degradation (reachable
today).

**Design cause.** "Something this run recorded is no longer offered" is
decided per kind of capability, inside the step that rebuilds them.

**Evidence:**

- `packages/harness/src/agent/runtime/agentToolResolution.ts:235-242` warns
  when a declared tool's plugin is unavailable.
- `packages/harness/src/agent/runtime/loop/step.ts:298`:
  `names.flatMap((name) => byName.get(name) ?? [])` drops an activated skill
  whose plugin is now off, with no warn. Reachable by disabling a plugin
  between turns.
- `step.ts:296` does the same for `recordedSkills`. That case is documented
  (`:292-293`).
- The tool path's own lookup is `?? ''` (`agentToolResolution.ts:235`). A
  declared tool absent from the catalog skips the warning.

**The shape.** One "recorded but not offered" pass over the run's recorded
capabilities (tools, skills, hooks). It warns once per name through
`AgentTrace` and returns what is offered. The two sites call it.

**Size.** 2 files, ~25 lines. Owner **E**.

### FB6. Absence and failure are one branch at a read boundary

**Red flags:** silent degradation (review-checklist §15, M2/M3); errors not
defined out of existence.

**Design cause.** These reads use a catch-all where `absentReason` or a typed
decode error would separate "nothing there" from "could not read". Each site
then justifies the merged branch in a comment.

**Evidence (6 sites):**

- a. `packages/llm/src/oauth/SubscriptionOAuthCoordinator.ts:210`: on sign-out,
  an unparseable stored session (which `loadSession` calls fatal) becomes
  `null`. Remote revocation (`endSession`) is skipped, the secret is deleted,
  and nothing is logged. The person sees "signed out" while the provider
  session may still be live. Reachable with a corrupt stored session.
  `ChatgptSessionCoordinator.vitest.ts:207` does not cover it.
- b. `packages/harness/src/tools/memory/memoryFileSystem.ts:185-191`: EACCES,
  I/O or a frontmatter parse failure all read as "no attribution", logged at
  debug.
- c. `packages/harness/src/agent/runtime/run/tools.ts:146`: stored tool
  arguments that no longer decode read as "not replayable", with no log. Only
  the defect branch at `:148` warns. The default is safe; the schema drift is
  invisible.
- d. `packages/texra/src/agent/output/revisionLatexdiffs.ts:259`: any
  `realPath` failure silently moves latexdiff's working directory.
- e. `packages/harness/src/tools/web/WebFetchTool.ts:221`: an unsupported
  charset decodes as UTF-8, and the model sees mojibake with no note.
- f. Borderline: `packages/texra/src/tools/agentCli/claudeAgentConfig.ts:67`
  (`access(F_OK)`: the comment argues both cases mean "no usable credential")
  and `packages/harness/src/controllers/session/storeSchema.ts:394` (a stat
  failure skips the move-aside, and the reconnect fails loudly).

**The shape.** `catchIf(absentReason, …)` for the absent case, with every
other cause going to `Effect.logWarning` and its `data`, or propagating. In
a, sign-out logs the unreadable session at warn and says the remote
session was not ended.

**Size.** 6 sites, ~30 lines. Owners **F** (a), **E** (b, c, e, f-storeSchema),
**C** (d, f-claude).

### FB7. The build layout is guessed from candidate lists, with two rules for one question

**Red flags:** errors not defined out of existence; two representations of
one fact; information leakage (the bundle layout known in three places).

**Design cause.** Where the package's resources and manifest live is a build
fact. Each host guesses it at run time from candidate paths.

**Evidence:**

- The CLI's `resolveCliResourcesPath` takes the first candidate directory that
  exists (`packages/cli/src/runtime/platform/resourcesPath.ts:35-42`). Run from
  source, a stale `dist/resources` wins over `../extension/resources` with no
  word.
- The desktop's `resolveResourcesPath` accepts a candidate only if it holds the
  bundled agents directory (`packages/desktop/src/main/platform/paths.ts:70-97`).
  That is a second rule for the same question.
- `readCliPackageManifest`
  (`packages/cli/src/runtime/platform/cliContext.ts:246-269`) tries three
  `package.json` candidates, and one (`../package.json`) is one no build
  produces. When none matches, `readCliVersion` reports `'unknown'`
  (`:283-285`) and the crash-report line silently disappears (`:296`).

**The shape.** The bundler writes the resolved locations into the bundle as
constants (it already knows the layout), and source runs use one dev
location. No candidate loop and no `'unknown'` version. If a loop stays,
one shared predicate ("holds the bundled agents directory") serves both
hosts.

**Size.** 3 files and the build script, ~40 lines. Owner **G**, with **A** for
the CLI half.

### FB8. A host's policy written as a condition on which host it is

**Red flags:** no option for a special case; two policies for one failure.

**Design cause.** A failure's handling depends on the host, and the shared
code branches on the host's name instead of the host passing the effect it
wants.

**Evidence:**

- `packages/texra/src/utils/system/updateCheck.ts:139-145`: an unsaved stamp
  is ignored with a warn when `host === 'cli'` and fails for the desktop.
  This is the residue of catalogue row G11 i
  (`../2026-11-06-design-red-flags-round-2/G-app-controllers.md:789-792`). The
  `stampFailure` option became a host branch, the same special case in a
  different form.
- `packages/texra/src/ui/wa/xtermTheme.ts:48-77`: a three-level colour chain
  with a `console.warn` for a pair the comment says "both hosts define".
  The `#1e1e1e` last resort is wrong in a light theme.
- `packages/cli/src/chat/tui/render/ansiMarkdown.ts:98-119,354`: an absent
  width is 80 for tables, 40 for rules and "fits everything" in
  `terminalText.ts`. Three policies for one missing fact, and the comment says
  callers always pass it. Make `width` required.

**The shape.** For `updateCheck.ts`, the caller decides: the CLI wraps the
stamp in `Effect.ignore({ log: 'Warn' })` at its own call site and the
shared code always fails. For the theme, a missing token is a host bug
reported once, with no colour invented. For `ansiMarkdown.ts`, a required
parameter.

**Size.** 3 files, ~25 lines, net negative. Owners **C** (`updateCheck.ts`),
**B** (`xtermTheme.ts`), **A** (`ansiMarkdown.ts`).

### FB9. A refusal's reason rebuilt by the catcher

**Red flags:** information leakage; errors not defined out of existence
(review-checklist §15, M5).

**Evidence:** two hosts catch `AgentCustomizeRefused` with a default and
re-narrate it as "has no newer built-in version to dismiss":
`packages/cli/src/commands/agents.ts:184-190` and
`packages/texra/src/controllers/settingsView/settingsAgentCommands.ts:357-362`.
Today `keep` refuses only for `reason: 'current'`
(`packages/harness/src/agent/index/AgentDirectoryService.ts:377`), so the text
is right by accident. `agents.ts:141` passes `refused.message` through. A new
refusal reason would get the wrong text in two hosts.

**The shape.** Show `refused.message`; the harness owns the wording.
**Size:** 2 sites, ~8 lines, net negative. Owners **A** and **C**.

### FB10. Batched: lone catches with no cluster behind them

- a. `packages/cli/src/runtime/platform/cliContext.ts:263`: a bare `catch {
  continue; }` with its reason above the `try`. It goes with FB7.
- b. `packages/texra/src/ui/litControllers/CopyButtonController.ts:15`: a
  clipboard denial returns `false` with no comment. The caller shows the
  failure, so add the one-line comment.
- c. `packages/harness/src/agent/runtime/loop/hooks.ts:223`:
  `run.workingDirectory ?? workspace ?? ''`. Harmless today: hooks need a
  workspace, and `:160` warns.
- d. `packages/texra/src/controllers/onboarding/setupLaunch.ts:83-88`: the
  setup run's own failure is logged at debug, on the promise that `start`
  presented it. Raise the log to warn, or drop it with the catch if the
  promise holds.
- e. `packages/texra/src/controllers/settingsView/modelSelection.ts:56`:
  `?? ''` on a helper model the catalog always names. The select shows blank
  where it should flag a missing default.

Each is a one-line change, owned by the file's package.

## Effect-native mapping

| Id   | Today                                                      | Effect-native shape                                                                                    |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| FB1  | `service \| undefined` threaded from open; log-only branch | A `where` value in the window's `SubscriptionRef<HostSnapshot>`; `linkOutage` a projection of it       |
| FB2  | optional `fallbackFrom?` field                             | A `Data.TaggedEnum` result matched with `Match.exhaustive`                                             |
| FB3  | `default:` / `Partial<Record>`                             | `Match.exhaustive` or `absurd`; a total `Record`; one `Schema` decode at the Codex boundary that warns |
| FB4  | `map.get(id) ?? default`                                   | A reader returning `Effect<A, NoSuchElementError>` (or a defect), and values carried instead of ids    |
| FB5  | per-kind filter with and without a warn                    | One `Effect.forEach` over recorded capabilities that logs through `AgentTrace`                         |
| FB6  | `Effect.catch(() => default)`                              | `Effect.catchIf(absentReason, …)`, then `Effect.tapError(Effect.logWarning)` or propagate              |
| FB7  | run-time candidate loop                                    | Build-time constants; no run-time search                                                               |
| FB8  | `host === 'cli' ? Effect.ignore(...) : stamp`              | The caller composes `Effect.ignore({ log: 'Warn' })`; shared code returns the typed failure            |
| FB9  | `catchTag(..., () => succeed(undefined))` + rebuilt text   | `catchTag` mapping to `refused.message`                                                                |
| FB10 | lone sites                                                 | comment or warn                                                                                        |

## Fix plan, by owner

These clusters cross packages, so each goes to **one owner per cause**:
FB1 (G; four hosts), FB2 (E; harness, texra, cli), FB3 (E leads; B and C
follow), FB6 (E leads, with F's llm site), FB7 (G with A's CLI half), FB8 and
FB9 (one PR each, by the file owners).

| Rank | Id   | Owner           | Defect today                                              | Fallbacks removed                       | Size       |
| ---- | ---- | --------------- | --------------------------------------------------------- | --------------------------------------- | ---------- |
| 1    | FB1  | G (B copy)      | yes: desktop never tells; e2e on the fallback             | 9 sites, 1 false comment                | ~6 files   |
| 2    | FB2  | E (C, A follow) | yes: delegation and compile fixer swap the model silently | 2 dropped notices, 1 dead row, 1 column | ~5 files   |
| 3    | FB4  | E (A)           | yes: CLI exit 0 for a lost run; empty upload              | 6                                       | ~40 lines  |
| 4    | FB3  | E (B, C)        | latent: privacy in trace export                           | 7                                       | ~40 lines  |
| 5    | FB6  | E (F, C)        | yes: sign-out skips revocation silently                   | 6                                       | ~30 lines  |
| 6    | FB5  | E               | yes: a skill vanishes on resume                           | 2 policies → 1                          | ~25 lines  |
| 7    | FB7  | G (A)           | latent: stale `dist/resources` wins                       | 3 candidate loops                       | ~40 lines  |
| 8    | FB8  | C, B, A         | no                                                        | 3                                       | ~25 lines  |
| 9    | FB9  | A, C            | no                                                        | 2                                       | ~8 lines   |
| 10   | FB10 | per file        | no                                                        | 5                                       | one-liners |

One PR per owner. E's is FB2 + FB3 a–d + FB4 a–c and e (view half) + FB5 +
FB6 b, c, e. G's is FB1 + FB7. A, B, C and F each take their lettered parts.
No fix adds a test beyond the testing budget: FB1 changes an e2e launch
option, and FB2's union is enforced by the compiler.

## Good, left alone

- **`decideRunModel` itself** (`runModelDecision.ts`) is the one precedence
  table (§15, L5). FB2 is about how its result is consumed and its two dead
  columns, not about the table.
- **The quota fallback to a stored key**
  (`packages/harness/src/agent/runtime/modelAccess/routeDecision.ts:172-215`,
  `ModelInvoker.ts:600-616`): automatic only for a key-credential plan with a
  stored key, recorded as a `decline` row and logged as `QUOTA_FALLBACK`. A
  `Secrets` read failure waits for a decision instead. A real alternative
  from a fact the code holds, and surfaced.
- **`JsonStore`** (`packages/harness/src/platform/defaults/jsonStore.ts:70,213-231`):
  only absence defaults. A parse error or EACCES propagates, and
  `unreadable` keeps writes failing, so a corrupt file is never overwritten.
  This is the model for persisted data (§15, "defaulted read feeding a
  whole-file write").
- **`runGeneratedFiles`**
  (`packages/harness/src/tools/executions/runGeneratedFiles.ts:87`): absence
  gives `[]`, a failure on the root propagates, a subdirectory failure warns.
  The three-way split FB6 asks for.
- **`MainViewRunLaunchController`**
  (`packages/texra/src/controllers/mainView/backend/MainViewRunLaunchController.ts:63`):
  `catchTags` separates `AgentNotFound` (launch as chat, with a banner) from
  `AgentCatalogLoadError` (rejected). L5.
- **The session store's damage path** (`storeSchema.ts:380-420`): moves a
  damaged store aside with a warn and only while it is the same file. Round 1
  B already judged it (`../2026-11-05-design-red-flags/B-session-store.md:676-720`).
- **`rowReader`'s damaged blob** (`rowReader.ts:243-260`): a bare
  `catch { continue; }`, but by design. The row naming the blob reads as
  damaged, and a strict read fails by name at `:262-267`.
- **`latexdiff`'s `--flatten` retry**
  (`packages/texra/src/latex/latexdiff.ts:134-175`): a second route for one
  classified failure, logged at warn. Already in round 2 I.
- **`latexPreview.readFileWithFallback`**
  (`packages/texra/src/tools/latex/latexPreview.ts:184-211`): absence is silent,
  any other failure warns that saved edits may be missing.
- **The xAI and ChatGPT `catchDecoding`** (`packages/llm/src/oauth/`): JWT
  display claims and provider fields at a provider boundary. Round 2 O
  (`../2026-11-06-design-red-flags-round-2/O-llm-providers.md:643-645,724-725`)
  already cited `expires_in`'s double default. Not repeated.
- **`PersistedState`** (`packages/texra/src/shared/state/PersistedState.ts:57`)
  forbids `catchDecoding` and routes invalid stored state through a loud
  warn-and-reset.
- **The CLI update checker** (`packages/cli/src/runtime/platform/updateChecker.ts:170,311`):
  a best-effort side check by policy (L3). Typed failures stay silent,
  defects warn, and it is never run-critical.
- **Display-only bare catches**: `transcriptText.ts:101` and `toolUse.ts:62`
  (YAML of an untyped payload), `EntryErrorBoundary.tsx:39`,
  `terminalCleanup.ts:42`, `desktopAppLog.ts:53,162,182`, `terminalPane.ts:142`,
  `desktopPtyHost.ts:149`, `fileDropHandler.ts:24`, `failureReply.ts:66,164`,
  `externalRoots.ts:210` (refuses on failure). Each is L1 or L3 with a
  comment.
- **The Lean agent's "CLI fallback"**
  (`packages/extension/resources/plugins/lean4/agents/lean.yaml:2`) names the
  direct-LSP backend for hosts without the VS Code extension
  (`packages/texra/src/tools/lean/leanLanguageServices.ts:6-7`). A backend per
  host, not a fallback. The word is loose and the behaviour is right.
- **The `default:` subset selectors** (`sessionEvent.ts:507`,
  `runRowReads.ts:263`, `TraceEmitter.ts:339`) are documented as subsets, unlike
  FB3 d.
