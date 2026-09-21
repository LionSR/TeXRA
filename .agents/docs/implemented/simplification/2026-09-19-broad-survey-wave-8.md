# Wave 8: the broad find-simplification survey

Status: implemented

Date: 2026-09-19
Baseline: `origin/main` at `893cc3dbbb`, after wave 7. Landed as ten PRs:
#12858, #12859, and #12861 through #12868.

## What this wave was

Waves 0 to 6 hunted one species at a time: Effect round trips, then dual
systems, then the host-side ports the re-survey named. Wave 8 was the opposite
shape, a broad find-simplification survey over the whole tree with no single
lens, run as ten disjoint lanes.

Before: the shared wire surfaces carried a batch API whose one caller always
passed a single-element array, an option no caller had ever supplied, and 22
blocks of hand-written review prose whose checker had been deleted a week
earlier. The ratchet suites carried an 834-line reconstruction of a barrel
surface to assert that four empty maps stayed empty, and an unbuilt webview
tree sat behind an alias that four separate gates had to name. The agent domain
re-parsed each snapshot slice a second time through a schema carved off the
composition that had just parsed it, and shipped a tool-injection registry that
nothing ever registered into. Tools spelled a run guard three ways and stated
eight input defaults twice, once in the schema's prose and once as a `??` at
the use site. The scratchpad conversion path probed for a `pandoc` binary on
every reflection round, so a machine with pandoc rendered differently from CI,
which only ever pinned the fallback. Eighteen symbols were exported for their
suites alone. Host ports carried a config probe with no production caller, a
second confirmation dialog and three members only one host answered. Four fixed
template variables were computed and persisted on every run, two of them
running the whole delegation roster through a formatter on every subagent
launch, and no prompt, template, doc or test read any of them. Model access
read ChatGPT credentials through a helper the usage service never used, and
asked the ChatGPT route a different question than the Grok route beside it. The
settings view spoke three private vocabularies for facts the wire or the
settings catalog already owned.

After: one caller-shaped API per surface, one scan per ratchet, one parse per
snapshot, one place for a default and one for the run guard, one conversion
path, eighteen fewer exports and a knip baseline of 158, one confirmation
dialog, one template vocabulary with a Zod owner, one credential source, and
one canonical spelling per settings fact.

## The ten PRs

- **#12858**, refactor(shared): delete the session and settings surfaces
  nothing reads. `applyCompactionActivityEntries` takes one entry rather than
  an array its one caller always built as `[entry]`,
  `settleCompactionActivities` loses the `throughSeqNo` nobody supplied, and
  `CliRuntimeReachability` with its 22 hand-written `->` chains goes, along
  with two doc comments still claiming a guardrail demanded them.
- **#12859**, refactor: collapse the empty gates and the unbuilt webview tree.
  The `@shared/schemas` deep-import ratchet falls from 834 lines to 116 and its
  baseline file is deleted; the unbuilt `packages/extension/src/webview/` tree
  folds into the progress view that was its only importer;
  `contributes.chatSkills` is generated rather than verified; `verifyConfigDeps`
  loses a `strict` parameter whose one caller always passed `true`; and the CI
  TUI smoke scenarios are tagged at their definition instead of spelled out in
  the workflow.
- **#12861**, refactor(agent): one parse per snapshot, one empty injection
  list, 16 file-local types unexported. Five run-time `.parse` calls per
  snapshot become one, `ToolInjectionRegistry` becomes the frozen
  `NO_TOOL_INJECTIONS`, and 16 types with no cross-file importer are demoted.
- **#12862**, refactor(tools): one place for a default, one place for the run
  guard. Eight bare `.nullish()` fields adopt `nullishWithDefault` so the
  default is stated beside the `describe()` text that advertises it, and six
  tools' copies of "this call has no run" collapse onto `requireToolRun`, which
  leaves exactly one sentence in the repo for that failure.
- **#12863**, refactor: retire the pandoc scratchpad tier and collapse the edge
  probes. The pandoc tier goes; `BinaryResolverService` becomes module
  functions; the Lean probe asks the `SetupPlatform` it already holds instead
  of a process getter; and two provider usage-limit parsers become one
  route-guarded registration. Carries its own dated note,
  [`2026-09-19-retire-pandoc-scratchpad-tier.md`](./2026-09-19-retire-pandoc-scratchpad-tier.md).
- **#12864**, refactor: burn down eighteen test-only exports and shrink the
  knip baseline to 158. Phase B of #12564: eighteen symbols lose their export
  or are deleted outright, two injection-seam parameters and one type parameter
  go with them, and no new test file is added.
- **#12865**, refactor: delete the host-port members and seams no host-neutral
  caller uses. `ConfigProvider.isExplicitlySet` and the whole `has` cascade
  beneath it; `confirmModal` as a second confirmation surface beside
  `VscodeUiHost.confirm`; `closeDiff`, `revealFirstChange` and
  `readProposedContent` onto `VscodeDiffViewHost`; one duplicated options
  declaration; and two exports with a single in-file reader.
- **#12866**, refactor(agent): retire the never-read UserVars template names,
  one Zod owner for the vocabulary. `WORKFLOW_AGENTS`, `TOOL_USE_AGENTS`,
  `IS_OPENAI_MODEL` and `IS_GOOGLE_MODEL` go; the hand-written `UserVars` type
  block is deleted in favour of `z.infer<typeof UserVarsSchema>`; and the
  forced `SESSION_EVENT_FORMAT` bump from 5 to 6 carries #12858's two deferred
  `StateOperation` arms with it.
- **#12867**, refactor(modelAccess): one credential source, one provider
  module, one signed-in probe. The usage service loads its ChatGPT credential
  through the coordinator it already used, `isCodexSessionRoutable` and its
  three siblings go, two provider modules merge, and the ChatGPT route arm asks
  the installed `isCodexSignedIn` probe exactly as the Grok arm beside it asks
  `isXaiSignedIn`.
- **#12868**, refactor(settings): the settings view speaks one vocabulary per
  fact. `SETTINGS_TAB_ORDER` is declared in the kebab form that crosses the
  wire and three projections plus `SettingsTabName` go; the ChatGPT and Grok
  status pair becomes one `SubscriptionAuthStatusSchema` carrying `provider`
  and one command; and the LaTeX tab re-keys onto the canonical `texra.*`
  catalog keys, with `LATEX_CONFIG_KEYS` proving both directions of the
  key-set correspondence the deleted projection carried.

## Rulings taken

- **The webview tree move proceeds, and its reason is the deleted config
  surface.** Moving `packages/extension/src/webview/` into the progress view
  deletes the `@webview/*` alias, two VS Code-free-zone entries, two host-layer
  import prefixes, one effect-ratchet boundary prefix and a stale self-test
  row. Tidiness alone would not have earned the churn; four gates that no
  longer have to name a tree did.
- **The LaTeX tab re-keys to the canonical `texra.*` catalog keys.** The
  defect it fixes is the dispatcher's silent drop of a 15th catalog row. The
  key set is proved in both directions at compile time, because a one-way
  `satisfies` only shows that each listed key is rendered, not that each
  rendered field is listed.
- **The CLI reachability metadata is deleted, not checked.** Review evidence
  that nothing verifies is not kept. Teaching the guardrail suite to parse each
  `->` chain and assert every hop would add a checker where the point is to
  remove one, and the chains are "reaches" chains rather than import chains, so
  an import-edge assertion fails on its own data.
- **N15 was narrowed and then refuted.** Moving `agentDirectories` off the
  ambient `Platform` onto a tag could not be narrowed to the one member,
  because two of the three composition roots build the port after they install
  the runtime that would have to serve it. Against about eight lines of saving
  that is a reorder of two roots and a module move. The single ambient read it
  would have removed is already one of the three sites the `platform()` ratchet
  holds frozen.
- **The kpathsea suite is dropped rather than rewritten around private
  helpers.** Their behavior is exercised through `compileLatex2Pdf`'s
  search-path path by one assertion on the `TEXINPUTS` the engine is handed, so
  the document directory still provably outranks the compiler's cwd. No new
  test file was added anywhere in the wave.
- **The tool run-guard wording is unified and `defineTool` is untouched.**
  "must be called from within an agent stream" and "This tool requires an
  active agent session." both become "… requires an active run context.",
  leaving one phrasing in the repo. Changing `defineTool`'s default `R` is an
  owner decision on the frozen SDK surface, so `packages/agent` was not opened.
- **The pandoc conversion tier is retired.** The model scratchpad renders
  through the existing Turndown and regex path, which markdown scratchpads,
  the overwhelming majority, already short-circuited to. Because this is a
  design-level retirement rather than a behavior-preserving cut, it ships with
  its own dated note and a user-facing changelog line.
- **The ChatGPT usage path is symmetrized with Grok's, and its
  concurrent-writer detection is dropped.** A sign-in that races a refresh now surfaces
  with the re-auth wording rather than the transient wording. `needsReauth` was
  re-checked before landing and still gets the right value: it was never on the
  deleted path, its producer is unchanged, and the test that pins it now drives
  the real coordinator.
- **The four template names are retired, not documented.** A custom agent YAML
  referencing one would silently substitute empty rather than error, because
  Nunjucks `throwOnUndefined` is off, so the retirement ships with a
  user-facing changelog entry naming all four. `IS_ANTHROPIC_MODEL` stays: five
  shipped agent YAMLs, `PromptBuilder` and both agent-creation schema docs use
  it.
- **A `SESSION_EVENT_FORMAT` bump is taken only when a real change forces one,
  and a forced bump then carries the dead arms.** #12858 dropped its
  `StateOperation` commit rather than clearing every session store for a
  deletion that buys no behavior, and recorded the evidence so the cut could
  ride the next forced bump. #12866 forced one, and took both cuts on the
  single move from 5 to 6.

## Refuted, so nobody re-mines them

- **Three auth error classes stay exported.** `SessionCompletionFailed`,
  `DeviceAuthorizationDenied` and `DeviceCodeExpired` look unused to knip, but
  demoting them fails `npm run typecheck` with TS4023 at both
  `loginWithDeviceCode` functions: the classes sit in an Effect error channel
  that `tsconfig.build.json` emits declarations for. A type-only re-export
  would move the baseline row rather than shrink it. The vocabulary stays
  half-exported until the SDK surface stops re-exporting those flows.
- **`applyReplacements`, `NON_REGEX_CATEGORIES` and `REGEX_CATEGORIES` stay
  exported.** The first is how 13 call sites exercise the exported rule tables;
  retargeting them means rewriting a 688-line suite and losing per-table
  precision. The latter two back a registry-versus-universe completeness
  assertion that guards a named silent-degradation bug, so deleting the export
  deletes an invariant rather than a test.
- **N12, folding `definition.ts` into `define.ts`, is skipped**, per the
  `defineTool` ruling above.
- **N2, one `failIfLaunchCancelled` helper**, is refuted on its own terms: the
  helper plus its doc comment costs more than the four line-pairs it saves, and
  eight further sites call `failIfLaunchStopped` alone, so the file would carry
  three cancellation-check spellings where it carries two.
- **`knip-baseline.json` did not shrink from #12861.** Knip was already not
  flagging those 16 symbols, since they are type-only or class exports used
  in-file. Shrinking that file was the separate burndown lane's job, and it did
  (166 to 158).
- Smaller ones the lanes recorded: restoring the deleted reachability
  guardrail; keeping `settleCompactionActivities`' `finishedAt` optional;
  `PlanTool`'s fourth flat run guard, `ExternalInquiryTool`'s two narrower
  ones, and `requireDelegationParent`, none of which the `ToolCallShape`-shaped
  helper reaches; `AcceptRunFilesTool`'s `original`, whose fallback is a
  sibling field rather than a constant; `LATEX_CONFIG_DEFAULTS` and
  `LATEX_CONFIG_RANGES`, which feed the catalog schemas themselves and have
  readers outside the settings view; and the three exotic module-loading forms
  the collapsed deep-import ratchet no longer scans for, which appear zero
  times in the tree.

## Open

- **Issue #12869**: retire the experimental OpenAI Responses WebSocket
  transport, about 411 lines plus the `ws` dependency, off by default, one
  caller. This is an owner product decision; the recommendation on file is to
  retire it. Filed beside it: `isCodexSignedIn` reports signed-out on an
  unreadable secret store with a loud warn, and making that a hard failure
  belongs in `getSubscriptionSessionStatus` for both providers, not in the
  probe.
- `extractScratchpad` is pure since #12863, so its `Effect` wrapper can be
  unwrapped in a one-line edit; it was deferred so
  `src/agent/runtime/loop/reflection.ts` had one owner during the wave.
- The six provider-keyed inbound subscription commands survive #12868's
  outbound unification; collapsing them is a settings pass with its own
  command-registry blast radius.
- `docs/architecture/2026-07-26-embedding-the-agent-runtime.md` still names the
  deleted `createNodePlatform` seven times. It needs its own PR because that
  file sits behind the `docs/` root-boundary gate.

## Related

- [`2026-09-17-effect-round-trips-and-dual-systems.md`](../../proposed/simplification/2026-09-17-effect-round-trips-and-dual-systems.md)
  is the campaign ledger waves 0 to 6 followed.
- [`2026-09-19-drain-and-recovery-one-owner.md`](./2026-09-19-drain-and-recovery-one-owner.md)
  is the wave before this one.
- [`2026-08-01-architecture-rulings-ledger.md`](../architecture/2026-08-01-architecture-rulings-ledger.md)
  carries the rulings above that constrain future work.
