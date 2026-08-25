# Simplification survey, 2026-08-25: 49 verified candidates

- **Date**: 2026-08-25
- **Status**: proposed
- **Surveyed at**: `8968988375` (clean `main`)
- **Scope**: 34 disjoint areas covering `src/`, `packages/*/src`, `scripts/`,
  `config/`, `packages/extension/resources/`, `prompts/`, and `supabase/functions/`

## 0. Method and headline

Thirty-four read-only survey agents ran one disjoint area each under the
`find-simplification` rules, capped at four candidates apiece and required to
dedupe against `label:tech-debt` issues (open and closed) and `git log` before
reporting. Every candidate that cleared a confidence floor then went to an
adversarial verifier prompted to refute it, defaulting to refuted under
uncertainty, re-running the greps independently across the non-obvious consumer
boundaries: `packages/extension/package.json` contributions,
`packages/extension/src/commands.ts` registration, the settings Zod schemas,
agent YAML under `packages/extension/resources/`, `prompts/`, and
`supabase/functions/`.

**91 candidates surveyed, 50 survived, 41 refuted.** After merging one
cross-area duplicate (both TUI agents found the same phantom `compactRows`
parameter from opposite sides of the partition), **49 distinct candidates**
remain.

Aggregate if all land: **-2793 LoC, -267 elements.** Every candidate is
a bounded deletion; none rose to a design-level change needing its own proposal.

Section 3 records the 41 refutations. That list is load-bearing: most were
killed by a dated ruling the claimant had missed, so re-finding them later is
wasted work. Check section 3 before filing anything in these areas.

## 1. PR plan

Seven disjoint-lane PRs, batched by path ownership so they can be written in
parallel and merged in any order. Small items are batched into their lane PR
rather than shipped one at a time.

| Lane           | Scope                                   | Items | PR     | Estimated net LoC | Measured net LoC |
| -------------- | --------------------------------------- | ----- | ------ | ----------------- | ---------------- |
| `L1-cli`       | CLI                                     | 7     | #11416 | -294              | -306             |
| `L2-extension` | Extension host and views                | 6     | #11417 | -209              | -294             |
| `L3-desktop`   | Desktop renderer                        | 3     | #11418 | -61               | -57              |
| `L4-agent`     | Agent runtime, flows, storage, handlers | 10    | #11419 | -266              | -341             |
| `L5-tools`     | Tools                                   | 7     | #11420 | -449              | -571             |
| `L6-shared`    | Shared, controllers, platform, utils    | 13    | #11421 | -402              | -439             |
| `L7-scripts`   | Scripts, config, resources              | 3     | #11422 | -1112             | -1181            |

All seven shipped. Measured total across the 223 changed files: +1236 / -4425,
net **-3189 LoC**, against a survey estimate of -2793. Forty-seven of the 49
items landed whole, two landed partially, and nothing was skipped outright.

Validation was central rather than per-lane, because the lane agents worked in
worktrees without `node_modules` and so had no typechecker. All seven branches
were merged into one integration branch, which passes `typecheck`, `lint`,
`test` (10,187 passed, 0 failed), and `check:dead-code-ratchet`. Each branch was
then re-validated on its own so that no PR depends on another lane's edit in
order to compile.

The lanes were less disjoint in practice than planned: `L2` edited 18 files
outside its allowlist and `L6` edited 11. That produced exactly one real merge
conflict, in `src/controllers/settingsView/SettingsViewHost.ts`, where `L6`
removed the zero-consumer `controllers.memory` injection seam while `L2` removed
the bespoke memory callbacks that the catalog row replaces. The resolution keeps
both deletions:

```ts
this.memoryController = new SettingsMemoryController({
  prompt: options.memoryPrompt,
});
```

Whichever of #11417 and #11421 merges second will need that resolution again.

Shared-file contention, resolved at merge rather than inside the lanes:

- `config/ratchets/knip-baseline.json` — several candidates across `L1`, `L2`,
  `L4`, and `L6` remove rows. Each lane removes only its own rows; conflicts are
  row-level and rebase cleanly.
- `src/shared/schemas/stateSettings.ts` — owned by `L2` for the memory-toggle
  fold. `L6` must not touch it.
- `src/tools/ExecutionsTool.ts` — owned by `L4` for the `waitForChange` fold.
  `L5` must not touch it.

## 2. Candidates

### L1-cli — CLI

**Paths**: `packages/cli/**`

#### Delete checkCliUpdateAvailable, a single-caller wrapper whose 214-line suite retests the shared state machine

- **Area**: `cli-runtime` · **Kind**: single-caller-wrapper · **Risk**: low
- **Net**: -247 LoC, -2 elements

**Evidence**

`packages/cli/src/runtime/updateChecker.ts:276-294` is `checkCliUpdateAvailable`, whose entire body is `return runDailyUpdateCheck({ ...args, lastCheckedAtKey: GlobalStateKey.CLI_UPDATE_CHECK_LAST_CHECKED_AT, stampFailure: 'ignore' })`. Production consumers: 0 outside its own file — the sole call site is `notifyCliUpdate` at updateChecker.ts:359, same file. Non-production consumers: 1 (`src/test-kernel/cli/UpdateChecker.vitest.ts:5,307,332`). It plus its 16-line options interface `CheckCliUpdateAvailableOptions` (updateChecker.ts:250-265) are both already carried in `config/ratchets/knip-baseline.json` as `production-dead` (lines 966-981), so this is a baseline row that can LEAVE rather than a new find. The shared machine it wraps, `runDailyUpdateCheck` (`src/utils/system/updateCheck.ts:38`, extracted by #9516 on 2026-08-01), already has its own suite at `src/test-kernel/utils/system/SemverUpdateCheck.vitest.ts:33-130` covering notify-before-stamp, no-repeat-notify, stale-source-no-stamp, and `stampFailure` throw/ignore. The CLI's `describe('checkCliUpdateAvailable')` block (`UpdateChecker.vitest.ts:307-520`, 214 lines) re-tests the same five behaviors — first-launch fetch, not-newer, same-day throttle, no-stamp-on-failed-fetch, stamp-only-after-notify — through a wrapper that contributes two constants. The other host over the same machine, `packages/desktop/src/main/desktopUpdateChecker.ts:113`, calls `runDailyUpdateCheck` directly with no wrapper.

**Proposal**

Inline the `runDailyUpdateCheck({...})` call (keeping the `lastCheckedAtKey` constant and the `stampFailure: 'ignore'` comment verbatim) into `notifyCliUpdate` at updateChecker.ts:359, delete `checkCliUpdateAvailable` and `CheckCliUpdateAvailableOptions`, remove both rows from `config/ratchets/knip-baseline.json`, and delete `UpdateChecker.vitest.ts:307-520` — the behavior it pins is owned by SemverUpdateCheck.vitest.ts. Keep every other test in UpdateChecker.vitest.ts (the `notifyCliUpdate` TTY/CI/install-method gating tests are CLI-specific and load-bearing). This is NOT the rejected item in docs/proposals/2026-08-25-cli-controller-seam-audit.md §4 ("Merging the CLI and desktop update checkers") — no host convergence is involved; the shared machine already exists and this only deletes the CLI-side pass-through over it.

**What we give up**

The named CLI seam for injecting `fetchLatest`/`notify`/`now`. Anyone later wanting to drive the CLI's daily-check policy from a test would go through `notifyCliUpdate` (which already has mock-based tests) or through the shared `runDailyUpdateCheck` suite.

**Verifier corrections to the evidence above**

Three corrections. (1) Call site is updateChecker.ts:348, not :359. (2) The redundancy claim mis-attributes the pins: src/test-kernel/utils/system/SemverUpdateCheck.vitest.ts:33-130 has five runDailyUpdateCheck tests — notify-before-stamp, no-repeat-notify (via lastNotifiedVersionKey, which the CLI never passes), stale-source-no-stamp, stampFailure throw-vs-ignore, and sync-stamp-failure. It contains NO daily-throttle-window test, NO undefined-version test, and NO notify-throws test, so it does not "own" the five CLI behaviors as claimed. Those three are pinned instead by the desktop suite over the same machine: src/test-kernel/desktop/DesktopUpdateChecker.vitest.ts:108 (throttles within the same day), :143 (no stamp on failed fetch), :177 (no stamp when notification fails). The behaviors therefore do remain covered after the CLI block is deleted — by the shared suite plus the desktop suite, a triple-pin — but the doc reason given in the candidate is wrong and must not be copied into the issue. (3) One CLI assertion is genuinely unique and must be migrated, not dropped: UpdateChecker.vitest.ts:485-505 asserts that a rejected stamp write STILL returns the latest version (the 06c578f2b2 / #8222-adjacent fix that motivated stampFailure:'ignore'); SemverUpdateCheck.vitest.ts:111-118 only asserts `resolves.toBeUndefined()` on a not-newer version, which would pass even if the machine swallowed an accepted update. Move that one case into SemverUpdateCheck.vitest.ts (~10 lines). Also note deleting the describe block frees the now-unused GlobalStateKey and FakeStateStore imports at UpdateChecker.vitest.ts:14,16 (both used only inside 307-520). Disclosed overlap confirmed accurate: docs/proposals/2026-08-07-prod-structural-leads-triage.md:146 records the broader "8 of 9 exports are test-only" lead for this exact file; it was never filed and never acted on (all ten exports present at HEAD), so this is a sharper subset rather than a duplicate — the issue should back-reference it so the other seven test-only exports are not re-discovered independently.

<details><summary>Verifier reasoning</summary>

The structural core survives independent verification. packages/cli/src/runtime/updateChecker.ts:276-294 is a zero-logic pass-through whose body is a single `return runDailyUpdateCheck({...})` adding only two literal arguments; its sole reference repo-wide is notifyCliUpdate at updateChecker.ts:348 (claim said :359) in the same file. My own grep of the symbol and both string forms across _.ts/tsx/json/js/mjs/yaml/md — including packages/extension/package.json, packages/extension/src/commands.ts, src/shared/schemas/coreSettings.ts and stateSettings.ts, packages/extension/resources/, prompts/, and supabase/functions/ — returns exactly three hits: the two knip-baseline rows (config/ratchets/knip-baseline.json:968,1010) and src/test-kernel/cli/UpdateChecker.vitest.ts:5,307,332. Zero production consumers. Not already done (git log -20 on the three paths: last structural change is 85ea40adf5 #9516, which created the shared machine and left the wrapper; `git log --all --grep checkCliUpdateAvailable` returns only the #8223/#8224 bugfix commits). Not already filed (gh issue searches for updateChecker / checkCliUpdateAvailable / "update check wrapper" return only CLOSED bugs #8223/#8224/#8222/#8168/#6625 and CLOSED #9515, whose body explicitly asked to "keep host-specific wiring at the call sites" — a two-constant pass-through is not wiring). Not deliberately justified: docs/proposals/2026-08-25-cli-controller-seam-audit.md:375 rejects merging the CLI and desktop update checkers, which is host convergence, not this; docs/proposals/2026-08-01-directory-organization.md:638 likewise only rejects the cross-host dedup hypothesis. No settled surface is touched: the knip baseline shrinks rather than widens, no @agent/_ edge, no PocketFlow engine, no browser-safe utils, no AgentEvent/SessionFact split, and no CLI result-JSON contract (so risk stays low, not high). Section 15 is clean: the masking `catch {}` lives in src/utils/system/updateCheck.ts:70-76 and is untouched; the proposal carries `stampFailure: 'ignore'` plus its comment verbatim to the inlined site. Section 14 R5/R6 passes: this removes elements (one exported function, one exported interface, two baseline rows) and forces no unrelated churn — the sole call site already constructs every remaining argument inline. Where the claim overreaches is coverage attribution, corrected below; that lowers the LoC a little but does not save the wrapper.

</details>

#### Drop the `compactRows` parameter from the scroll-bounds helpers — every call site passes the same constant

- **Area**: `cli-tui-state-input` · **Kind**: speculative-generality · **Risk**: low
- **Net**: -21 LoC, -5 elements
- **Note**: Found independently from both sides of the TUI partition (the panes/render agent and the state/input agent); merged into one item.

**Evidence**

`packages/cli/src/chat/tui/render/scrollBounds.ts:17` declares `COMPACT_SCROLLABLE_CONTENT_ROWS = 3` and its own docstring calls it "the single source of truth for the threshold every scroll-bounds caller uses as its `compactRows`". Five functions nevertheless thread it as a caller-supplied parameter: `maxScrollableRowOffset` (:34-47), `scrollBoundedRows` (:49-97), `compactAwareMaxScrollOffset` (:110-125), `scrollPageRows` (:128-138), `boundedScrollableLines` (:168-245). `rg -n "compactRows" packages src` returns 29 lines total; every one of the 11 call sites passes the literal constant — in-area: modals/ScrollableModalText.tsx:114,134,229 and modals/ExternalInquiry.tsx:167,188,227; out-of-area: render/DiffView.tsx:82,210 and the three internal recursions at scrollBounds.ts:79,189,225. Non-production consumers: zero — there is no `compactRows` occurrence anywhere under src/test-kernel/, so no test varies it either. Two of the in-area wrappers exist only to bind the constant and rename `maxRows` → `maxDisplayLines`: `modalTextMaxScrollOffset` (ScrollableModalText.tsx:106-118) and `boundedModalTextLines` (:120-141), both listed as `production-dead` in config/ratchets/knip-baseline.json.

**Proposal**

Read `COMPACT_SCROLLABLE_CONTENT_ROWS` directly inside the five scrollBounds functions and delete `compactRows` from their five option types and from all 11 call sites, dropping the constant's import from ScrollableModalText.tsx, ExternalInquiry.tsx and DiffView.tsx where it becomes unused. `modalTextMaxScrollOffset` and `boundedModalTextLines` then collapse to pure `maxRows`→`maxDisplayLines` renames; fold them into their callers and let them leave the knip baseline (removing two `production-dead` rows rather than adding any).

**What we give up**

The (unused) ability for one scrollable region to use a different compact-degradation threshold than the rest of the TUI. Restoring it later is a one-line parameter re-add.

**Verifier corrections to the evidence above**

Three corrections. (1) The import removal is false: COMPACT_SCROLLABLE_CONTENT_ROWS remains used in all three named files after the parameter drop — ScrollableModalText.tsx:49 (compactMaxRows) and :233, ExternalInquiry.tsx:164, DiffView.tsx:97 and :205 — so zero imports are dropped; the claim also missed a fourth importer, EditApproval.tsx:26,73,130,158, which never passes compactRows and is unaffected. (2) "Non-production consumers: zero" is true of the literal token but misleading: the two wrappers the claim wants folded are the test seam, with production callers at ScrollableModalText.tsx:219 and :234 and 10 test call sites in src/test-kernel/cli/ScrollableModalText.vitest.ts and src/test-kernel/cli/AgentProposal.vitest.ts; knip-baseline.json:353-365 lists them as "production-dead" meaning test-only export, not unused code. (3) LoC: the core drop is 5 destructure lines (scrollBounds.ts:35,50,111,129,169) + 5 type fields (:39,55,115,132,176) + 3 whole recursion-arg lines (:79,189,225, plus one inline word at :124) + 8 external call-site lines = -21, with no import lines recovered; the claimed -35 only reaches that figure by including the refuted wrapper fold.

<details><summary>Verifier reasoning</summary>

The core deletion survives my own verification, but the proposal must be cut in half. Verified: `rg -n "compactRows"` returns 29 lines in exactly 4 files, all under packages/cli/src/chat/tui/; all 11 argument sites pass the literal COMPACT_SCROLLABLE_CONTENT_ROWS (packages/cli/src/chat/tui/render/scrollBounds.ts:79,124,189,225 internal; modals/ScrollableModalText.tsx:114,134,229; modals/ExternalInquiry.tsx:167,188,227; render/DiffView.tsx:82,210). A repo-wide sweep over _.json/_.yaml/_.md/_.mjs (extension package.json contributions, commands.ts, coreSettings.ts/stateSettings.ts, resources/, prompts/, supabase/) finds zero occurrences outside that directory. No docs/proposals, docs/architecture, AGENTS.md, CLAUDE.md, or config/ratchets file mentions scrollBounds, compactRows, or COMPACT_SCROLLABLE. gh issue search for compactRows/scrollBounds returns only #4912 and #8627, both unrelated feature work. Not a settled surface (not the five ratchets, not @agent/*, not src/agent/node, not a host seam, no catch/fallback, no CLI result-JSON contract). Prior art strengthens rather than refutes it: `git log -S` shows compactRows genuinely carried three distinct constants (COMPACT_DIFF_DISPLAY_LINES, COMPACT_BASH_COMMAND_ROWS, COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS, all equal to 3) until #9990 (8b71e6149d, 2026-08-12) unified them into one constant and wrote the current docstring — so the seam is the unfinished half of a recent deliberate consolidation, and inlining it removes 5 parameters plus 11 threaded arguments, a real element reduction under checklist 14 R5. What I refute is the second half: modalTextMaxScrollOffset and boundedModalTextLines are NOT collapsible dead binders — they have live production callers in their own file at ScrollableModalText.tsx:219 and :234, and their knip `production-dead` rows mean "export consumed only by tests", with 10 real call sites in src/test-kernel/cli/ScrollableModalText.vitest.ts (8) and src/test-kernel/cli/AgentProposal.vitest.ts (2). Folding them would force rewriting two existing vitest suites for a behavior-preserving refactor, exactly the unrelated churn checklist 13 and the repo's "tests are a budget" rule warn against. File the parameter drop only, leave the two wrappers and their knip rows alone.

</details>

#### Delete the unreachable `openForm` escape hatch from ConfigForm/CliConfigForm

- **Area**: `cli-tui-state-input` · **Kind**: speculative-generality · **Risk**: low
- **Net**: -18 LoC, -2 elements

**Evidence**

`ConfigFormProps.openForm?: (formName: string) => void` (packages/cli/src/chat/tui/forms/ConfigForm.tsx:160) is consulted at exactly one site: `openNamedForm` (ConfigForm.tsx:305-310) — `if (props.formRenderers?.[name]) setMode(...); else props.openForm?.(name);`. Every name that can reach `openNamedForm` already has a renderer, so the `else` never fires. Proof of the closed name set: (a) ConfigForm.tsx:423-424 dispatches `category.startsWith('form:')`, and the only producer of `form:` rows is ConfigForm.tsx:397 mapping `props.formLinks`; (b) ConfigForm.tsx:468 dispatches `entry.openForm`, and the whole repo declares that catalog field exactly once — `src/shared/schemas/stateSettings.ts:1477: openForm: 'tools'` (grep for `openForm` under src/shared/schemas + src/shared/settingsView returns only stateSettings.ts:257 the declaration and :1477 the one use). The only production producer of `ConfigFormProps` is `createCliConfigFormProps` (packages/cli/src/chat/tui/forms/CliConfigForm.tsx:146, called at CliConfigForm.tsx:310), which supplies `formLinks` = agents / api-keys / github-token (CliConfigForm.tsx:202-218) and `formRenderers` = agents / api-keys / github-token / tools (CliConfigForm.tsx:219-259). Reachable names {agents, api-keys, github-token, tools} ⊆ formRenderers keys, so `props.openForm` is dead and the `?? <FormFrame>Configuration form unavailable.</FormFrame>` arm at ConfigForm.tsx:313-321 is likewise unreachable. Consumer counts (rg over packages + src): `openExternalForm` — production suppliers 1 (packages/cli/src/chat/tui/commands/registerBuiltins.tsx:712 `openExternalForm={(formName) => openCliSlashCommandForm(formName, '')}`); the other CliConfigForm mount, packages/cli/src/config/runConfigTui.tsx:12, does not pass it. `props.openForm` readers — 1 production (unreachable, ConfigForm.tsx:309) + 1 non-production (src/test-kernel/cli/ConfigForm.vitest.ts:819, which calls `props.openForm?.('tools')` directly, bypassing `openNamedForm`, and asserts `activeForm.get()?.commandName === 'tools'`). Born dead: `git log -S openExternalForm -- packages/cli` returns a single commit, c9407853f8 `feat: unify agent roster configuration (#8403)` (2026-07-14), which added the `tools` renderer and the `openExternalForm` wiring in the same change.

**Proposal**

Delete `ConfigFormProps.openForm` (ConfigForm.tsx:160), `CliConfigFormProps.openExternalForm` (CliConfigForm.tsx:46), the `openForm: props.openExternalForm` wiring (CliConfigForm.tsx:261), and the `openExternalForm={...}` JSX prop at registerBuiltins.tsx:712. Make `openNamedForm` set `{ kind: 'linked-form', name }` unconditionally so a future catalog `openForm:` name with no renderer lands on the existing `Configuration form unavailable.` frame (ConfigForm.tsx:313-321) instead of silently no-opping — the loud path replaces the dead branch rather than being deleted with it. Delete the now-untestable `delegates catalog form rows through the slash form registry` case and the `openForm?` field of the local props type in src/test-kernel/cli/ConfigForm.vitest.ts:199,817-822.

**What we give up**

The ability for a `/config` row to hand a form off to the slash-command registry (opening it as a standalone `/tools`-style form) instead of rendering it inline. Nothing exercises that today, and the inline renderer is the shipped behavior for all four names.

**Verifier corrections to the evidence above**

Two small corrections, neither load-bearing:

1. Claimed net LoC -30 is overstated. Actual deletions: ConfigForm.tsx:160 (1), the `openNamedForm` helper collapse including its 2-line comment (ConfigForm.tsx:304-310, ~5-6 net once the two call sites set `{ kind: 'linked-form', name }` directly), CliConfigForm.tsx:46 (1) plus its interface slot, CliConfigForm.tsx:261 (1), registerBuiltins.tsx:712 (1), test-kernel/cli/ConfigForm.vitest.ts:199 (1) and the 6-line `delegates catalog form rows through the slash form registry` case at :817-822. That totals about -18, not -30.

2. Line-range nit: `formLinks` in CliConfigForm.tsx is 200-217 (not 202-218) and the `openForm` prop read is ConfigForm.tsx:309 inside the helper spanning 304-310 (the claim's 305-310 omits the comment line). The `tools` catalog row at stateSettings.ts:1477 is additionally confirmed to carry `surfaces: { cliConfig: true }`, so it genuinely reaches CLI_STATE_SETTINGS — which strengthens rather than weakens the claim, since `tools` also has a renderer.

<details><summary>Verifier reasoning</summary>

I re-ran every grep independently and the dead-path argument holds.

Closed name set into `openNamedForm`: the only two call sites are packages/cli/src/chat/tui/forms/ConfigForm.tsx:424 (`category.startsWith('form:')`, and the only producer of `form:` rows is the `props.formLinks` map at ConfigForm.tsx:397-401) and ConfigForm.tsx:468 (`if (entry.openForm) openNamedForm(entry.openForm)`). A repo-wide `rg -n "openForm|openExternalForm"` (excluding node_modules) returns the catalog field declared once at src/shared/schemas/stateSettings.ts:257 and used exactly once at :1477 (`openForm: 'tools'` on the DISABLED_TOOLS row, `surfaces: { cliConfig: true }`, so it does reach CLI_STATE_SETTINGS). No other catalog row, no extension/desktop settings view, no resources YAML, no supabase function, no package.json contribution references it.

Sole production producer of `ConfigFormProps`: `createCliConfigFormProps` (CliConfigForm.tsx:146-266). `entries` is hardcoded to `CLI_STATE_SETTINGS`; `formLinks` = agents / api-keys / github-token (CliConfigForm.tsx:200-217); `formRenderers` = agents / api-keys / github-token / tools (CliConfigForm.tsx:219-259). Reachable set {agents, api-keys, github-token, tools} is a subset of the renderer keys, so `props.openForm?.(name)` at ConfigForm.tsx:309 can never fire in production, and the `?? <FormFrame>Configuration form unavailable.</FormFrame>` arm (ConfigForm.tsx:313-321) is currently unreachable too. `rg '<ConfigForm|<CliConfigForm'` finds only CliConfigForm.tsx:309, registerBuiltins.tsx:703, and runConfigTui.tsx:12 — the last of which passes no `openExternalForm`.

Born-dead confirmed: `git log -S openExternalForm --oneline -- packages/cli` returns only c9407853f8 (#8403), the same commit that added the `tools` inline renderer.

No deliberate ruling protects it. docs/proposals/2026-06-26-config-catalog-unification.md is the origin, not a defense: its MVP said `openForm` catalog entries "delegate to the existing ModelListForm/AgentListForm/..." via the slash registry — #8403 replaced that with native inline `formRenderers` and left the delegation prop behind. Not on any settled surface (CLI-only Ink form, no wire contract, no @agent deep import, no ratchet), not in config/ratchets/knip-baseline.json (only the sibling exports `createCliConfigFormProps`, `buildConfigListItems`, etc. are listed there, unaffected by removing a prop field). Not a checklist §15 masking case: the branch is an escape hatch, not an error-swallowing fallback, and the proposal replaces the silent no-op with the visible "Configuration form unavailable." frame — that makes the currently-dead fallback frame reachable rather than deleting a loud path.

Dedupe: `gh issue list --state all --limit 40 --search "ConfigForm in:title"` returns only #9783 (ENUM_CHROME_ROWS, unrelated); no issue mentions openExternalForm. No unrelated churn: removing the registerBuiltins.tsx:712 prop does not orphan `openCliSlashCommandForm`, which still has production callers at registerBuiltins.tsx:588 and handlers/approvalCommand.ts:26.

Only correction is the LoC arithmetic (below); everything else in the evidence checks out line-for-line.

</details>

#### Drop the `export` keyword from 18 CLI types with zero cross-file references

- **Area**: `cli-commands` · **Kind**: dead-export · **Risk**: low
- **Net**: -6 LoC, -18 elements

**Evidence**

Mechanical pass over every `export function|const|class|interface|type` declaration under the eight area paths, whole-word grep across the whole repo excluding the defining file and `config/ratchets/`. 18 symbols had ZERO hits outside their own file — all of them types. Production consumers: 0. Non-production (src/test-kernel/, docs, snapshots): 0. Ambiguous (scripts/): 0.

packages/cli/src/commands/_helpers/dispatch.ts:128 `ResolvedCliCommand` (self-use :173,:199,:484); :252 `NestedGlobalFlagGroup` (:266); :326 `UnknownCliCommand` (:366,:410); :422 `UnknownCliFlag` (:545,:570); :578 `UsageSection` (:588,:612,:618)
packages/cli/src/commands/_helpers/defineCliCommand.ts:18 `DefineCliCommandOptions` (:48)
packages/cli/src/commands/_helpers/cliAuthError.ts:9 `CliAuthResult` (:22)
packages/cli/src/commands/_helpers/subscriptionAuthCommand.ts:25 `DefineSubscriptionAuthCommandOptions` (:48)
packages/cli/src/commands/loginProviderPicker.tsx:14 `LoginPickerChoice` (:16,:26,:30,:61,:74,:75)
packages/cli/src/init/runInitWizard.tsx:25 `InitWizardAgentOption` (:30,:87); :29 `InitWizardOptions` (:95,:241); :35 `InitWizardResult` (:96,:242,:243)
packages/cli/src/onboarding/setupContinuation.ts:12 `FirstRunSetupContinuationInputs` (:28)
packages/cli/src/onboarding/runOnboarding.tsx:60 `CliOnboardingResult` (:101,:106,:119,:199,:207)
packages/cli/src/tui/ui/Select.tsx:33 `SelectProps` (:266)
packages/cli/src/tui/ui/KeyHints.tsx:16 `KeyHintsProps` (:63)
packages/cli/src/tui/ui/BorderedPanel.tsx:8 `BorderedPanelProps` (:32)
packages/cli/src/tui/ui/LoadingIndicator.tsx:30 `LoadingIndicatorProps` (:35)

Only one (`InitWizardAgentOption`) is in config/ratchets/knip-baseline.json — so this also removes a baseline row. The other 17 are invisible to the dead-code gate for exactly the reason recorded in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md §1 (a type reachable from an exported signature reads as used). Declaration emit is not a risk: packages/cli/tsconfig.json sets `noEmit: true` and no `declaration`, so TS4023 cannot fire.

**Proposal**

Delete the `export` keyword on those 18 declarations. Nothing else: no file moves, no signature changes, no renames. The compiler verifies each one. Same shape and same justification as #11386, which did this for `src/controllers/**`; the CLI command/tui/init/onboarding tree was outside that issue's scope and outside docs/proposals/2026-08-25-cli-controller-seam-audit.md (§0 scopes it to packages/cli/src/runtime/ and packages/cli/src/chat/tui/state/).

**What we give up**

Nothing behavioral. A future caller that wants one of these type names has to add `export` back — a one-word edit. `SelectProps`/`KeyHintsProps`/`BorderedPanelProps`/`LoadingIndicatorProps` stop being nameable by an outside component wrapper, which no component currently does.

**Verifier corrections to the evidence above**

Three corrections; none changes the verdict.

1. The blind-spot citation is wrong. §1 of docs/proposals/2026-08-19-dead-code-gate-blind-spots.md is "A test is a consumer", not "a type reachable from an exported signature reads as used". The mechanism the claim describes is asserted in docs/proposals/2026-08-25-cli-controller-seam-audit.md (§3, around lines 245-258) and is explicitly marked NOT established in blind-spots §4 ("Un-exporting a type is never flagged — mechanism unconfirmed", added 2026-08-25 from #11392): "treat the twelve as unexplained rather than as evidence for a fourth mechanism." The recorded gap that actually covers 17 of these 18 is blind-spots §2, "packages/cli exports are not reported" — whose mechanism the doc also calls undetermined. The issue should cite §2 + §4 and say the mechanism is open, not claim §1.

2. The grep method as stated is unsound in this repo, by the same document's "Related hazard" section: ~/.gitignore_global carries _gpt_/_sonnet_/_opus_/_gemini_/_o1_/_o3_/_o4_ patterns, so plain rg silently skips tracked source — including packages/cli/src/commands/chatgptAuth.ts, which sits inside one of the audited paths. I confirmed the file is invisible to plain `rg --files` and visible under `--no-ignore-vcs`. I re-ran all 18 with `--no-ignore-vcs -g '!dist' -g '!*.js'` and the zero-cross-file result holds, but the issue must record the corrected command or the evidence is not reproducible.

3. Prior art detail: #11386 was closed by merged PR #11392 / commit 3d8fba40d7, titled "un-export 13 symbols with no cross-file consumer" (13 landed, not the 12 the issue body listed). Worth naming the PR, not just the issue.

Also: the claimed net LoC of 0 is right for source but omits the baseline edit. config/ratchets/knip-baseline.json:742-747 is a six-line object for InitWizardAgentOption that must be deleted in the same PR.

<details><summary>Verifier reasoning</summary>

Survives. I re-verified all 18 symbols myself with `rg -nw --no-ignore-vcs -g '!node_modules' -g '!dist' -g '!out' -g '!*.js'` over the whole repo at HEAD afef057ae3 (that flag set matters — see corrections). Every one resolves to exactly one file: its own. No hits in packages/extension/package.json, packages/extension/src/commands.ts, src/shared/schemas/coreSettings.ts or stateSettings.ts, packages/extension/resources/, prompts/, supabase/functions/, scripts/, src/test-kernel/, or docs snapshots. No barrel re-exports them (`rg "export \*|export type \{"` over packages/cli/src/tui/ui, commands/_helpers, init, onboarding returns nothing). None is a string literal, command id, config key, event name, or wire string — all 18 are TypeScript types with no runtime identity.

Declaration-emit risk is genuinely nil, and I checked it independently rather than trusting the claim: packages/cli/tsconfig.json sets noEmit:true with no `declaration`, and the only tsconfig in the repo with `"declaration": true` is tsconfig.build.json, whose `include` is `["packages/agent/src/**/*.ts", "src/types/ambient.d.ts"]` — packages/cli is not reachable from packages/agent/src, so the TS4023 trap recorded in docs/proposals/2026-08-07-prod-structural-leads-triage.md:55 cannot fire here.

Not already done: `git log --all --oneline --grep=11386` shows the controller sweep landed as 3d8fba40d7 (PR #11392, merged 2026-08-25) and touched no CLI file; the 18 declarations still carry `export` at HEAD. Not already filed: `gh issue list --state all --search` for un-export / dead-export / CLI turns up only #11386 (CLOSED, implemented, scoped to src/controllers/**), #8901 and #8877 (both CLOSED, 2026-07-19, different surfaces), and #11409 (an unrelated docs-correction issue). No open duplicate.

Not a settled surface: this touches none of the five ratchets' invariants (it shrinks knip-baseline by one row, which is the sanctioned direction — scripts/check-dead-code-ratchet.mjs:143 explicitly asks for resolved entries to be removed and does not fail on them), none of the frozen @agent/* surface, the PocketFlow engine, the platform composition root, the six browser-reachable @utils modules, or the AgentEvent/SessionFact split. No catch/fallback is involved, so checklist §15 does not apply. It is not the CLI result-JSON contract consumed by texra-ai/texra-action — none of the 18 is serialized.

Checklist 14 R5/R6 and §13: this is a real element reduction (-18 exported symbols) with zero relocation of complexity and zero forced churn — the compiler proves each one, no signature or call site changes. It is also consistent with existing practice in the same tree rather than against a convention: WizardStepShellProps, StatusBarProps, InputBarProps, BaseTextInputProps, LogoutFormProps, ModelAccessFormProps, ConversationPaneProps and others in packages/cli/src/chat/tui/ are already declared without `export`. AGENTS.md/CLAUDE.md "Exports are contracts" backs the direction. Bounded deletion, so recordAs "issue", not a proposal.

One scope caveat the issue should state: the eight stated paths are not the whole species. Same-shape zero-cross-file Props types exist outside them (packages/cli/src/chat/tui/ has many exported *Props interfaces), so this is one bounded batch, not the closing sweep.

</details>

#### One owner for CLI usage rendering: route the launcher's Help through dispatch's showUsage, drop the inert `resume` interactive-command row

- **Area**: `cli-commands` · **Kind**: dual-representation · **Risk**: low
- **Net**: -2 LoC, 0 elements

**Evidence**

Three small single-owner leaks in the dispatch/usage seam, batched because each is a few lines.

(1) Two `showUsage` owners for the same root command. packages/cli/src/commands/_helpers/dispatch.ts:699 exports `showUsage`, which appends the `withUsageSections` blocks (:610, rendered at :660-673), honors the `--no-color` override (:630), and writes through `writeRawStdout`. Production consumers: root.ts:175 and help.ts:17,30 (2 files, 3 sites). But packages/cli/src/commands/orchestrate.ts:1 imports `showUsage` straight from `citty` and calls it at :379 on the SAME `rootCommand` — so the launcher's Help item prints root usage with the EXAMPLES/NOTES sections attached at root.ts:104-... silently missing, and ignores the `--no-color` override. citty-direct prod consumers: 1 (orchestrate.ts:379). Non-production: 2 comment mentions in src/test-kernel/cli/CliRootArgs.vitest.ts:1145,1171.

(2) Inert registry row. packages/cli/src/commands/_helpers/globalArgs.ts:163-168 `INTERACTIVE_COMMAND_NAMES = ['chat','orchestrate','setup','resume']`, whose docstring says these commands "reject the headless-only globals with the explicit 'interactive command' usage error". Sole prod consumer: dispatch.ts:496, which calls `addInteractiveHeadlessOnlyFlags` (:477) to register `print`/`output-format`/`no-input` as known flags. For `resume` that is a no-op twice over: resume.ts:21 spreads `AGENT_RUN_GLOBAL_ARGS`, which already contains all three (globalArgs.ts:66,82,101 via `GLOBAL_ARGS`), and `rejectHeadlessOnlyFlags` prod call sites are orchestrate.ts:399, chat.ts:41, setup.ts:72 — 3 files, none of them resume. `texra resume --print` is accepted, so the docstring is false for that row.

(3) Silent degradation. packages/cli/src/commands/orchestrate.ts:200 `getCliModelAccessList().catch((): readonly CliModelAccess[] => [])` — an M2 swallow with no log at any level. A failed registry read silently removes the launcher's model picker; CLAUDE.md "Silent degradation is a defect" requires a `warn` or no fallback, and review-checklist §15's `.catch(() => …)` rule wants the reason logged.

**Proposal**

(1) In orchestrate.ts, drop `showUsage` from the `citty` import at :1 and take it from `./_helpers/dispatch` alongside the `withUsageSections` import already there at :70; the call at :379 is signature-compatible (`showUsage(cmd, parent?, context?)`). One owner for CLI usage text. (2) Delete `'resume'` from INTERACTIVE_COMMAND_NAMES (globalArgs.ts:167) and drop the now-inaccurate half of its docstring; behavior is unchanged because the row is inert. (3) Add a `logger.warn` (or `writeTextStderr` note) in the orchestrate.ts:200 catch before returning `[]`, so a registry failure is visible instead of presenting as "no models available". Fix (3) is the one line that adds rather than removes; state it in the PR's R6 accounting. Nothing here touches packages/cli/src/schemas/cliOutput.ts or any emitCliResult field, so the texra-action result-JSON contract is untouched.

**What we give up**

Nothing. (1) changes what the launcher's Help prints — it gains the sections and color handling `texra help` already shows, which is the intended output; if anyone deliberately wanted a section-free root help there, that intent is undocumented and contradicted by help.ts. (2) removes a row whose only effect today is to make a docstring wrong. (3) trades one silent path for a logged one.

**Verifier corrections to the evidence above**

Three corrections. (a) Item (3) is not a §15 violation: the catch at orchestrate.ts:200 carries the required best-effort comment at orchestrate.ts:196-198 naming the consequence ("launches with the default model instead of blocking the launcher"), on a derived non-persisted read — it classifies L3, not M2. Drop it from the scope. (b) The claimed net LoC of -3 does not hold once (3) is dropped and (1) is priced correctly: (1) is a one-line import re-source, net 0 to +2 after prettier splits the dispatch import; (2) removes one array element plus roughly one docstring line. Real net is about -2. (c) Minor: the claim calls the sole prod consumer of INTERACTIVE_COMMAND_NAMES "dispatch.ts:496" — that is the `.includes` test inside `commandFlagSpecs` (dispatch.ts:483-503); the import is at dispatch.ts:27. Also worth stating in the PR that removing 'resume' is safe only because resume.ts:21 spreads the full `AGENT_RUN_GLOBAL_ARGS`; if resume ever narrows to `INTERACTIVE_AGENT_GLOBAL_ARGS`, the row would become load-bearing again.

<details><summary>Verifier reasoning</summary>

Partially survives: items (1) and (2) are confirmed by my own reading; item (3) is refuted and must be dropped, and the claimed net LoC is wrong.

(1) CONFIRMED. `packages/cli/src/commands/orchestrate.ts:1` really is `import { defineCommand, showUsage } from 'citty'`, and `:379` calls `await showUsage(rootCommand)` in the launcher's `case 'help'`. My own grep for `showUsage` across `packages` + `src` returns exactly one citty-sourced production call site (orchestrate.ts:1,379) against three dispatch-sourced ones (`packages/cli/src/commands/root.ts:175`, `packages/cli/src/commands/help.ts:17,30`); the only other hits are two comments in `src/test-kernel/cli/CliRootArgs.vitest.ts:1145,1171`. The divergence is real and user-visible: `packages/cli/src/commands/_helpers/dispatch.ts:699` → `renderUsageWithSections` (:659-675) appends the `withUsageSections` blocks and applies `usageColorEnabled`/`stripAnsi` for the `--no-color` override set by `setUsageColorOverrideFromRawArgs` (`root.ts:145`), while citty's `showUsage` does neither. `packages/cli/src/commands/root.ts:110-136` attaches the EXAMPLES block and the `Learn more: https://texra.ai` footer to `rootCommand`, and `src/test-kernel/cli/CliRootArgs.vitest.ts:1405-1415,1511-1515` asserts both appear for `--help` and bare `help` — so the launcher Help item is the one root-usage path that silently drops them. No import cycle: orchestrate.ts:70 already imports `withUsageSections` from the same module, and the signature `(cmd, parent?, context?)` is compatible.

(2) CONFIRMED INERT. `packages/cli/src/commands/_helpers/globalArgs.ts:163-168` lists `resume`; the only production consumer is `dispatch.ts:496`, which calls `addInteractiveHeadlessOnlyFlags` (:477) to register `print`/`output-format`/`no-input` as known flags. `packages/cli/src/commands/resume.ts:21` spreads `AGENT_RUN_GLOBAL_ARGS` (= `GLOBAL_ARGS` + `SKILL_SOURCE_ARGS`, globalArgs.ts:119-122), and `GLOBAL_ARGS` already defines all three (:66,:82,:101) with the identical def objects, so the second `addFlagSpec` call is a Map overwrite with the same spec. `rejectHeadlessOnlyFlags` prod call sites are only `orchestrate.ts:399`, `chat.ts:41`, `setup.ts:72` — resume never calls it, so `texra resume --print` is accepted and the docstring at :158-162 is false for that row. The mechanism stays load-bearing for chat/orchestrate/setup, which use `INTERACTIVE_GLOBAL_ARGS`/`INTERACTIVE_AGENT_GLOBAL_ARGS` (:139-152) and genuinely lack those three args.

(3) REFUTED. The claim says orchestrate.ts:200 is "an M2 swallow with no log at any level". §15's actual blocker rule is "`.catch(() => …)` without a best-effort comment", and the comment is present and specific at orchestrate.ts:196-198: "Load the model registry up front so the launcher can offer a model pick after an agent/team choice. Best-effort: an unavailable registry just launches with the default model instead of blocking the launcher." That is a documented L3 best-effort on a derived, non-persisted, non-run-critical read (`getCliModelAccessList` → `computeModelOptionsData`, a cached recompute, not a persisted-state or resume read, so the "no downgrade below warn" rule does not reach it). Adding a `logger.warn` is a net-additive change with no deletion, bundled into a candidate filed as `dual-representation`; it does not belong in this issue.

Nothing here touches `packages/cli/src/schemas/cliOutput.ts` or `emitCliResult`, so the texra-action result-JSON contract is untouched and risk stays low. No settled surface is involved (no ratchet, no `@agent/*` deep import, no PocketFlow/engine, no browser-safe utils, no AgentEvent/SessionFact split). Not already done: `git log --oneline -15` on orchestrate.ts/globalArgs.ts shows the most recent touches (4959fbb53e, da2a1c57cb, a442caa1e4) leave the citty import intact, and `git log --all --grep=showUsage` only returns the 2026-05 citty-migration commits (#4074/#4089); `--grep=INTERACTIVE_COMMAND_NAMES` returns nothing. Not filed: `gh issue list --state all --search "showUsage"` returns only the closed #4590 (stdout-vs-stderr on usage errors, a different concern, already fixed by `showUsageStderr` at dispatch.ts:689); searches for "launcher help usage sections" and "INTERACTIVE_COMMAND_NAMES resume" return zero rows. No ruling against it: no doc under docs/proposals, docs/architecture, docs/dev, AGENTS.md, or CLAUDE.md mentions `showUsage`, `INTERACTIVE_COMMAND_NAMES`, or `getCliModelAccessList` except `docs/architecture/2026-06-20-cli-runtime-round-trips.md`, and `docs/proposals/2026-08-25-cli-controller-seam-audit.md` covers the usage/defensive-copy seam, not this.

</details>

#### Unexport nine dead type/test-only symbols across cli tui panes and render

- **Area**: `cli-tui-panes-render` · **Kind**: dead-export · **Risk**: low
- **Net**: 0 LoC, -9 elements

**Evidence**

Nine exported symbols in this area have zero consumers outside their own file. Eight are types referenced only in-file, which the knip ratchet does not catch (they are absent from config/ratchets/knip-baseline.json — I enumerated all 30 entries for these paths): InfoPane.tsx:29 InfoPaneProps (only use InfoPane.tsx:39); Markdown.tsx:12 MarkdownProps (only Markdown.tsx:22); transcriptEntries.ts:367 StaticTranscriptScanResult (only :406); TodosPlanPanel.tsx:152 TodosPlanPanelProps (only :162); transcriptViewport.ts:59 TranscriptEntrySelection (only :72); tuiViewportController.ts:8 TuiRepaintTarget (only :28); tuiViewportController.ts:22 TuiViewportController (only :29); WorkflowRunDetails.tsx:46 WorkflowRunDetailLine (only :62, :85, :165, :253, :339). Production consumers outside the defining file: 0 each; non-production: 0 each; ambiguous (packages/cli/scripts, packages/trace-viewer, packages/desktop, packages/extension, docs): 0 each — tui-harness.tsx imports only the createTuiViewportController function, not the types. The ninth is ansiMarkdown.ts:551 _ansiMarkdownStatsForTests, a 12-line production export whose only consumers are src/test-kernel/cli/AnsiMarkdown.vitest.ts:972 and :974; it is currently grandfathered in config/ratchets/knip-baseline.json as production-dead. The test case it serves (AnsiMarkdown.vitest.ts:970-979) already proves memoization one line earlier with `expect(second).toBe(first)` (reference identity); the hits/misses deltas only re-pin the LRU's internal counters.

**Proposal**

Drop the `export` keyword from the eight types (leave the declarations, they are still used in-file). Delete _ansiMarkdownStatsForTests from ansiMarkdown.ts, remove the two hits/misses assertions and both stats calls from AnsiMarkdown.vitest.ts:971-979 (keeping `expect(second).toBe(first)`), and remove the corresponding row from config/ratchets/knip-baseline.json — a baseline shrink. Keep _resetAnsiMarkdownForTests: the module-level LRU is shared state and tests need the reset for isolation.

**What we give up**

Cross-file reuse of eight type names that nothing reuses today, and a test assertion on the ansi-markdown cache's internal hit/miss counters. Memoization stays covered by the reference-identity assertion in the same test.

**Verifier corrections to the evidence above**

The eight symbol locations and zero-consumer counts are correct as stated and independently reproduced. Three corrections. (1) The ninth item must be dropped: renderAnsiMarkdown returns `string` (ansiMarkdown.ts:536), so `expect(second).toBe(first)` (AnsiMarkdown.vitest.ts:975) does not prove memoization, and docs/proposals/2026-08-10-simplifier-fleet-round1-strategy.md:51 rules ...ForTests seams out of scope. (2) Net LoC is 0, not -16: removing an `export` keyword deletes no line, and the only line-deleting part of the proposal was the refuted ninth item. The real gain is -8 exported elements. (3) The claim's baseline enumeration is incomplete: config/ratchets/knip-baseline.json:556-561 also carries TuiRepaintOptions (kind "types") for packages/cli/src/chat/tui/render/tuiViewportController.ts:3, an in-file-only type in the very same file, which the scope should include (unexport it and drop that baseline row — the actual baseline shrink). Also note the precedent PR #11392 already landed this exact pattern for src/controllers/**, so the issue should cite it rather than re-argue the mechanism.

<details><summary>Verifier reasoning</summary>

The eight type unexports survive; the ninth item (the entire claimed LoC delta) is refuted on two independent grounds.

SURVIVES (8 types). My own repo-wide `grep -rn` over _.ts/_.tsx/_.json/_.md/*.mjs excluding node_modules and dist (plain grep, so the ~/.gitignore_global hazard recorded in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md does not apply) confirms zero cross-file references for all eight: InfoPaneProps (only packages/cli/src/chat/tui/panes/InfoPane.tsx:29,:39), MarkdownProps (render/Markdown.tsx:12,:22), StaticTranscriptScanResult (panes/transcriptEntries.ts:367,:406), TodosPlanPanelProps (panes/TodosPlanPanel.tsx:152,:162), TranscriptEntrySelection (panes/transcriptViewport.ts:59,:72), TuiRepaintTarget and TuiViewportController (render/tuiViewportController.ts:8,:22 and :28,:29), WorkflowRunDetailLine (panes/WorkflowRunDetails.tsx:46,:62,:85,:165,:253,:339). The only cross-file traffic in these files is to the _functions_: createTuiViewportController (runChatTui.tsx:85,:497 and scripts/tui-harness.tsx:120,:2428, plus src/test-kernel/cli/ConversationTranscript.vitest.ts:40) and selectWorkflowRunDetailLines (panes/ConversationPane.tsx:46,:273, src/test-kernel/cli/WorkflowRunDetails.vitest.ts). No barrel re-exports them (the only `export type {` under packages/cli/src/chat/tui is approvalQueue.ts:29, unrelated). Precedent is established and same-day: issue #11386 / PR #11392 "un-export 13 symbols with no cross-file consumer" did exactly this for src/controllers/** and merged 2026-08-25, with the mechanism recorded as the fourth gate blind spot in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md §4 (#11401). No open or closed issue covers packages/cli/src/chat/tui — tracking #11395 is controller-scoped and fully checked off.

REFUTED (item 9, _ansiMarkdownStatsForTests). (a) The claim's justification is factually wrong. packages/cli/src/chat/tui/render/ansiMarkdown.ts:533-536 declares `renderAnsiMarkdown(...): string`. Strings are primitives, so `expect(second).toBe(first)` at src/test-kernel/cli/AnsiMarkdown.vitest.ts:975 is a value comparison, not "reference identity" — it proves determinism, not memoization. Delete the two hits/misses assertions and the test named "memoises identical inputs (second call hits the cache)" passes with the LRU removed entirely. The stats seam is the only thing holding that regression. (b) A dated ruling contradicts it: docs/proposals/2026-08-10-simplifier-fleet-round1-strategy.md:51 — "Leave explicitly-named `...ForTests` seams alone." Its baseline row (config/ratchets/knip-baseline.json:556-561) is the sanctioned home for exactly this, alongside _resetAnsiMarkdownForTests, which the claim itself keeps — deleting one and keeping the other is inconsistent.

Missed item in scope: config/ratchets/knip-baseline.json already lists TuiRepaintOptions (render/tuiViewportController.ts:3) as production-dead/types — the one type in that file knip does flag — yet the claim, which asserts it "enumerated all 30 entries for these paths", omits it. Folding it in is the free baseline shrink here, not the ForTests deletion.

</details>

#### Un-export 31 CLI-runtime types with zero cross-file references

- **Area**: `cli-runtime` · **Kind**: dead-export · **Risk**: low
- **Net**: 0 LoC, -31 elements

**Evidence**

Mechanical pass over every `^export (function|const|class|interface|type|enum)` in `packages/cli/src/runtime/**` (76 files, 13,707 LoC), grepped whole-word against a production corpus of 1,674 files (`src/` minus `src/test-kernel/`, `packages/*/src`, `prompts/`, `scripts/`) and 896 `src/test-kernel/` files. 81 exports have zero production consumer; 31 of those have zero consumers ANYWHERE — every whole-word occurrence repo-wide (excluding docs/ and config/ratchets/) is inside the declaring file itself. Production consumers: 0. Non-production (test-kernel): 0. Verified none of the 31 is in `config/ratchets/knip-baseline.json` (43 CLI-runtime rows there; intersection is empty). Declarations: agents.ts:26 CliAgentListResult, agents.ts:31 CliAgentLaunchMode, chatDefaults.ts:40 ChatDefaults, chatDefaults.ts:218 ResolveChatDefaultsInit, cliConfig.ts:47 LoadedCliConfig, clipboardImage.ts:28 ClipboardAttachResult, clipboardText.ts:14 ClipboardTextWriteResult, cliStateStores.ts:8 CliStateStores, cliStateStores.ts:14 CliStateStoresInit, history.ts:91 CliHistoryDetails, history.ts:243 CliHistoryExportInputResult, history.ts:388 CliHistoryDeleteAllPreflight, modelAccess.ts:52 CliModelAccessListOptions, modelAccess.ts:62 CliModelAccessEntryOptions, modelAccess.ts:67 CliRunnableModelOptions, modelAccessSelection.ts:30 CliModelAccessSelectionResult, multiAgentPresets.ts:45 CliMultiAgentPresetListRecord, multiAgentRunPlan.ts:27 MultiAgentRunPlanLoadResult, multiAgentRunPlan.ts:32 MultiAgentPresetPlansLoadResult, oauthProviderDisplay.ts:7 CliOAuthProviderItem, skills.ts:18 CliSkillDiscoveryOptions, skills.ts:20 CliSkillRecord, subscriptionLogin.ts:76 CliSubscriptionSignOutResult, supabaseAuth.ts:56 CliLoginOptions, supabaseAuth.ts:163 CliDeviceLoginOptions, supabaseAuthDeviceCode.ts:42 DeviceAuthPollHooks, terminalRequirements.ts:1 InteractiveTerminalFailureReason, transcriptSession.ts:15 InteractiveTranscriptPolicy, transcriptSession.ts:22 CliTranscriptSession, workflowInputs.ts:316 ExpandedRunInputs, workflowPlainOutput.ts:24 WorkflowPlainOutputOptions (all paths under packages/cli/src/runtime/). This is exactly the gate blind spot documented in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md and re-stated in docs/proposals/2026-08-25-cli-controller-seam-audit.md §3.1 ("a type reachable from an exported signature counts as used, so one level of nesting hides it") — the audit fixed it for `src/controllers/**` only.

**Proposal**

Drop the `export` keyword on all 31 declarations. No file moves, no renames, no signature changes — the compiler verifies each one. `packages/cli/tsconfig.json` sets no `declaration`/`composite`, so there is no d.ts emit and no TS4023 hazard (unlike the `packages/agent` case that blocked the equivalent `DuplicateCallMap` fix). Explicitly out of scope, per the same rule the audit applied: the other 50 zero-production-consumer exports in this directory that DO have a test-kernel consumer (e.g. `resolvePagerCommand`, `findCliToolDef`, `formatDoctorText`) — those are the "a test is a consumer" species needing per-symbol judgement, not a blanket un-export.

**What we give up**

Nothing. No caller exists to lose. Cost is that a future consumer outside the file has to re-add one `export` keyword.

**Verifier corrections to the evidence above**

Three corrections, none fatal:

1. The mechanism attribution is wrong and cites retracted text. The claim says "this is exactly the gate blind spot documented in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md and re-stated in docs/proposals/2026-08-25-cli-controller-seam-audit.md §3.1 ('a type reachable from an exported signature counts as used')". At HEAD that doc's §4 ("Un-exporting a type is never flagged — mechanism unconfirmed", added 2026-08-25 via #11401) explicitly repudiates that sentence: "The **mechanism is not established**, and an earlier draft of this section got it wrong… Until someone produces one, treat the twelve as unexplained rather than as evidence for a fourth mechanism." §4 asks for "a specimen that is exported, has **no** test consumer, has no cross-file production consumer, and is still absent from the baseline" — which is precisely what these 31 are. So the correct framing is "these supply the specimen §4 requested", not "this is the documented §3.1 blind spot". (Relatedly, #11409 is OPEN about other backwards claims in the 2026-08-25 seam-audit doc, so quoting that doc as authority is doubly weak.)

2. `ChatDefaults` is not literally "every occurrence is inside the declaring file". There is one outside occurrence: `config/ratchets/host-agent-mock-baseline.json:5`, the string `"src/test-kernel/cli/ChatDefaults.vitest.ts"`. It is a test filename, not a symbol reference, so the conclusion is unchanged — but the claim's absolute phrasing is inaccurate and a reviewer re-running the grep will hit it.

3. Minor: `packages/cli/src/runtime/` has 70 top-level entries plus `approval/` and `history/` subdirectories; the "76 files, 13,707 LoC" figure was not reproduced and is not load-bearing.

Independently confirmed and correct: all 31 declarations exist at the stated file:line; every one is used in-file (so `export`-removal, not deletion, is the right fix); `packages/cli/tsconfig.json` sets `"noEmit": true` with no `declaration`, so the `DuplicateCallMap`/TS4023 hazard genuinely does not apply.

<details><summary>Verifier reasoning</summary>

I could not refute it. Independent verification of all 31 symbols:

(1) Zero cross-file references, re-verified with `rg --no-ignore-vcs -w <sym> -g '!node_modules' -g '!dist' -g '!.git' -g '!marketing' -g '!docs'` (the global-gitignore trap flagged in `docs/proposals/2026-08-19-dead-code-gate-blind-spots.md` was checked: `comm` between the default and `--no-ignore-vcs` file lists shows only `marketing/media/remotion/**` is hidden, and `packages/cli/src/commands/chatgptAuth.ts` is visible to plain `rg` on this machine today). 30/31 have literally zero occurrences outside their declaring file. The 31st (`ChatDefaults`) has exactly one, and it is a _filename_ string, not a reference: `config/ratchets/host-agent-mock-baseline.json:5` → `"src/test-kernel/cli/ChatDefaults.vitest.ts"`. That test file's imports are `resolveChatDefaults`-shaped, not the type. So: 0 production consumers, 0 test-kernel consumers, 0 in `prompts/`, `packages/extension/resources/`, `packages/extension/package.json`, `commands.ts`, `coreSettings.ts`/`stateSettings.ts`, `supabase/functions/`.

(2) Un-exporting is mechanically safe here. Every one of the 31 is used _within_ its own file (in-file whole-word occurrence counts 2–6, so none becomes an orphan needing deletion instead), root `tsconfig.json` sets no `noUnusedLocals`, `@typescript-eslint/no-unused-vars` is `'off'` (`eslint.config.mjs:647`), no tsconfig in the repo sets `declaration`/`composite`/`isolatedDeclarations`, and there is no `export *` anywhere in `packages/cli/src`. So no TS4023 hazard and no unrelated churn.

(3) Not already done: `git log --oneline -20 -- packages/cli/src/runtime/` — the nearest commits (`897ffd18c2` "retire five export-only-for-tests symbols", `aabef786b5`, `2a4fc6b472`) touched none of the 31; all 31 `export` keywords are present at HEAD.

(4) Not already filed. `gh issue list --state all --search "un-export"` returns #11386 (CLOSED/COMPLETED, scoped in its body to "all 193 exports in `src/controllers/**`"), #11385 (approvalPolicy constants), #10523 (a single Kimi helper), #8901 (2026-07-19 repo-wide knip zero-ref sweep). Tracking issue #11395's child list is complete and contains no CLI-runtime child. This is the untouched sibling scope, not a duplicate.

(5) Not a settled surface. `packages/cli` is a host, not the frozen `@agent/*` SDK; none of the five ratchets, the PocketFlow engine, the six browser-reachable `@utils` modules, or the AgentEvent/SessionFact split is involved. Confirmed empty intersection with the 43 `packages/cli/src/runtime/**` rows in `config/ratchets/knip-baseline.json` (all 43 are `production-dead`, i.e. test-alive — a different species). Un-exporting cannot _add_ a knip finding, so the ratchet cannot flap.

(6) Checklist 14 R5/R6 / 13: this is a real element reduction (−31 exported symbols across ~25 files) at exactly 0 LoC and 0 behavior change, with a one-day-old accepted precedent of the identical species (#11386 → merged as #11392, which likewise un-exported return/param types of still-exported functions). No catch/fallback is touched, so §15 M1–M6 does not apply. No effect on the CLI result-JSON contract consumed by texra-ai/texra-action — un-exporting a type changes no emitted JSON — so risk stays low.

One thing worth flagging for whoever writes this up: these 31 are the _missing specimen_ that §4 of the blind-spots doc asks for, so the issue is also a gate-diagnosis input, not only a cleanup.

</details>

### L2-extension — Extension host and views

**Paths**: `packages/extension/**`, plus exclusive ownership of `src/shared/schemas/stateSettings.ts`

#### Fold the bespoke memory-enabled toggle vertical into a stateSettings catalog row

- **Area**: `ext-settingsview` · **Kind**: dual-representation · **Risk**: low
- **Net**: -110 LoC, -9 elements

**Evidence**

`texra.memory.enabled` is the last settings-view boolean with a hand-built 12-file vertical instead of a catalog row. Production consumers of the `SET_MEMORY_ENABLED`/`UPDATE_MEMORY_ENABLED` pair and its frontend state (grepped `rg -l "SET_MEMORY_ENABLED|UPDATE_MEMORY_ENABLED|setMemoryEnabled|sendMemoryEnabled|memoryToggleDisabled|memory-toggle" src packages`): 12 production files — packages/extension/src/settingsView/frontend/components/memory/MemoryToggle.ts:15-45 (a whole Lit custom element whose entire body is one `renderSettingsToggleRow` + one `postMessage`), tabs/MemoryTab.ts:42,77-80, frontend/settingsState.ts:152-153 (`memoryEnabled`, `memoryToggleDisabled`), frontend/slices/memorySlice.ts:21-24, frontend/SettingsApp.ts:98,484, handlers/memoryHandlers.ts:35-39,123-126, SettingsViewMessageHandler.ts:258-259,442, src/shared/ipc.ts:206-207,230,312, src/shared/schemas/memoryViewMessages.ts:54,91, src/controllers/settingsView/SettingsMemoryController.ts:16,63-67,89-92, src/controllers/settingsView/SettingsViewHost.ts:56-62,101,115-121, packages/desktop/src/main/desktopSettingsIpc.ts:193,412-413. Non-production: 3 test files (src/test-kernel/controllers/SettingsViewHost.vitest.ts:56-66, controllers/SettingsMemoryController.vitest.ts:54,125-126, desktop/DesktopSettingsIpc.vitest.ts:996-1004). Ambiguous: none. Contrast the identical-shaped `GlobalStateKey.ALLOW_ORCHESTRATOR_KILL` row at src/shared/schemas/stateSettings.ts:1051-1063 — 13 lines, zero commands, zero controller methods, rendered by the shared `renderStateSettingToggleRow` (packages/extension/src/settingsView/frontend/components/shared/stateSettingRows.ts:60-77) and written by the shared `updateStateSetting` path (SettingsViewMessageHandler.ts:524-563). `texra.memory.enabled` does not appear in stateSettings.ts or coreSettings.ts at all (`rg -n MEMORY_ENABLED src/shared/schemas/` → 0 hits). The duplication already produced a live defect: docs/proposals/2026-08-04-ssot-consolidation-part-2.md:124-133 (item G6) records that src/agent/features.ts:12 defaults the key to `true` while settingsState.ts initializes the signal to `false`, so the Memory tab first-paints "off" for users who have memory on — still unfixed on main.

**Proposal**

Add one `surfacedSetting` row for `GlobalStateKey.MEMORY_ENABLED` (schema `z.boolean().prefault(true)`, `slots: sameSlot('globalState')`, `honoredBy` evidence `src/agent/features.ts`, `surfaces: { settingsView: 'memory' }`). Replace `<memory-toggle>` with `renderStateSettingToggleRow({ key: GlobalStateKey.MEMORY_ENABLED, ... })` inside MemoryTab.render and delete MemoryToggle.ts. Replace the `memoryEnabled`/`memoryToggleDisabled` signal pair with one `settingSignal<boolean>(GlobalStateKey.MEMORY_ENABLED)` (which starts at the row default, fixing G6). Add a `'memory'` member to `SettingsViewSnapshot` with a `rebroadcastSnapshot('memory')` case in `postStateSettingSnapshot`, and swap the `sendAllData` line to `sendSettingsSnapshot(webview, 'memory')`. Then delete: the `SET_MEMORY_ENABLED`/`UPDATE_MEMORY_ENABLED` constants and their two Zod message members, `SettingsMemoryController.getMemoryEnabledMessage`/`setMemoryEnabled` and its `isMemoryEnabled`/`setMemoryEnabled` deps, `SettingsViewHost.sendMemoryEnabled`/`setMemoryEnabled`, `MemoryHandlers.sendMemoryEnabled`/`handleSetMemoryEnabled`, the memorySlice handler, and the desktop IPC arms — plus the three test sections that only pin the retired commands. The storage key is unchanged, so src/agent/features.ts and every persisted value keep working. Spans src/shared, src/controllers and packages/desktop as well as this area; the catalog write path (`applyStateSettingUpdate`) already serves both hosts for globalState rows, so no new host wiring is needed.

**What we give up**

The bespoke `memoryToggleDisabled` "disabled until the backend answers" gate disappears; the switch instead renders the catalog default (`true`) until the snapshot lands, exactly like the other twelve catalog-backed toggles in this view. That is the intended behavior per the DEFAULT_GIT_MARK_COMMITS precedent (src/shared/schemas/stateSettings.ts:49-56) and it is what fixes G6, but it is a visible change from today's briefly-greyed switch.

**Verifier corrections to the evidence above**

Two corrections, neither fatal. (a) "The last settings-view boolean with a hand-built vertical" is false: `texra.inlineCriticism.enabled` still has the full GET/SET/UPDATE trio (src/shared/ipc.ts:298-299 and 329, src/shared/schemas/settingsViewMessages.ts:623,897,900, packages/extension/src/settingsView/frontend/settingsState.ts:314, SettingsViewMessageHandler.ts:466). It was deliberately exempted by #9412 as extension-only by design, so the accurate framing is "the last cross-host one", which is what makes it in-scope rather than exempt. (b) The claim's rationale for keeping the row off the CLI surface rests on stale doc evidence, and the doc it would rest on is now wrong in the user's favor: docs/proposals/2026-06-26-config-catalog-unification.md:142 excludes `texra.memory.enabled` from `/config` because `registerAgentFeatures()` is "never called in the CLI", but packages/cli/src/runtime/initPlatform.ts:326 calls `initNodeAgentRuntime`, which calls `registerAgentFeatures()` at src/platform/defaults/nodeAgentRuntime.ts:33. The CLI honors the key today, so `honoredBy: everyHost('src/agent/features.ts', <reachability>)` is defensible and `cliConfig` is optional rather than forbidden; the implementer must either supply the reachability trace (required by the guardrail at stateSettings.vitest.ts:213-243 whenever cliConfig is set) or omit cliConfig and drop honoredBy.cli, not silently claim a cli honor with no slot. Additionally, the touch list omits four small addition sites the fold requires: the `SettingsViewSnapshot` union (src/shared/schemas/stateSettings.ts:116-124), `SETTINGS_SNAPSHOT_COMMANDS` (src/shared/schemas/settingsViewMessages.ts:197-204), the desktop `postInitialSettingsData` awaits at packages/desktop/src/main/desktopSettingsIpc.ts:193 AND 201 (the claim lists only 193), and the `EXPECTED_DEFAULTS` table in src/test-kernel/shared/stateSettings.vitest.ts. All are one-to-two-line additions and all are compile- or test-enforced.

<details><summary>Verifier reasoning</summary>

Survives. (1) Consumer set verified independently: my own `rg -n "SET_MEMORY_ENABLED|UPDATE_MEMORY_ENABLED|setMemoryEnabled|sendMemoryEnabled|memoryToggleDisabled|memory-toggle|memoryEnabled|MEMORY_ENABLED" src packages` reproduces exactly the 12 production files plus 3 test files, no extras. Critically, `MEMORY_VIEW_COMMANDS` (src/shared/ipc.ts:197-211) is referenced only by src/shared/ipc.ts and src/shared/schemas/memoryViewMessages.ts — the old standalone memory view is gone, so the SET_/UPDATE_MEMORY_ENABLED pair is settings-view-only and the deletion is contained. Zero hits in packages/extension/package.json contributions, packages/extension/src/commands.ts, packages/extension/resources/, prompts/, supabase/functions/, or config/ratchets. (2) The target machinery is real and generic, so this is a fold onto an existing path, not a new one: `settingSignal` (packages/extension/src/settingsView/frontend/settingsState.ts:102-111) already seeds the signal from the row's `.prefault()` — which is precisely the G6 fix — `applySettingsSnapshot` (settingsState.ts:120-133) fans a snapshot out with no per-setting slice line, `renderStateSettingToggleRow` (components/shared/stateSettingRows.ts:60-77) posts the write itself, and `applyStateSettingUpdate` (src/shared/settingsView/handlers/stateSettingWrite.ts:116) already serves both graphical hosts for globalState rows. `SettingsSnapshotPosters` is a total Record over `SettingsViewSnapshot`, so adding a `'memory'` member is compile-forced into both the extension map (SettingsViewMessageHandler.ts:575-596) and the desktop map (desktopSettingsIpc.ts:230-244) — a missed host arm is a type error, not a silent break. The catalog guardrails (src/test-kernel/shared/stateSettings.vitest.ts:162-260) permit a settingsView-only row; they only require an existing reader file per honoring host and a slot for each honoring host, both satisfiable by `src/agent/features.ts:12` + `sameSlot('globalState')`. (3) Not already done: `git log` over MemoryToggle.ts / SettingsMemoryController.ts / memoryViewMessages.ts shows only generic sweeps (#10875, #10609, #10157, #9951, #9467); no commit touches the command pair. (4) Not already filed: no tech-debt issue names memory-enabled, MemoryToggle, or SET_MEMORY_ENABLED. #9412 (CLOSED COMPLETED) is the same class but its stated scope was bash-approval, agent-skills, the orchestration toggles and SET_LATEX_CONFIG_VALUE, exempting only inlineCriticism as extension-only; memory is absent from it, so this is the residual member, not a re-file. #6606 (settings-catalog promotion, CLOSED) enumerates streaming/endpoints/models/tools/presets/codex/claude and does not cover memory. (5) No deliberate-design ruling protects the vertical — the opposite: docs/proposals/2026-08-04-ssot-consolidation-part-2.md K3 (line 344-348) rules the end-state as "add the missing catalog rows" and names G6 as its live instance, and G6 (line 124-133) reproduces on main today (src/agent/features.ts:12 defaults true; settingsState.ts:152 initializes false). (6) Settled surfaces untouched: no ratchet, no @agent/* SDK edge, no PocketFlow engine, no host/platform composition root, no browser-safe @utils set, no AgentEvent/SessionFact change. No catch/fallback is deleted — `memoryToggleDisabled` is a pre-snapshot input guard, not a masking site, and the catalog default supersedes its purpose (the same pattern the DEFAULT_GIT_MARK_COMMITS comment endorses). (7) R5/R6: this removes elements rather than relocating them — one Lit custom element, two wire command literals, two Zod message schemas, two controller methods plus two controller deps, two SettingsViewHost methods, two extension handler methods, and two desktop IPC arms all go, replaced by one declarative catalog row plus two one-line poster arms. It does not force unrelated churn: the storage key is unchanged so src/agent/features.ts and every persisted value keep working. (8) No CLI result-JSON contract involvement, so risk stays off the high rung.

</details>

#### Collapse modelOptionsByCategory: four producers write the same array under both keys

- **Area**: `ext-host` · **Kind**: dual-representation · **Risk**: low
- **Net**: -35 LoC, -4 elements

**Evidence**

`packages/extension/src/frontend/agents/optionsLoader.ts:10-16` says it in the source: "Model options no longer vary by agent category; both pickers read the same list" — it calls `computeModelOptionsData()` once and returns `{ workflow: options, toolUse: options }`. Every other producer does the same: `packages/desktop/src/main/desktopMainViewStartup.ts:49-52` (`workflow: modelOptions, toolUse: modelOptions`) and `packages/desktop/src/main/desktopCredentialSettingsController.ts:243-246` (identical). The wire schema still carries the split at `src/shared/schemas/mainView/outbound.ts:31-34`, the controller type at `src/controllers/mainView/MainViewStartupController.ts:24-27`, and the extension re-declares it as `MainViewModelOptionsByCategory` at `packages/extension/src/frontend/agents/optionsLoader.ts:7-8` (used at `packages/extension/src/commands/system/mainViewCommands.ts:25-32`). The consumer splits it straight back into two identical store fields — `packages/extension/src/webview/frontend/slices/catalogSlice.ts:71-74` into `sessionModelOptions$` (`packages/extension/src/webview/frontend/mainViewState.ts:138-140`) — and then re-derives by session type at `mainViewState.ts:199-203`, whose answer cannot differ. Proof that callers already know they are identical: `packages/extension/src/progressView/ProgressViewMessageHandler.ts:706-707` just takes `.workflow` arbitrarily. Consumers of the by-category shape: production 10 (3 producers, 1 schema, 1 controller, 5 extension/webview sites listed above); non-production 4 (`src/test-kernel/controllers/MainViewStartupController.vitest.ts:21,46,87`, `src/test-kernel/desktop/ElectronMainViewIpc.vitest.ts:66,210`); ambiguous 0. Note `agentOptions` genuinely does vary by category and must stay split — only the model half is degenerate. The fix spans `src/shared/schemas/`, `src/controllers/`, and `packages/desktop/` outside my paths.

**Proposal**

Replace `optionsDataByCategory: { workflow, toolUse }` with `optionsData: ModelOptionData[]` in `SetModelOptionsMessageSchema`; make `MainViewStartupOptions.modelOptionsByCategory` a flat `modelOptions: ModelOptionData[]`. Delete `loadMainViewModelOptions` and the `MainViewModelOptionsByCategory` type from `optionsLoader.ts` (its body becomes the direct `computeModelOptionsData()` call already present in `loadOptions`). Flatten `sessionModelOptions$` to `modelOptions$: ModelOptionData[]` and delete `getModelOptionsForSession(sessionType)`, whose three call sites (`mainViewState.ts:245`, `mainViewActions.ts:135`, `slices/bannerSlice.ts:28`) read the signal directly. Same-process/same-bundle wire between an extension host and its own webview, so no persisted-format migration is involved.

**What we give up**

The ability to serve a different model list per session type (workflow vs tool-use) without re-plumbing the wire. If per-category model filtering is a planned product direction, this is a feature decision and should be rejected — but nothing in the tree registers that intent, and the only in-repo comment on it states the opposite.

**Verifier corrections to the evidence above**

Three corrections to the census, none fatal.

(1) The claim says "3 producers" and misses a fourth extension sender: `packages/extension/src/webview/MainViewProvider.ts:285-289` (`refreshModelOptions` calls `loadMainViewModelOptions()` and posts `optionsDataByCategory`). Full sender set is `packages/extension/src/commands/system/mainViewCommands.ts:25-32,83-87`, `packages/extension/src/webview/MainViewProvider.ts:285-289`, `packages/desktop/src/main/desktopMainViewStartup.ts:41-53`, `packages/desktop/src/main/desktopCredentialSettingsController.ts:238-248`, plus the controller relay at `src/controllers/mainView/MainViewStartupController.ts:81-83`.

(2) Non-production sites are 5, not 4: the claim misses `src/test-kernel/webview/SidebarSurfaceOwnership.vitest.ts:82`, which mocks `loadMainViewModelOptions` and would need updating.

(3) Two line-range fixes plus a bonus deletion: the wire schema is `src/shared/schemas/mainView/outbound.ts:29-34`, and its `AgentCategory` import at line 19 is used nowhere else in the file, so it dies with the split (one more line than the claim counted). `computeModelOptionsData` currently takes no category argument, so the claim's implied "compute once" body is already the whole function.

<details><summary>Verifier reasoning</summary>

Independently verified; the claim holds, with corrections to its consumer census.

Degeneracy is real and every producer confirms it. `packages/extension/src/frontend/agents/optionsLoader.ts:10-15` computes one list and returns `{ workflow: options, toolUse: options }`; `packages/desktop/src/main/desktopMainViewStartup.ts:41-53` and `packages/desktop/src/main/desktopCredentialSettingsController.ts:238-248` do the same; `src/controllers/mainView/MainViewStartupController.ts:72-83` forwards it verbatim. The only consumer that ever distinguishes the halves is `packages/extension/src/webview/frontend/mainViewState.ts:199-203` (`getModelOptionsForSession`), whose two branches are the same array, and `packages/extension/src/progressView/ProgressViewMessageHandler.ts:706-707` already takes `.workflow` arbitrarily.

Provenance shows it is leftover, not design. `git show f4f645d5e6` (#9951) deleted the `{ agentCategory }` argument from `computeModelOptionsData` — the split was genuinely category-varying before that PR and became a no-op in it, and the same PR added the "Model options no longer vary by agent category" comment. `computeModelOptionsData` today (`src/model/computeModelOptions.ts:613-616`) takes only `(models?, access?)`, so no caller can produce differing lists.

No blocking ruling. `docs/proposals/2026-08-10-simplifier-fleet-round1-strategy.md` D1 (lines ~160-176) picked by-category as canonical over the flat `modelOptions` — but that was a dual-write cleanup written while the split still looked meaningful, and it explicitly deleted the flat duplicate rather than blessing the split. Nothing in AGENTS.md, CLAUDE.md, docs/architecture/, or docs/dev/audits/ defends the split.

Not settled surface, not already done, not filed. `src/shared/schemas/mainView/outbound.ts` appears in no ratchet (`grep -rn mainView config/ratchets/*.json` hits only knip entries for unrelated files); nothing here touches the frozen `@agent/*` surface, the PocketFlow engine, browser-safe utils, or the AgentEvent/SessionFact split. `git log --all --oneline --grep=optionsDataByCategory|modelOptionsByCategory` → empty; `gh issue list --state all --search` on "modelOptionsByCategory", "optionsDataByCategory", "sessionModelOptions", "SET_MODEL_OPTIONS", and "model options category" → 0 results. No catch/fallback is involved (section 15 N/A) and no CLI result-JSON contract is touched. `trackedSignal` is a reset registry (`mainViewState.ts:64-68`), not persistence, so there is no persisted-format migration.

</details>

#### Derive the instruction placeholder instead of re-pushing it from eight call sites

- **Area**: `ext-webview` · **Kind**: dual-representation · **Risk**: low
- **Net**: -26 LoC, -1 elements

**Evidence**

`instructionPlaceholder$` (packages/extension/src/webview/frontend/mainViewState.ts:104-106) is a writable `trackedSignal` whose only writer is `refreshInstructionPlaceholder` (mainViewActions.ts:83-96), which recomputes it from three signals already in the same module — `launchTarget$`, `isSelectedAgentOrchestrator$` (mainViewState.ts:215-220), and `sessionType$`.

Production call sites of the re-derive: 8 — mainViewActions.ts:145, :248, :255, :280, :330, :337; MainApp.ts:233; frontend/slices/sessionSlice.ts:25 (plus its import at sessionSlice.ts:12). Non-production: 0 direct calls (src/test-kernel/webview/MainViewActions.vitest.ts and MainViewLaunchTarget.vitest.ts exercise it only through the exported mutators).

Because the fact is re-pushed rather than derived, paths that change the inputs without calling the refresher leave it stale: frontend/slices/catalogSlice.ts:78-121 rewrites `agent$` (which feeds `isSelectedAgentOrchestrator$`) and never calls it, and persistence.ts:239-249 `applyState` sets `sessionType$`/`launchTarget$` on restore and never calls it.

The rotation this indirection existed for is already gone: commit d1f0d776da ("refactor: remove dead onboarding placeholder-rotation carrier", 2026-06-18) deleted the timer, `PLACEHOLDER_ROTATION_MS`, and the `advance` parameter. Its tail was left behind — `ONBOARDING_PLACEHOLDERS` (store.ts:135-154) still holds 3 + 3 + 6 = 12 strings of which only index 0 of each group is reachable (mainViewActions.ts:94 `set(placeholders[0])` is the sole write; mainViewState.ts:105 seeds `[0]`), and the vestigial `placeholders.indexOf(current)` guard at mainViewActions.ts:92-93 can never see a non-zero index.

**Proposal**

Replace the writable `instructionPlaceholder$` with a `Signal.Computed` in mainViewState.ts (declared after `isSelectedAgentOrchestrator$`) that returns `ONBOARDING_PLACEHOLDERS[launchTarget$.get() === 'team' || isSelectedAgentOrchestrator$.get() ? 'orchestrator' : sessionType$.get()]` — the same pattern `instruction$` already uses at mainViewState.ts:101-103. Delete `refreshInstructionPlaceholder` (mainViewActions.ts:83-96) and its 8 call sites plus the sessionSlice import. Collapse `ONBOARDING_PLACEHOLDERS` (store.ts:135-154) from three string arrays to three strings, dropping the 9 entries no code path can reach.

**What we give up**

Nine placeholder hint strings that have been unreachable since the rotation carrier was deleted in June 2026, and the ability to pin the placeholder imperatively. Behavior changes in one direction only: the placeholder now updates when the catalog push or a state restore changes the session type / orchestrator selection, where today it goes stale until the next unrelated mutator fires.

**Verifier corrections to the evidence above**

Corrections and additions to the original evidence:

- The claim omits the import lines that also go: mainViewActions.ts:43 (`instructionPlaceholder$`) and :63 (`ONBOARDING_PLACEHOLDERS`), plus MainApp.ts:104. Only the sessionSlice.ts:12 import was listed.
- The claim omits the live reader, which matters for framing (this is not dead code): mainViewState.ts:241 puts it in `sessionContext$`, rendered at packages/extension/src/webview/frontend/components/InstructionPanel.ts:706.
- The call site at mainViewActions.ts:248 is nested inside `if (parsed === prev) { if (resetTeamLauncher) { refreshInstructionPlaceholder(); } return; }`, so removing it collapses 3 lines, not 1 — the net LoC is slightly better than claimed.
- store.ts's `ONBOARDING_PLACEHOLDERS` block spans lines 135-154 (20 lines) and would collapse to roughly 6, and its `satisfies Record<SessionType | 'orchestrator', string[]>` becomes `Record<..., string>`.
- Cross-host note the claim misses: the same store.ts is bundled into the desktop renderer (identical strings appear in packages/desktop/dist/renderer/assets/index-*.js), so this is one source shared by two hosts, not an extension-only surface. Desktop e2e specs assert nothing on the copy — the only hits are Playwright `test-results/**/error-context.md` failure artifacts.
- `instructionPlaceholder$` is not in the persisted projection (persistence.ts's imports from mainViewState do not include it) and appears in no ratchet baseline or knip baseline, so no baseline/schema churn.
- The behavior claim needs one qualifier: replacing the pusher with a computed changes behavior on the two stale paths (it starts updating where it previously did not). Correct as a fix, but it should not be labelled behavior-preserving.

<details><summary>Verifier reasoning</summary>

Independently verified; the claim survives.

1. Symbol sweep (repo-wide, excluding node_modules/dist/.git) returns exactly the sites claimed: definition `instructionPlaceholder$` at packages/extension/src/webview/frontend/mainViewState.ts:104-106 (a `trackedSignal` seeded with `ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0]`), sole writer `refreshInstructionPlaceholder` at packages/extension/src/webview/frontend/mainViewActions.ts:83-96, and 8 production calls: mainViewActions.ts:145, :248, :255, :280, :330, :337; packages/extension/src/webview/frontend/MainApp.ts:233 (import at :104); packages/extension/src/webview/frontend/slices/sessionSlice.ts:25 (import at :12). No other consumer anywhere: nothing in packages/extension/package.json contributions, packages/extension/src/commands.ts, src/shared/schemas/coreSettings.ts or stateSettings.ts, packages/extension/resources/, prompts/, or supabase/functions/. The only other hits are the bundled dist artifacts and Playwright `error-context.md` failure artifacts, neither of which is a source consumer.

2. The reader is live and single: mainViewState.ts:241 projects it into `sessionContext$`, consumed at packages/extension/src/webview/frontend/components/InstructionPanel.ts:706 (`placeholder=${session.placeholder}`). So this is real UI copy, not dead code to delete outright — deriving it is the right shape.

3. The derivation is genuinely equivalent for every existing call site. `refreshInstructionPlaceholder` computes the key from `launchTarget$`/`isSelectedAgentOrchestrator$`/`sessionType$` and only writes when `placeholders.indexOf(current) === -1` — and since index 0 is the only value ever written (mainViewActions.ts:94) or seeded (mainViewState.ts:105), and no string is shared across groups, that guard fires exactly when the group changed. A `Signal.Computed` returning group[0] reproduces it, matching the pattern `instruction$` already documents at mainViewState.ts:101-103 ("Derived, not stored").

4. Staleness claim confirmed by reading the code: slices/catalogSlice.ts SET_AGENT_OPTIONS rewrites `agentOptions$` and `agent$` and only reaches a refresh via `enterToolUseSession()` when `selectedToolUseAgent` is set; the plain-options path never refreshes, so `isSelectedAgentOrchestrator$` can flip without the placeholder following. persistence.ts `applyState` likewise sets `sessionType$`/`launchTarget$` with no refresh (persistence.ts imports do not include the placeholder — it is not persisted, so no schema/migration churn from this change).

5. Not already done, not filed, not ruled on: `git log --oneline -15` on store.ts/mainViewActions.ts shows nothing revisiting it since d1f0d776da (2026-06-18), which I read — it deleted `placeholderTimer`, `stopPlaceholderRotation`, `PLACEHOLDER_ROTATION_MS`, and the `advance` parameter, and explicitly "collapsed refreshInstructionPlaceholder to its sole reachable behavior" without touching the arrays. That is the tail, not a ruling against finishing it. `gh issue list --state all --search "instructionPlaceholder"` and `"ONBOARDING_PLACEHOLDERS"` return 0; the tech-debt/placeholder search returns only unrelated closed issues (#6892, #6518, …). No mention in docs/, AGENTS.md, CLAUDE.md, or config/ratchets/*.json — so no ratchet or knip-baseline churn either.

6. Settled surfaces untouched (webview frontend, no `vscode` import introduced, no @agent/* edge, no AgentEvent/SessionFact change). Checklist 14 R5/R6 and 13: this removes elements rather than relocating them — one writable signal, one exported function, 8 call sites and 3 imports out; one computed in. No catch/fallback is involved, so section 15 does not apply; the `indexOf` guard is a vestigial no-op, not a load-bearing fallback.

One caveat worth recording on the issue: this is NOT purely behavior-preserving. Deriving fixes the two stale paths above, so the visible placeholder will now update on SET_AGENT_OPTIONS and on persisted restore where it previously did not. That is a fix, and the blast radius is one line of grey placeholder copy, so risk stays low.

Bounded, single-cluster deletion with no design seam to retire: recordAs "issue", not a proposal.

</details>

#### Sweep three settings-view leftovers: a write-only loaded flag, a pass-through snapshot method, and restated catalog defaults

- **Area**: `ext-settingsview` · **Kind**: dead-export · **Risk**: low
- **Net**: -23 LoC, -3 elements

**Evidence**

Three small, independently verified leftovers, batched because each alone is too thin to file. (a) `LaTeXTab.configLoaded` is write-only: packages/extension/src/settingsView/frontend/tabs/LaTeXTab.ts:223 declares it and `grep -n 'this.configLoaded' LaTeXTab.ts` returns 0 hits; a repo-wide `rg -n 'configLoaded|config-loaded' src packages` returns exactly 2 lines — that declaration and the SettingsApp.ts:449 binding that feeds it. The whole chain behind it is therefore dead: `latexConfigValuesLoaded` (settingsState.ts:313), its write in slices/latexSlice.ts:39, its import at latexSlice.ts:19, and the SettingsApp.ts:93 import. A read/write census over all 59 exported signals in settingsState.ts found this is the only one whose single read is dead. (b) `LatexSettingsHandlers.sendLatexConfigValues` (handlers/latexSettingsHandlers.ts:203-215) contains nothing LaTeX-specific — it re-inlines the exact `SettingsStores` literal that its only caller already owns as a private method (`SettingsViewMessageHandler.settingsStores()`, SettingsViewMessageHandler.ts:501-507), making that literal the second of two copies in this tree. Its 2 call sites (SettingsViewMessageHandler.ts:456 and :589) are both inside the class that owns `sendSettingsSnapshot(webview, 'latex')`. Consumers outside the settingsView tree: 0. (c) tabs/AIAgentsTab.ts:22-27,101-113 imports six `CLAUDE_AGENT_DEFAULT_*` / `CODEX_*_DEFAULT` constants purely as `@property` initializers, restating defaults the catalog already supplies — the six signals that feed those properties are `settingSignal(...)` (settingsState.ts:246-264), which initialize from `entry.schema.parse(undefined)`, and SettingsApp.ts:435-440 binds all six unconditionally, so the initializers are never observable.

**Proposal**

(a) Delete LaTeXTab.ts:223, SettingsApp.ts:93 and :449, settingsState.ts:313, and latexSlice.ts:19 and :39. (b) Delete `LatexSettingsHandlers.sendLatexConfigValues` and change SettingsViewMessageHandler.ts:456 and :589 to `this.sendSettingsSnapshot(webview, 'latex')`; the `platform` and `buildSettingsSnapshotMessage` imports in latexSettingsHandlers.ts then go too, leaving one copy of the stores literal in this tree. (c) Drop the six constant imports in AIAgentsTab.ts and let the six properties declare their type without an initializer value.

**What we give up**

(a) nothing — the flag was never read. (b) nothing; the message posted is byte-identical. (c) if AIAgentsTab is ever mounted standalone without SettingsApp binding its properties (only src/test-kernel mounts components that way today), its six selects would render empty instead of at the catalog default; no such mount exists for this component.

**Verifier corrections to the evidence above**

Parts (a) and (b) hold exactly as claimed, with these corrections/additions: (a) the dead chain is 6 lines, not 5 — LaTeXTab.ts:223, SettingsApp.ts:93, SettingsApp.ts:449, settingsState.ts:313, latexSlice.ts:19, latexSlice.ts:39; I additionally confirmed no CSS attribute selector consumes `config-loaded` and that desktop shares the same frontend via packages/desktop/src/renderer/main.ts:55, so there is no second consumer. (b) add that SettingsViewMessageHandler.ts:589 should become `this.rebroadcastSnapshot('latex')` (not `sendSettingsSnapshot` inside `withActiveWebview`), matching the five sibling arms at :579-595, which collapses that 4-line arm to 1; 'latex' is a valid DerivedSettingsSnapshot per src/shared/schemas/settingsViewMessages.ts:197-207. (c) must be DROPPED from the proposal: it does not compile under tsconfig.json:167 `"strict": true` (strictPropertyInitialization, TS2564 on all six), the workarounds (`!` or `?` plus use-site `??`) are net-negative, and the six imports are references to the catalog SSOT constants (shared with src/tools/codexConfig.ts and src/tools/claudeAgentConfig.ts), not restated defaults; every @property in all 13 tabs carries a default by convention. Net LoC is therefore about -22 to -24, not -35.

<details><summary>Verifier reasoning</summary>

Two of the three sub-items survive independent verification; the third is refuted, so the candidate should be filed in reduced form. (a) SURVIVES: my own `rg -n 'configLoaded|config-loaded|latexConfigValuesLoaded'` over the repo returns exactly the 6 declaration/plumbing lines and zero reads — packages/extension/src/settingsView/frontend/tabs/LaTeXTab.ts:223 (declared, never read; no `this.configLoaded`, and no `:host([config-loaded])` selector in LaTeXTab.styles.ts or src/shared/styles), packages/extension/src/settingsView/frontend/SettingsApp.ts:93 and :449, settingsState.ts:313, slices/latexSlice.ts:19 and :39. No test or desktop consumer: packages/desktop/src/renderer/main.ts:55 imports the same `@settingsView/frontend`, so there is one SettingsApp, not two. Nothing regresses because LaTeXTab.ts:489-495 already gates the entire render on the separate `this.loaded`. (b) SURVIVES: packages/extension/src/settingsView/handlers/latexSettingsHandlers.ts:203-215 re-inlines the identical SettingsStores literal that SettingsViewMessageHandler.settingsStores() owns at SettingsViewMessageHandler.ts:501-507, and `latex` is a key of SETTINGS_SNAPSHOT_COMMANDS (src/shared/schemas/settingsViewMessages.ts:197-204), so `DerivedSettingsSnapshot` accepts 'latex' and `this.sendSettingsSnapshot(w, 'latex')` produces the same message; SettingsViewMessageHandler.ts:589 can further collapse to `this.rebroadcastSnapshot('latex')` matching its five sibling arms at :579-595. `platform` and `buildSettingsSnapshotMessage` have no other use in latexSettingsHandlers.ts (only lines 205-210), so both imports go. Repo-wide the symbol has 3 hits, all inside this tree. (c) REFUTED on two independent grounds: root tsconfig.json:167 sets "strict": true, so strictPropertyInitialization is active and the literal proposal ("declare their type without an initializer value") is TS2564 on all six properties; the only escapes are `!` (a non-null assertion over a value that really is undefined until Lit binds) or `?`, which forces `?? ''` fallbacks at renderSelectRow(label, key, value: string) — relocated complexity, net positive. And the premise is wrong: AIAgentsTab.ts:22-27 imports the catalog SSOT constants themselves (CODEX_SANDBOX_MODE_DEFAULT et al., also consumed by src/tools/codexConfig.ts:11,88 and src/tools/claudeAgentConfig.ts:25,48), not restated literals, and defaulting every @property is the convention across all 13 tabs in that directory. Checklist 14 R5/R6: (a) and (b) delete elements outright with no relocation and no unrelated churn; (c) is churn. No masking fallback is involved (section 15 N/A — these are dead flags and a pass-through, not catch/`??` sites). Dedupe: `gh issue list --label tech-debt --state all --limit 40 --search "configLoaded"` and `--search "sendLatexConfigValues"` both return 0; `git log --all --oneline --grep` on both symbols returns 0; recent settings commits 549ae9f80c, f4e3bd7fae, d4c6b38494 touched these files without removing them. No deliberate ruling: nothing in docs/proposals, docs/architecture, docs/dev/audits, AGENTS.md, CLAUDE.md, or config/ratchets covers these (the architecture-rulings ledger's only settingsView row is components/history/state.ts). Settled surfaces untouched: no ratchet, no @agent/* deep import, no PocketFlow engine, no platform composition root, no browser-safe @utils module, no AgentEvent/SessionFact change, no wire-contract change (the 'latex' snapshot command is unchanged), and no contact with the CLI result-JSON contract, so risk stays low.

</details>

#### Delete ProgressToolbarButton.disabled: 11 descriptors set it, no code ever reads it

- **Area**: `ext-progressview` · **Kind**: dead-export · **Risk**: low
- **Net**: -12 LoC, -1 elements

**Evidence**

Declared at packages/extension/src/progressView/frontend/constants.ts:29 (`disabled?: boolean;`) and set to `true` on 11 toolbar descriptors: constants.ts:89 (STOP_STREAM), :98 (RESTORE_STATE), :107 (OPEN_TASK_STORAGE), :116 (EXPORT_TRANSCRIPT), :126 (COPY_RUN_CONTEXT), :137 (RUN_NEW), :145 (RESUME), :157 (DIFF_STREAM), :165 (CLEAN_STREAM), :173 (PACK_STREAM), :220 (COMPACT_RESPONSE).

The toolbar tables have exactly one consumer: `rg -n 'ProgressToolbarButton|TOOLBAR_BUTTONS|NEUTRAL_TOOLBAR' -g '*.ts' packages src` outside constants.ts returns only StreamHeader.ts:53-55, :441-442, :575 — 1 production file, 0 non-production, 0 ambiguous. Inside StreamHeader the disabled state is computed entirely without the field: packages/extension/src/progressView/frontend/components/StreamHeader.ts:591 is `const disabled = hidden || !enabledButtons?.has(button.id);`, where `enabledButtons` comes from ENABLED_BUTTONS_BY_DISPLAY_KEY (StreamHeader.ts:130-148) keyed by the run's phase, and StreamHeader.ts:471-474 then ORs in `this.archived` and the empty-run-context case. `rg -n '\.disabled' packages/extension/src/progressView` returns three hits, all unrelated (BaseApprovalPanel.ts:124, ApproveSplitButton.ts:109 and :120 — the split-button's own Lit property). `git log -S 'button.disabled'` and `-S 'btn.disabled'` over the area return no commits, so no reader was ever removed from this path.

**Proposal**

Delete the `disabled?: boolean` member from the `ProgressToolbarButton` interface (constants.ts:29) and the 11 `disabled: true` lines from the descriptor literals. Nothing replaces it — StreamHeader.getButtonState already owns per-phase enablement via ENABLED_BUTTONS_BY_DISPLAY_KEY, and StreamHeader.ts:471-474 owns the archived/no-context overrides. The `satisfies ProgressToolbarButton` on COPY_RUN_CONTEXT_BUTTON (constants.ts:127) keeps compiling once the optional member is gone.

**What we give up**

Nothing observable. The field is a stale initial-render hint from the pre-Lit DOM toolbar; every button's real disabled state is recomputed from the stream's phase on each render. A future host that wanted a per-descriptor default would have to re-add it, but no host does today.

**Verifier corrections to the evidence above**

Two corrections. (a) Net LoC is -12, not -13: the interface member at constants.ts:29 is a single line with no doc comment, plus the 11 `disabled: true` lines. (b) The claim's "3 unrelated .disabled hits" undercounts because it searched only `\.disabled`: a broader `rg -n 'disabled' packages/extension/src/progressView` returns roughly a dozen more hits (ToolEditRequestPanel.ts:89, FollowUpInput.ts:305, RetryRequestPanel.ts:76/118/127/135, ExternalInquiryPanel.ts:499, BaseFeedbackPanel.ts:89, UserQuestionPanel.ts:79, RequestPanels.ts:390/403, plus CSS `--opacity-disabled` in logStyles.ts:58 and TodoList.ts:75) — all are unrelated component-local disabled props, so the conclusion is unchanged. Also worth noting for the fix: the four bypass-toggle descriptors (TOOL_EDIT/BASH/AUTO_TASK toggles and the NEUTRAL_TOOLBAR members' shared objects) already omit the field, so the descriptor table is already inconsistent about setting it — further evidence it is vestigial.

<details><summary>Verifier reasoning</summary>

Independently verified and the claim holds. (1) Sole consumer: `rg -n 'ProgressToolbarButton|TOOLBAR_BUTTONS|NEUTRAL_TOOLBAR'` over the whole repo (not just *.ts) returns only packages/extension/src/progressView/frontend/constants.ts and packages/extension/src/progressView/frontend/components/StreamHeader.ts:53-55,439-442,575. No non-TS consumer, no desktop/CLI consumer, no package.json contribution, no schema/YAML/wire string involvement (the field is a frontend-only literal, never serialized). (2) The descriptor is never spread: StreamHeader.ts:460 maps each `btn` and reads only `btn.id`, `btn.icon`, `btn.label`, `btn.title`, `btn.titleActive`, `btn.className`, `btn.bypassKind`, `btn.command`, `btn.localAction`; the rendered `disabled` is computed at StreamHeader.ts:461-474 from `getButtonState` (StreamHeader.ts:578-592: `const disabled = hidden || !enabledButtons?.has(button.id);`) OR'd with `this.archived` and the empty-run-context case. `btn.disabled` appears nowhere. (3) Not a masking fallback: nothing is caught or defaulted, so checklist §15 does not apply; deletion is behavior-preserving by construction since no reader exists. (4) Provenance confirms it is vestigial, not deliberate: `git log -S 'button.disabled'` shows readers only in the pre-Lit imperative-DOM era ("refactor: migrate progressView from JavaScript to TypeScript", "refactor: centralize element disabling helper"), where `disabled: true` seeded the initial DOM attribute; the field survived into the current interface at a7fee966bb (#9586) with no reader. (5) No ruling protects it: nothing in docs/, AGENTS.md, CLAUDE.md, or config/ratchets/ mentions ProgressToolbarButton or the toolbar descriptors, and no knip-baseline entry covers it. It touches none of the settled surfaces (not the @agent SDK fence, PocketFlow engine, platform root, browser-safe utils, or AgentEvent/SessionFact split) and no CLI result-JSON contract. (6) Not filed: `gh issue list --state all --search "toolbar"` and progressView searches surface #11331 (Clean button no-op behavior bug), #8158 (title= to wa-tooltip, closed), #11253 (a different symbol set) — no duplicate. (7) §14 R5/R6: this removes one interface member and 11 literal properties with zero relocation and zero forced churn elsewhere — the `satisfies ProgressToolbarButton` at constants.ts:127 still compiles once the member and that literal's line go together, and src/test-kernel/progressView/StreamHeader.vitest.ts:420 asserts the rendered `disabled` attribute, which comes from the computed path, so no test changes. Small but genuine and zero-risk.

</details>

#### Batch: drop the phantom onColorTheme activation event, the duplicate apiKeyCommands id home, and 11 file-local exports

- **Area**: `ext-host` · **Kind**: dead-export · **Risk**: low
- **Net**: -3 LoC, -13 elements

**Evidence**

Three independent tiny finds, each too small to file alone. (1) `packages/extension/package.json:22` lists `"onColorTheme"` in `activationEvents`. It is not a VS Code activation event (the manifest already has `onStartupFinished` at :21, which covers startup for every window), and `rg "onColorTheme" packages/extension/src src` returns 0 hits — the only theme code is `vscode.window.onDidChangeActiveColorTheme` at `packages/extension/src/progressView/ProgressViewProvider.ts:222`, a runtime listener, not an activation trigger. Present since the 2026-05-04 package move (`git log -S'onColorTheme'` → 4d1306e081 only). (2) `packages/extension/src/commands/api/apiKeyCommands.ts:23-25` exports `apiKeyCommands = { setApiKey: 'texra.setApiKey' }` — a second, untyped home for a command-id literal, while `packages/extension/src/commands/extensionCommandIds.ts:11-20` documents itself as exactly "the mirror for the _call_ sites that dispatch or reference the same commands by literal" and is `satisfies Record<string, CommandId>` (compile-checked against the catalog). Production consumers of `apiKeyCommands`: 4 (`setupAssistantCommand.ts:126,164,229`, `progressView/ProgressViewMessageHandler.ts:693`); non-production 1 (a comment in `src/test-kernel/commands/setup/SetupAssistantRouting.vitest.ts:96`). (3) Eleven exported types whose only references are inside their own declaring file (verified with `rg -l` over `packages` + `src`, .md excluded — each returns exactly one path): `FileOpConfig`/`FileOpActions` (`commands/housekeeping/fileOpRunner.ts:11,22`), `FileDialogOptions`/`FolderDialogOptions` (`frontend/ui/dialogs.ts`), `ReviewOptions` (`frontend/review/promptReviewOptions.ts`), `StatusBarSessionEventOptions` (`frontend/statusBar/statusBarSessionEvents.ts:4`), `ViewBundle` (`common/webview/BaseViewContentProvider.ts`), `AuthNotifier` (`frontend/auth/SupabaseAuthProvider.ts`), `GitAPI` (`frontend/git/gitExtensionTypes.ts:25`), `Raced` (`frontend/vscode/raceWithTimeout.ts:7`), `AgentReviewCollection` (`frontend/review/AgentReviewRunController.ts:14`). Knip does not catch these: `npx knip --include types --workspace packages/extension` reports zero unused types, so none are in `config/ratchets/knip-baseline.json` (the area holds only 4 baseline entries, all test-only exports) — these are genuinely new finds against AGENTS.md "Exports are contracts".

**Proposal**

(1) Delete `"onColorTheme"` from `activationEvents`. (2) Add `SET_API_KEY: 'texra.setApiKey'` to `EXTENSION_COMMANDS` in `extensionCommandIds.ts`, repoint the 4 call sites, delete the `apiKeyCommands` object and its export. (3) Remove the `export` keyword from the 11 types above; none crosses a module boundary. No behavior change anywhere; one PR, no new tests.

**What we give up**

Nothing observable. The only cost is that a future consumer of one of the 11 types must re-add its `export` — which is the intended door policy, not a loss.

**Verifier corrections to the evidence above**

Two corrections. (a) The provenance for onColorTheme is wrong: `git log -S'onColorTheme' --all` reaches far past the 2026-05-04 package move (4d1306e081) back to the "Implement adaptive theming and improve UI consistency" commits, and the string was explicitly discussed in 24c006faac (#3071), whose body states onStartupFinished was added because "with only `onColorTheme` declared, palette entries could in theory be hidden before `activate()` set `texra.activated`". That history supports removal but shows the line is a reviewed leftover, not a package-move artifact. (b) The claim missed a second file: scripts/verify-extension-package-invariants.mjs:35 lists 'activationEvents' in MANIFEST_KEYS, so scripts/extension-package-invariants.snapshot.json:20 pins ["onStartupFinished","onColorTheme"] and must be updated in the same PR or the invariants check fails. Minor: packages/extension/src/commands/extensionCommandSurface.ts:30-33 is a fifth reference to the apiKeyCommands _module_, but it imports the setApiKey/removeApiKey functions, not the object, so the 4-consumer count for the object stands.

<details><summary>Verifier reasoning</summary>

All three sub-claims survive independent verification, and none touches a settled surface (no ratchet entry, no @agent/* SDK edge, no PocketFlow kernel, no AgentEvent/SessionFact split, no CLI result-JSON contract). (1) `rg "onColorTheme"` over the whole tree returns exactly two hits: packages/extension/package.json:22 and scripts/extension-package-invariants.snapshot.json:20. No source reads it; the only theme code is the runtime listener vscode.window.onDidChangeActiveColorTheme in packages/extension/src/progressView/ProgressViewProvider.ts. `onStartupFinished` at package.json:21 covers activation unconditionally, and commit 24c006faac (#3071) added it for precisely that reason. (2) packages/extension/src/commands/api/apiKeyCommands.ts:23-25 is a second, untyped home for 'texra.setApiKey', which already exists in the catalog at src/shared/commands/catalog.ts:178, so adding SET_API_KEY to EXTENSION_COMMANDS in packages/extension/src/commands/extensionCommandIds.ts:14-20 type-checks against `satisfies Record<string, CommandId>`. Object call sites are exactly four: setupAssistantCommand.ts:126,164,229 and progressView/ProgressViewMessageHandler.ts:693. (3) All eleven types are file-local: repo-wide rg (node_modules/dist/*.md excluded, alias imports covered since `X as Y` still contains X) returns exactly one path per symbol. Dedupe is clean: no issue mentions activationEvents or onColorTheme; apiKeyCommands matches only closed #6891 (SecretManager key resolution, unrelated); the nearest un-export sweep, #11385, covered approvalPolicy constants, a disjoint symbol set. No ruling in docs/proposals, docs/architecture, AGENTS.md, CLAUDE.md, or config/ratchets defends any of the three. Bounded, mechanical, no behavior change — record as a single batched issue.

</details>

### L3-desktop — Desktop renderer

**Paths**: `packages/desktop/**`

#### Delete the 26 unreachable rename rows in the desktop Lucide icon map and type it against TeXRAIconName

- **Area**: `desktop-renderer` · **Kind**: expired-compat · **Risk**: low
- **Net**: -27 LoC, -26 elements

**Evidence**

packages/desktop/src/renderer/desktopIconLibrary.ts:23 declares LUCIDE_NAME_BY_TEXRA_NAME as Readonly<Record<string, string>> with 83 rows; the resolver at :189 does lucideSvg(LUCIDE_NAME_BY_TEXRA_NAME[name] ?? name). 26 of the 83 keys are not members of TEXRA_ICON_CANONICAL_NAMES (src/shared/wa/iconNames.ts:22-141, the single source for TeXRAIconName): lines 41,42,47,53,56,57,61,62,68,69,71,73,74,76,79,80,81,83,84,85,86,106,114,116,117,118. Grepped each key as a whole word across the whole repo excluding node_modules and the map file itself: 24 return 0 hits anywhere. The two apparent hits are false: 'screwdriver' only matches inside the canonical 'screwdriver-wrench'; 'symbol-structure'/'symbol-method'/'symbol-keyword' appear only in docs/guide/_.md (VitePress, which never imports this module — grep for desktopIconLibrary shows exactly one production importer, packages/desktop/src/renderer/main.ts:15), in packages/extension/package.json:372 and src/shared/commands/catalog.ts:259 as VS Code codicon '$(symbol-method)' strings, and as CSS var names --wa-color-symbol-keyword. Production consumers of the map: 1 (its own resolver). Non-production: 1 (src/test-kernel/desktop/DesktopIconLibrary.vitest.ts:43-55 parses the table out of the source text and asserts >50 rows; 57 survive). The in-file comment at :112 ("Codicon-style symbol aliases used by the agent-team presets") is stale: src/shared/schemas/agentPresets.ts:16-46 narrowed preset icons to a 6-name allowlist that falls back to 'bookmark', so symbol-_ can no longer reach the resolver. No agent YAML carries an icon field (rg '^\s*icon:' over packages/extension/resources/\**/*.yaml returns 0).

**Proposal**

Delete the 26 rows. Change the map's type from Readonly<Record<string, string>> to Readonly<Partial<Record<TeXRAIconName, string>>> and index it as LUCIDE_NAME_BY_TEXRA_NAME[name as TeXRAIconName] ?? name so a future canonical-name removal turns a stale row into a compile error instead of silent dead data. Drop the stale codicon-alias comment at :112. The unknown-name path (missingIconUri, :182-190) is untouched, so a name that somehow arrives still renders the Lucide question marker.

**What we give up**

Nothing at runtime: none of the 26 names can reach the resolver today. If someone re-adds one of these Font Awesome spellings to TEXRA_ICON_CANONICAL_NAMES later they must re-add its Lucide rename — but with the Partial<Record<TeXRAIconName>> typing that is a visible gap, and without a rename it falls back to Lucide's own name or the question marker rather than rendering blank.

**Verifier corrections to the evidence above**

Three corrections. (1) The docs-guide `<wa-icon library="texra" name="symbol-structure">` usages are safe for a different reason than claimed: docs/.vitepress/theme/webAwesomeIcons.js:346,352 is a fully independent icon table that defines symbol-keyword and symbol-structure itself, so the VitePress site never depends on the desktop map (it is a separate duplicate table, out of scope here). (2) Net LoC is -27, not -28: 26 key lines plus the single stale comment at packages/desktop/src/renderer/desktopIconLibrary.ts:112. No group comment is orphaned — `hashtag` (canonical) still sits under that comment, so the comment goes and the group header does not need reworking. (3) The governing ruling the claim should have cited is docs/proposals/2026-08-15-shared-contracts-and-retirement.md:499,549 (LEGACY_ICON_ALIASES retired early, #10887), not docs/proposals/2026-08-07-prod-structural-leads-triage.md. Additionally, the proposal's type half is unsound as written: `LUCIDE_NAME_BY_TEXRA_NAME[name as TeXRAIconName]` asserts a falsehood, since the resolver's `name` is a genuinely arbitrary runtime string (the test at DesktopIconLibrary.vitest.ts:76-80 exercises 'unexpected-runtime-icon'). Get the same compile-time drift guard honestly by keeping the declared type `Readonly<Record<string, string>>` and appending `satisfies Partial<Record<TeXRAIconName, string>>` at the literal. The `?? name` fallback and missingIconUri (:171-190) are load-bearing loud-visible-marker behavior, not masking, and must be left untouched.

<details><summary>Verifier reasoning</summary>

Survives. I re-derived the 26 non-canonical keys myself (node parse of packages/desktop/src/renderer/desktopIconLibrary.ts:23-118 against TEXRA_ICON_CANONICAL_NAMES in src/shared/wa/iconNames.ts:22-141) and they match the claimed lines exactly. Unreachability holds on a stronger argument than the claim gives: every production render path is typed, not just grep-clean — waIcon's signature is `name: TeXRAIconName` (src/shared/wa/webAwesomeIcons.ts:309), all dynamic call sites (packages/desktop/src/renderer/logsPane.ts:71-79/199, desktopCommandPalette.ts:38/297, taskShell.ts:65/357, desktopOnboarding.ts:165) carry TeXRAIconName-typed sources, and there is no literal <wa-icon> in desktop production markup (packages/desktop/src/renderer/index.html has zero). The `registerIconLibrary('default', ...)` line does not widen the vocabulary: WebAwesome ships a separate `system` library (node_modules/@awesome.me/webawesome/dist/components/icon/library.system.js) for its components' internal glyphs. Persisted data cannot reach the deleted keys either: src/shared/schemas/agentPresets.ts:16-46 strips `codicon-` and then narrows to a 6-name allowlist with a `bookmark` fallback. Governance supports the deletion rather than blocking it: docs/proposals/2026-08-15-shared-contracts-and-retirement.md:499,549 records that LEGACY_ICON_ALIASES was retired EARLY under the 2026-08-18 maintainer ruling (#10887, "dated compat horizons for intermediate-era data are void"), and #6981 states desktop-only state gets no migration machinery because desktop has had no public release. PR #9626 (commits 2536ad7df8, 4a986378dc) removed the alias hop and one row (`tools`) but never audited the map's own non-canonical keys, so these are residue, not a deliberate keep. No ratchet, knip baseline, or script references the table. The one test (src/test-kernel/desktop/DesktopIconLibrary.vitest.ts:43-115) parses the table with /^\s*'?([a-z0-9-]+)'?:\s*'[a-z0-9-]+',/gm and asserts >50; I ran that exact regex: 83 now, 57 after deletion, so it still passes with no test churn. Not filed: gh issue searches for the symbol, "desktop icon lucide", and "icon alias" turn up nothing covering it; #9627's 2026-09-28 row is the agentPresets codicon-stripping site, a different file.

</details>

#### Delete 12 orphan custom properties from the desktop themeTokens.css bridge

- **Area**: `desktop-renderer` · **Kind**: dead-export · **Risk**: low
- **Net**: -24 LoC, -16 elements

**Evidence**

packages/desktop/src/renderer/themeTokens.css declares 284 custom properties. Twelve of them are never read by any var() anywhere in packages/ or src/, and are not read dynamically either: the only getPropertyValue call sites in the repo are src/shared/wa/xtermTheme.ts:48 (which reads only --wa-color-terminal-_) and two vitest helpers. The twelve, with declaration lines: --desktop-color-soft:54, --desktop-color-surface-3:60 (+583), --desktop-gradient-brand:87-90 (+595), --desktop-shadow-md:107-110 (+605), --desktop-color-info-background:125, --desktop-color-cyan:135, --border-hairline-soft:361, --opacity-faint:374, --opacity-muted:376, --textarea-h-l:384, --width-content-max:414, --transition-relaxed:421 (+679). Production consumers: 0 for each (rg -- '--<name>' over packages src docs returns only the themeTokens.css declaration lines). Non-production consumers: 0 — src/test-kernel/desktop/DesktopThemeTokens.vitest.ts asserts only --wa-_ names plus paletteToken('background'|'foreground'|'accent'|'info'|'input-_'|'focus'), none of which are in this set. The six --desktop-color-_/--desktop-gradient-_/--desktop-shadow-_ names are provably unreachable from outside the file: DesktopThemeTokens.vitest.ts:179-232 is a confinement test that walks packages/desktop/src, packages/extension/src and src/ and fails if any file other than themeTokens.css names a --desktop-color-_/--desktop-font-_ token. The remaining six are not mirror entries either — rg over src/shared/styles/litStyles.ts (the shared :host token set that #9714/585880e4dd made themeTokens.css mirror) returns 0 for all of them. The comment at :85-86 claims --desktop-gradient-brand is "kept as a background-image-compatible value for existing consumers"; there are none.

**Proposal**

Delete the twelve declarations and their high-contrast / prefers-reduced-motion restatements at :583, :595, :605, :679, plus the now-false 'existing consumers' comment at :85-86. Keep every used member of the same families (--desktop-shadow-lg, --transition-fast/--transition-normal, --desktop-color-toolbar-*, etc.). No consumer edits are needed, so nothing outside packages/desktop/src/renderer/ changes.

**What we give up**

The palette loses six named colour/shadow/gradient slots and six shared-vocabulary metrics that a future surface might have wanted pre-named. Re-adding one is a one-line declaration next to its family. Nothing rendered today changes, because nothing reads them.

**Verifier corrections to the evidence above**

Three corrections/additions. (1) The claim says the non-declaring getPropertyValue sites are "two vitest helpers"; precisely they are src/test-kernel/desktop/DesktopThemeTokens.vitest.ts:42 and src/test-kernel/shared/BadgeStyleContracts.vitest.ts:124, and the latter reads only gap/padding/font-size/font-weight from Lit component rules, not custom properties at all. Also xtermTheme.ts:48 is fed more than --wa-color-terminal-_: it also reads --wa-color-surface-default, --wa-color-text-normal and --wa-font-family-mono; still none of the twelve. (2) Stronger evidence the claim omits: none of the twelve is referenced by any var() inside themeTokens.css itself, so the six --desktop-_ entries fail the very purpose the confinement test states for that layer, and --desktop-color-cyan / --desktop-color-info-background are the only unmapped members of otherwise fully-mapped rows (siblings map at 274/449/467/471/475, 275/451/477/527/535, 452/478 and 229/241/253). (3) The confinement test is not merely neutral — DesktopThemeTokens.vitest.ts:179-232 requires only one surviving --desktop-color-* declaration plus one var() use, which the remaining palette satisfies, so no test edit is needed. One nit the proposal misses: the "Surface ladder" comment at :57-59 introduces --desktop-color-surface-3 alongside sidebar/sidebar-header and should be reworded (it stays true, just thinner), which is why net LoC may land at -24 rather than a line or two better.

<details><summary>Verifier reasoning</summary>

Survives. I re-ran the greps myself over all tracked files (git grep, repo root, not just packages/src) and each of the twelve names appears only in packages/desktop/src/renderer/themeTokens.css; positive controls (opacity-disabled, desktop-shadow-lg) returned rows, so the method is not silently failing. Stronger than the claim states: none of the twelve is read by a var() inside themeTokens.css either — each name appears only on its declaration line(s) plus its high-contrast/reduced-motion restatement (lines 583, 595, 605, 679), so e.g. --desktop-color-cyan:135 is the only member of the chromatic row (orange:132, yellow:133, purple:134) with no --wa-color-* mapping, and --desktop-color-info-background:125 is the only _-background semantic with no --wa-color-_-fill-quiet consumer (error/warning/success all have one at 241/229/253). No dynamic read reaches them: getPropertyValue exists only at src/shared/wa/xtermTheme.ts:48 (fed --wa-color-terminal-_, --wa-color-surface-default, --wa-color-text-normal, --wa-font-family-mono), src/test-kernel/desktop/DesktopThemeTokens.vitest.ts:42 and src/test-kernel/shared/BadgeStyleContracts.vitest.ts:124 (which reads gap/padding/font-size/font-weight off Lit rules, not custom properties); setProperty is only --context-menu-x/y (packages/desktop/src/renderer/taskShell.ts:294-295) and test stubs; there is no templated `--${...}` CSS-name construction. Tests permit the deletion: DesktopThemeTokens.vitest.ts:179-232 only requires that at least one --desktop-color-_ declaration and one var(--desktop-color-_) reference remain in the bridge, and no consumer file names one — both still hold after removing twelve unread entries. No script enforces token parity (scripts/ has no CSS-var checker; litStyles.ts declares --opacity-separator/-disabled/-subtle/-normal/-full and --textarea-h-s/-m, none of the twelve, so the mirror set is unaffected). No ruling blocks it: the only doc naming themeTokens is docs/prds/2026-05-02-prd-electron-app.md; #9714 (585880e4dd) fixed the opposite defect and its follow-up #9722 covers --color-text-muted/--border-control, neither in this set; issue searches for themeTokens / css token / unused desktop custom properties return no open or closed duplicate. Nothing here touches the five ratchets, the frozen @agent/_ surface, src/agent/node/index.ts, platform composition, the browser-safe utils set, the AgentEvent/SessionFact split, or the CLI result-JSON contract, and no catch/fallback is involved. Provenance confirms rot rather than intent: all twelve entered in 9a617f9c92 (#9216); git grep at that commit shows --opacity-faint (2), --opacity-muted (4), --textarea-h-l (1), --width-content-max (1) and --border-hairline-soft (1) had consumers that were since deleted, while the other seven never had any. Deletion forces zero consumer churn.

</details>

#### Retire the duplicate texra-<kind> body-class family left behind when the --texra-* bridge was dropped

- **Area**: `desktop-renderer` · **Kind**: dual-representation · **Risk**: low
- **Net**: -10 LoC, -3 elements

**Evidence**

src/shared/wa/hostTheme.ts:30 writes both families in one statement: body.classList.add(`vscode-${theme}`, `texra-${theme}`). Its only production caller is packages/desktop/src/renderer/main.ts:1393 (rg -w applyHostBodyTheme over the repo: 1 production call site, 1 vitest). So texra-light / texra-dark / texra-high-contrast exist only on the desktop renderer's body, and only ever alongside the identical vscode-<kind> class. Consumers of the texra-* half: exactly three selector lines in packages/desktop/src/renderer/themeTokens.css — :563 (`body.texra-light`, paired with `body.vscode-light` at :562), :569 (paired with :568), :576 (paired with :574-575) — every one of which already matches through its vscode-* sibling on the same element. src/shared/wa/waColorScheme.ts:34, :49 and :54 enumerate both families in THEME_CLASSES / DARK_BODY_CLASSES / LIGHT_BODY_CLASSES purely to strip and re-classify the duplicate. Production consumers of texra-* outside those: 0 (rg for texra-dark|texra-light|texra-high-contrast over packages+src returns only those files). Non-production: 2 (src/test-kernel/desktop/HostTheme.vitest.ts:47-52 asserts both families; DesktopThemeTokens.vitest.ts:98 regex-matches `body\.vscode-dark,\s*body\.texra-dark`). The vscode-* half is the one that is load-bearing and cannot go: src/shared/BaseWebviewApp.ts:165-166 and packages/extension/src/progressView/frontend/components/UserMessage.ts:169-170 classify darkness by .vscode-dark / :host-context(.vscode-high-contrast), and those shared Lit components render inside the desktop renderer. The texra-* family is the residue of the token rename that 850d87f69f (#3741, 'retire --vscode/--texra double bridge') finished on the CSS-variable side in May 2026 without removing the class-name side.

**Proposal**

Drop `texra-${theme}` from hostTheme.ts:30; collapse THEME_CLASSES / DARK_BODY_CLASSES / LIGHT_BODY_CLASSES in waColorScheme.ts from flatMap-over-two-prefixes to a map over `vscode-${kind}`; delete the three `body.texra-*` selector lines from themeTokens.css; trim the two texra-* assertions in HostTheme.vitest.ts and relax the DesktopThemeTokens.vitest.ts:98 regex to `body\.vscode-dark`. Fix spans outside packages/desktop/src/: src/shared/wa/hostTheme.ts, src/shared/wa/waColorScheme.ts, and two test-kernel files.

**What we give up**

A desktop-branded hook for anyone who wanted to style the Electron shell without naming 'vscode'. That is a naming preference, not behaviour — and the honest alternative (dropping vscode-* instead) is blocked because the shared webview components the desktop hosts read .vscode-dark directly.

**Verifier corrections to the evidence above**

Evidence is accurate; only the LoC figure is optimistic. `hostTheme.ts:30` merely shortens (0 lines saved), and after collapsing, `DARK_BODY_CLASSES` stays a ~3-line declaration while `LIGHT_BODY_CLASSES` stays ~6 lines because it must keep the non-derivable `'vscode-high-contrast-light'` member (`waColorScheme.ts:52-59`). Realistic accounting: themeTokens.css -3, waColorScheme.ts -3 to -4, HostTheme.vitest.ts -3, hostTheme.ts 0 (comment lines 18-19 need wording edits, not deletions) => about -10, not -15. One consumer the claim did not list, harmless: `docs/dev/verification.md:84` and `:93` name `applyHostBodyTheme` / `src/shared/wa/hostTheme.ts` as manual-verification pointers — a doc reference, not a code consumer, and it needs no edit.

<details><summary>Verifier reasoning</summary>

Survives. I re-ran every grep independently. `src/shared/wa/hostTheme.ts:30` adds both `vscode-${theme}` and `texra-${theme}`; the only production caller is `packages/desktop/src/renderer/main.ts:65`/`:1393`. Repo-wide `rg "texra-dark|texra-light|texra-high-contrast"` (excl. node_modules) yields exactly 7 hits: `packages/desktop/src/renderer/themeTokens.css:563,569,576` plus 4 test lines in `src/test-kernel/desktop/HostTheme.vitest.ts:47,50,52` and `DesktopThemeTokens.vitest.ts:98`. I read `themeTokens.css:562-576`: every `body.texra-*` line is a comma-sibling of a `body.vscode-*` selector in the same rule (`:562`, `:568`, `:574-575`), so each already matches through the `vscode-*` class set on the same element by the same statement. No dynamic or prefix-based consumer exists — `rg` for backtick-`texra-`, `startsWith('texra-')`, `"texra-"` returns only unrelated `texra.` setting-key and `texra-desktop-diff-` hits, and `packages/desktop/src/renderer/index.html` sets no body class (no other desktop module writes theme classes). The `vscode-*` half is genuinely load-bearing in the desktop renderer (`src/shared/BaseWebviewApp.ts:164-166` tests `.vscode-dark`/`.vscode-high-contrast`; `packages/extension/src/progressView/frontend/components/UserMessage.ts:169-170` uses `:host-context(.vscode-high-contrast)`), so dropping the `texra-*` half is the correct direction. Not already done: `git log -20` on the three paths shows 850d87f69f/#3741 and 3630a1cdb8/#3801 touched only the CSS-variable side; `git log --all --grep` for the symbol finds only #3773 (which created the shared helper). Not already filed: `gh issue list --state all --search` for "applyHostBodyTheme", "texra-dark body class", "THEME_CLASSES" -> 0 rows; theme-token neighbors #3689/#3427/#3756/#9722 are all about `--texra-*`/WA custom properties, not the body-class family. No deliberate ruling: `docs/prds/2026-05-02-prd-electron-app.md:105,113,419,711` describes only the `--texra-*` CSS-variable mapping layer that #3741 retired; nothing in docs/, AGENTS.md, CLAUDE.md, or config/ratchets/ mandates the class names. Touches none of the settled surfaces (no ratchet, no @agent/* edge, no PocketFlow kernel, no AgentEvent/SessionFact split, no platform composition root, no browser-safe @utils module), no catch/fallback (S15 N/A), and no CLI result-JSON contract. S14 R1 favors the removal (dual-representation resting state, zero unique consumers); R5/R6 accounting is strictly negative in both elements and LoC with no forced unrelated churn.

</details>

### L4-agent — Agent runtime, flows, storage, handlers

**Paths**: `src/agent/**`, plus exclusive ownership of `src/tools/ExecutionsTool.ts`

#### Drop AgentDirectoryService's three pass-through ports and let three knip-baseline rows leave the ratchet

- **Area**: `agent-storage-export` · **Kind**: defensive-machinery · **Risk**: low
- **Net**: -55 LoC, -3 elements

**Evidence**

`src/agent/index/AgentDirectoryService.ts` declares five injected collaborators (`:13` AgentDirectoryPathStorage, `:22` AbsoluteDirectoryAccess, `:35` AgentDirectoryIssueReporter, `:39` AgentDirectoryServiceLogger, plus a file-local CustomAgentDirectoryStore). Three of them are already recorded as dead in the ratchet: `config/ratchets/knip-baseline.json` carries `{file: src/agent/index/AgentDirectoryService.ts, category: production-dead, kind: types}` rows for `AbsoluteDirectoryAccess`, `AgentDirectoryPathStorage`, and `AgentDirectoryServiceLogger`. Grepping confirms it: production importers of those three names = 0; the only implementers anywhere are the four `Recording*` classes in `src/test-kernel/agent/AgentDirectoryService.vitest.ts:22,36,50,58`. The class has exactly one production construction site, `createPlatformAgentDirectories` (`src/agent/index/platformAgentDirectories.ts:39-68`), and every one of the three is wired there to a fixed, already host-agnostic target: `storage` → `GlobalStorageFS.ensureDir/fullPath` (`:40-43`), `absoluteDirectories` → `platform().fs.stat`/`createDirectory` (`:45-60`), `logger` → `createLog(options.channel).debug/error` (`:66-69`). `AgentDirectoryIssueReporter` is NOT in this group — it has a real host override (`packages/extension/src/frontend/agents/AgentDirectoryManager.ts:47`) and stays. The factory itself is justified (3 production callers: extension `AgentDirectoryManager.ts:40`, CLI `packages/cli/src/runtime/initPlatform.ts:266`, desktop `packages/desktop/src/main/platform/index.ts:86`).

**Proposal**

Delete the three interfaces and their `AgentDirectoryServiceOptions` fields. Have `AgentDirectoryService` call `GlobalStorageFS.ensureDir/fullPath`, `platform().fs.stat/createDirectory`, and `createLog(options.channel)` directly at `:103,104,113,124,153,165` and the log sites at `:105,115,127,141,155,166` — all three are already reachable from `src/agent/`, which is why the factory could hand them over unchanged. `createPlatformAgentDirectories` keeps `channel`, `customDirectoryStore`, and the `issueReporter` default, losing its three wiring blocks. Then remove the three rows from `config/ratchets/knip-baseline.json` — a baseline shrink, which is the direction the ratchet is meant to move.

**What we give up**

The ability to construct the service against arbitrary fs/logging fakes; `src/test-kernel/agent/AgentDirectoryService.vitest.ts` must move onto the shared platform fake plus a temp storage root, deleting its `RecordingStorage`/`RecordingAbsoluteDirectories`/`RecordingLogger` classes (~50 lines) while keeping `RecordingIssueReporter`. That test rework is the main cost and the main risk. Fix stays inside my paths except the test file.

**Verifier corrections to the evidence above**

Four corrections, none fatal.

(1) "production importers = 0" is true but understates the work: there IS one live consumer, the 179-line `src/test-kernel/agent/AgentDirectoryService.vitest.ts`, whose six tests assert against injected fakes (`storage.ensured`, `absoluteDirectories.ensured`, `STORAGE_BASE_PATH` mapping). Deleting the ports forces that suite to be rewritten against the existing fixtures in `src/test-kernel/support/` (`FakePlatform.ts`, `setupFakePlatform.ts`, `tempDirPlatform.ts`). That is the bulk of the diff and the claim omits it.

(2) The proposal says to call `platform().fs.stat/createDirectory` directly — that would MOVE the 18-line ENOTDIR block from `platformAgentDirectories.ts:46-60` into `src/agent/index/`, which is relocation, not deletion. It should instead call `AbsoluteFS.exists` / `AbsoluteFS.ensureDir` (`src/utils/files/absoluteFS.ts` over `src/utils/files/baseFS.ts:52-72,162`): `BaseFS.statIfExists` already returns undefined on `isFileNotFoundError || isNotADirectoryError`, which is byte-for-byte the semantic the wiring block hand-rolls — its own comment says "Match AbsoluteFS/BaseFS.statIfExists". `AbsoluteFS.validateResolvedPath` only requires an absolute path, which the service has already checked at `:135`. This turns a relocation into a genuine dedupe.

(3) The claim glosses that the logger port carries the channel: `AgentDirectoryServiceOptions` must gain `channel: string` (or a `Log`) so the service can do `createLog(options.channel)` itself, so the options object shrinks by two fields, not three.

(4) Line numbers `:105,115,127,141,155,166` for log sites are approximately right (actual `.logger.debug/error` calls sit at 104, 111, 122, 137, 148, 161 on HEAD) — cosmetic drift only.

<details><summary>Verifier reasoning</summary>

Re-derived every load-bearing fact myself and none of them break.

CONSUMERS: repo-wide grep for `AgentDirectoryPathStorage|AbsoluteDirectoryAccess|AgentDirectoryServiceLogger` (excluding node_modules and stale `dist/`) returns exactly three live sites: the declarations at `src/agent/index/AgentDirectoryService.ts:13,22,39`, the wiring blocks in `src/agent/index/platformAgentDirectories.ts:40-69`, and `src/test-kernel/agent/AgentDirectoryService.vitest.ts:11-14,22,36,58`. Nothing in `packages/extension/package.json`, `packages/extension/src/commands.ts`, `src/shared/schemas/coreSettings.ts`/`stateSettings.ts`, `packages/extension/resources/`, `prompts/`, or `supabase/functions/` references them (they are types with no wire/string form). `new AgentDirectoryService(` has exactly two call sites: `platformAgentDirectories.ts:39` and the vitest at `:83`. All three hosts route through the one factory with identical arguments (`packages/extension/src/frontend/agents/AgentDirectoryManager.ts:40`, `packages/cli/src/runtime/initPlatform.ts:266`, `packages/desktop/src/main/platform/index.ts:86`), and only the extension passes an `issueReporter` override — so keeping `AgentDirectoryIssueReporter` is correct.

ALREADY DONE / FILED: HEAD still carries all three ports. `git log -15` on the two files shows 24c9fc3625 (bootstrap retry), 724e94f469 (#11064 folded BundledAgentDirectorySync, killing the sibling `AgentDirectorySyncLogger`), and d56d39c7c2 (#11009 barrel narrowing — the commit that dropped these three from `src/agent/index/index.ts`, repointed the vitest to the deep path, and thereby created the three knip rows). `gh issue list --state all --search "AgentDirectoryService"` returns nothing; `--search "AgentDirectoryServiceLogger"` returns only #11009 (closed, different scope). Not filed.

DELIBERATE-DESIGN CHECK: nothing rules against it, and two dated docs point the same way. `docs/dev/audits/2026-07-02-agent-sdk-readiness-checkpoint.md:130-137` item 6 explicitly says "Drop the sub-interfaces; have the (already host-agnostic) services use the functional logger directly"; item 5 at `:122-126` states the service "already builds ... entirely out of `platform().fs` + `GlobalStorageFS`". `docs/dev/audits/2026-07-29-...:133-136` files "`AgentDirectoryService` 4 injected ports" under the separate NS-1 barrel run/manage split — tracked, not a defense. The only text that ever justified per-host adapters is `docs/prds/2026-05-04-prd-cli-app.md:74,935` ("CLI provides its own thin adapters"), and that rationale expired with ced0220068 (one composition root for all three hosts).

SETTLED SURFACES: none collapsed. The `@agent/index` barrel exports only `AgentDirectoryService` + `AgentDirectoryEntry` + `createPlatformAgentDirectories`, so the frozen SDK surface is untouched; `host-agent-import-baseline`, `shared-schemas-deep-import`, `architecture-edges` are unaffected; `host-agent-mock-baseline` scopes to `src/test-kernel/{cli,desktop,support}` so a rewrite of `src/test-kernel/agent/...` cannot widen it; the knip baseline only shrinks, which CLAUDE.md names as the intended direction. No catch/fallback is deleted — the ENOTDIR branch is preserved, just delegated (see corrections).

R5/R6 CHECK: this removes elements rather than relocating them, provided the exists-block is delegated to the existing `AbsoluteFS` rather than copied into `src/agent/` as the proposal's literal wording would do.

</details>

#### Derive the fixed template-variable vocabulary from one Zod map instead of listing all 43 keys three times

- **Area**: `agent-core-node` · **Kind**: dual-representation · **Risk**: low
- **Net**: -46 LoC, -3 elements

**Evidence**

The same 43-key vocabulary is written out in full three times, in two files inside this area. (1) `UserVars` hand-written type: src/agent/core/definition/AgentCycleOptions.ts:23-87. (2) `UserVariableValueSchemas` Zod map: src/agent/core/definition/AgentCycleOptions.ts:114-160, pinned to (1) by a `satisfies { [K in keyof Required<UserVars>]-?: ... }` clause at :158-160. (3) `USER_VAR_RUNTIME_TOKENS` array: src/agent/prompt/userVars.ts:66-108, pinned to (1) by `as const satisfies readonly (keyof UserVars)[]` plus a reverse `AssertNever` guard at :110-114. I diffed the three key sets mechanically: 43 / 43 / 43 keys, symmetric difference empty in both directions. Consumers of (3), grepped: `buildUserVarPassthrough` (userVars.ts:123, same file), `FIXED_USER_VAR_KEYS` (userVars.ts:119, same file, used at :500), the compile-time guard (:110-114) — zero production importers outside its own file; one test importer, src/test-kernel/agent/AgentTemplateRenderer.vitest.ts:13. It is already carried in config/ratchets/knip-baseline.json as `production-dead`. `optionalizeUserVariableSchemas` (AgentCycleOptions.ts:162-168) has exactly one caller, AgentCycleOptions.ts:177. Direction of derivation is legal: `agent/prompt` already imports types from `agent/core/definition` (userVars.ts:11-14), and `definition` does not import back.

**Proposal**

Make `UserVariableValueSchemas` the single owner of the vocabulary. Export it, and replace src/agent/prompt/userVars.ts:66-114 (the 43-line array plus the `AssertNever`/`_UserVarsStayInRuntimeTokens` reverse guard) with `export const USER_VAR_RUNTIME_TOKENS = Object.keys(UserVariableValueSchemas) as ReadonlyArray<keyof UserVars>` — order is irrelevant, both consumers build a map and a Set. That alone removes listing (3) and the guard that existed only to police it. Second half, optional and stated separately because it has a real cost: build the map as `UserVarsSchema = z.object({...})` with `OUTPUT_FILES`/`ROUNDS` `.optional()`, define `type UserVars = z.infer<typeof UserVarsSchema>`, and replace `optionalizeUserVariableSchemas` + its call with `UserVarsSchema.partial()` fed into `z.looseObject`, deleting listing (1) as well. `USER_VAR_MODEL`/`USER_VAR_INSTRUCTION` stay — they have real importers (modelSwitchState.ts:1, ToolUsePrepareNode.ts:8, ToolUseWaitNode.ts:10, ToolUseCycleNode.ts:6).

**What we give up**

The first half gives up nothing: the literal-tuple type of the array is not used anywhere, and the `satisfies`-plus-`AssertNever` pair becomes structurally unnecessary once the array is the schema's own key set. The second half gives up the per-key JSDoc on the `UserVars` type members (`z.infer` does not carry them into hover docs) unless the comments are moved onto the schema keys, which is where they read just as well. It also gives up the ability to type a fixed variable as an exact literal shape Zod cannot express — none of the 43 currently need that.

**Verifier corrections to the evidence above**

Key-set claim verified by my own script: UserVars type (AgentCycleOptions.ts:23-87) = 43 keys, UserVariableValueSchemas (AgentCycleOptions.ts:114-160) = 43, USER_VAR_RUNTIME_TOKENS (userVars.ts:66-110) = 43, symmetric difference empty in every direction. Stronger than claimed: the Zod map's key ORDER is byte-identical to the type's, so it is a literal mirror. Consumer grep confirmed: USER_VAR_RUNTIME_TOKENS is referenced only at userVars.ts:115,120,126 and src/test-kernel/agent/AgentTemplateRenderer.vitest.ts:13,67,68; all other hits are dist/ bundles. buildUserVarPassthrough's two production callers (agentCreatorFlow.ts:276->377, agentTemplateRenderer.ts:19->44) both spread PASSTHROUGH into a nunjucks context, so key order is genuinely irrelevant. knip-baseline.json:1493-1496 does carry it as production-dead. optionalizeUserVariableSchemas has exactly one caller (AgentCycleOptions.ts:177). AgentCycleOptions.ts imports only zod and @agent/types/AttachedMemory - no back-import, no cycle; architecture-edges-baseline.json tracks top-level src subsystems only, so an agent->agent value edge is unratcheted.

Corrections: (1) The claim says three listings; there are two more partial ones it missed - docs/.vitepress/components/TemplateVarsPalette.vue and packages/extension/resources/docs/agent-creation/workflow_schema.md. Both are prose subsets and, unlike the three code listings, are NOT pinned to anything, so they are the copies that can actually drift, and the proposal leaves them untouched. (2) The three code listings are compile-time pinned bidirectionally (mapped-type `satisfies` on the map; `as const satisfies` plus the AssertNever reverse guard on the array), so divergence is already a build error - this is repetition, not a drift hazard, which downgrades severity. (3) The second half is wrong and must be dropped: AgentCycleOptions.ts:8-22 documents UserVars as the owner and the schema is pinned TO it via `satisfies { [K in keyof Required<UserVars>]-?: ... }`; deriving UserVars from z.infer inverts that documented direction and forces ~20 lines of per-field JSDoc onto the Zod map for a net-neutral LoC and a readability loss. Its stated API is also wrong - z.looseObject takes a shape, not a ZodObject, so `UserVarsSchema.partial()` cannot be fed into it directly. (4) Net LoC is therefore half one only: delete userVars.ts:66-116 (51 lines), add ~3, export one symbol => about -46, not -50 across both halves. (5) Mild counter-signal: it trades a compile-checked literal for `Object.keys(...) as (keyof UserVars)[]`, which cuts against the precedent of #10405 (removing an `as FileVars` assertion in this same file); sound only because the mapped-type satisfies keeps the source exhaustive.

<details><summary>Verifier reasoning</summary>

Survives, but only the first half, and with corrected framing. I re-derived the 43/43/43 key diff myself rather than trusting the claim, and it holds. I could not find a production consumer that refutes it: USER_VAR_RUNTIME_TOKENS has zero production importers outside userVars.ts (one test importer), and the two buildUserVarPassthrough callers spread the result into nunjucks contexts where order cannot matter. Not already done (git log on both paths shows #11300/#11147/#11018/#10440/#10346, none attempting the collapse; git log -S confirms #10346 CREATED the map and the pin). Not already filed (gh tech-debt search on UserVars returns 14 closed issues, all different: #10015 closed the grab-bag, #10404/#10405 were return-type/assertion fixes, #7791 collapsed the passthrough hand-lists into this very array, #3188 was OUTPUT_FILES_ORDER; USER_VAR_RUNTIME_TOKENS returns zero). No dated ruling defends the triplication - #10346's commit body states the goal was closing the vocabulary, not preserving mirrors. No settled surface is touched: not the five ratchets, not the frozen @agent/* SDK surface, not src/agent/node/index.ts, not the hosts/platform root, not the six browser-reachable @utils modules, not the AgentEvent/SessionFact split. Section 15 is not engaged - nothing removed is a catch or fallback, and the loud throwing collision guard assertNoFixedVarCollision stays; in fact its own comment at userVars.ts:490-497 reasons about the persisted schema's z.null() validator, so FIXED_USER_VAR_KEYS is already conceptually a view of UserVariableValueSchemas and deriving it makes that real. On R5/R6 it does reduce elements rather than relocate them: AssertNever and _UserVarsStayInRuntimeTokens disappear entirely and nothing moves elsewhere, with no unrelated churn (knip baseline unchanged since the export stays for the test). The honest deductions are that the duplication is compile-time pinned rather than driftable, the two genuinely unpinned doc copies are ignored, and the second half is refuted outright - so this is a modest bounded deletion, not a design-level collapse.

</details>

#### Collapse three single-purpose residues: ExecutionRegistry.waitForChange, isWaitingFlowResult's unknown guard, and textConnection's ConnectionResult

- **Area**: `agent-runtime` · **Kind**: other · **Risk**: low
- **Net**: -38 LoC, -3 elements

**Evidence**

(a) src/agent/runtime/executionRegistry.ts:641-654 waitForChange(id, signal) is waitForAnyChange([id], signal) (:660-691) with the resolved id thrown away. Production consumers of each: 1 file, src/tools/ExecutionsTool.ts:273 and :287, both inside that tool's own private wrappers. Non-production consumers: 0 for both (rg over src/test-kernel returns nothing). (b) src/agent/runtime/AgentFlowResult.ts:80-89 isWaitingFlowResult takes `unknown` and duck-types with a typeof check and a cast, but every one of its 7 production call sites already holds a typed AgentRuntimeFlowResult: executeAgent.ts:496, executeAgent.ts:635, resumeRun.ts:416, AgentRunLifecycle.ts:705, src/tools/delegation/nativeSubagentStrategy.ts:168, :334, :407. Non-production call sites: 0 (test hits are comments only). This is defensive re-checking after a same-process typed handoff. (c) src/agent/runtime/textConnection.ts:11-14 ConnectionResult carries a `choice` field that no production code reads — the only reader of bestConnectionMethod is :82-85 agentResponseTextConnector, which takes `.connector`. `choice` is asserted solely at src/test-kernel/agent/TextConnectionHelperModel.vitest.ts:40. bestConnectionMethod is itself a grandfathered production-dead entry in config/ratchets/knip-baseline.json, so this fold lets a baseline row be deleted. Production consumers of agentResponseTextConnector: 4 (packages/extension/src/extension.ts:334, packages/desktop/src/main/index.ts:1242, packages/cli/src/runtime/transcriptSession.ts:12, packages/cli/scripts/tui-harness.tsx:446).

**Proposal**

(a) Delete waitForChange; change src/tools/ExecutionsTool.ts:287 to await currentSession().executions.waitForAnyChange([executionId], signal). (b) Narrow isWaitingFlowResult to (result: AgentRuntimeFlowResult): result is WaitingToolUseFlowResult and reduce the body to the two field comparisons, dropping the typeof guard and the `as { category?: unknown }` cast. (c) In textConnection.ts, drop the ConnectionResult interface and DEFAULT_RESULT in favour of a `const DEFAULT_CONNECTOR = ' '`, have bestConnectionMethod's body become the agentResponseTextConnector arrow returning the connector string directly, and delete the now-unused bestConnectionMethod export — then remove its row from config/ratchets/knip-baseline.json. Update TextConnectionHelperModel.vitest.ts to import agentResponseTextConnector and assert the returned string. All three edits are behaviour-preserving; the fix for (a) and (c) touches src/tools/ and one test file, which are outside this area's paths.

**What we give up**

Nothing at runtime. isWaitingFlowResult stops accepting an untyped value, so any future caller holding a genuinely unknown shape must parse it first — which is the intended boundary rule. bestConnectionMethod's per-call `choice` letter stops being observable, so the test asserts the connector rather than the model's raw A/B/C answer.

**Verifier corrections to the evidence above**

Three corrections, none fatal. (1) The claim's "4 production consumers" of agentResponseTextConnector counts packages/cli/scripts/tui-harness.tsx:446, which is a dev harness script, not production; the real production trio is packages/extension/src/extension.ts:334, packages/desktop/src/main/index.ts:1242, packages/cli/src/runtime/transcriptSession.ts:12, plus the re-export at src/agent/runtime/index.ts:113 — irrelevant either way, since the fold keeps agentResponseTextConnector's signature identical. (2) The claimed -43 is slightly optimistic: I count roughly -19 (registry method plus its JSDoc), -2 (the predicate's null/typeof guard and the cast line; the signature stays), -13 in textConnection, and -6 for the knip-baseline row, so about -40 total and -34 in production code, with a one-line comment fix at executionRegistry.ts:807-808 and a small rewrite of TextConnectionHelperModel.vitest.ts that the claim already accounts for. (3) The claim frames (b) as a pure win; it should note the false-branch narrowing at nativeSubagentStrategy.ts:168 as the one thing `npm run typecheck` must confirm after the retype. Also worth adding to the write-up: (b) alone is ~2 lines and would be too thin to file on its own — it is only worth doing as part of this batch, alongside (a) and (c).

<details><summary>Verifier reasoning</summary>

All three residues check out under my own greps, and none touches a settled surface.

(a) `waitForChange` at src/agent/runtime/executionRegistry.ts:641-654 is literally `waitForAnyChange([id], signal)` (:660-691) with the resolved id discarded (both resolve on abort, both use the same private `addListener`). Repo-wide grep over src, packages/_/src, packages/_/scripts, config, docs, scripts gives exactly two consumer lines: src/tools/ExecutionsTool.ts:287 (`currentSession().executions.waitForChange`) and :273 for the plural form — both inside that tool's own private wrappers (:258-289), which keep their `shouldSkipWait` logic and are not themselves deletable. Zero hits in src/test-kernel, zero in packages/agent/src, zero in config/ratchets or src/test-kernel/architecture, so no ratchet or architecture test pins the registry's method set. The only extra churn is the stale comment at :807-808 naming both callers.

(b) isWaitingFlowResult (AgentFlowResult.ts:80-89) takes `unknown` and duck-types. I confirmed exactly 7 production call sites, all holding a typed value: executeAgent.ts:496 and :635, resumeRun.ts:416 (guarded by `!runResult ||` first, so already non-null), AgentRunLifecycle.ts:705 (`let result: AgentRuntimeFlowResult`), nativeSubagentStrategy.ts:168, :334, :407. The two test hits (NativeSubagentStrategy.vitest.ts:810, nativeSubagentStrategy.ts:21) are comments. It is NOT part of the frozen SDK surface: packages/agent/src/index.ts:52-55 and schemas.ts:28-33 export only the schemas and the `AgentFlowResult`/`ToolUseFlowResult`/`WorkflowFlowResult` types, never the predicate. This is not a §15 masking fallback (no catch, no default substituted for a failure) — it is M6-shaped defensive checking after a same-process typed handoff, so deleting the guard is the checklist's own "delete-the-guard" remedy, not the removal of something load-bearing. Caveat for whoever does it: nativeSubagentStrategy.ts:168 relies on false-branch narrowing (`if (!isWaitingFlowResult(turn)) return turn;` returning `AgentFlowResult`), which comes from the argument's declared type and is unaffected by the parameter retype — but it is the one line to typecheck.

(c) ConnectionResult.choice (textConnection.ts:11-14) has no production reader: the only reader of `bestConnectionMethod` is agentResponseTextConnector at :82-85, which takes `.connector`; `choice` survives as a local for the `Invalid choice` debug line either way. The only assertion of the field is src/test-kernel/agent/TextConnectionHelperModel.vitest.ts:39-40 (`expect(result).toEqual({ connector: '', choice: 'A' })`), reachable through a dynamic `import('@agent/runtime/textConnection')` — the sole importer of that module path anywhere. `bestConnectionMethod` is a grandfathered production-dead export row in config/ratchets/knip-baseline.json:1540-1545, and the ratchet keys on (file, category, kind, name) with no line numbers, so removing the row when the export goes is exactly the sanctioned "shrink the baseline" direction, not a widening. src/agent/runtime/index.ts:113 re-exports only agentResponseTextConnector, so the SDK edge is untouched. Bonus: DEFAULT_RESULT is currently an unfrozen module-level object literal returned across a boundary (§16 shared-mutable-literal smell); folding it to a string const retires that too.

Prior-art checks all came back clean. `git log -12` on the three files shows no removal of any of these (most recent are d7597db54b, 6492dd4a29, 93cc177020 on the registry). `gh issue list --state all --search` surfaced #9980 and #9140 (ExecutionRegistry listener/stop-result, both closed, neither the wait pair), #9141 (nativeSubagentStrategy clone, not the predicate), and for textConnection #6497 (DI through flow services), #7880 (ModelHandler routing), #8749 (delete TextConnectionService), #4206, #10537 — all closed and all about different surfaces. The one documented ruling in this area is the repeated audit warning (docs/dev/audits/2026-07-09 and 07-10) that `bestConnectionMethodAnthropic` and the `openaiApiKey` branch were false-positive "dead code" because packages/extension/.../connectionTests.ts used them — that file no longer exists anywhere in the tree (grep -rln connectionTests returns nothing) and those symbols were already deleted per the 2026-07-21 checkpoint, so the ruling does not bite here. docs/proposals/2026-08-15-latex-agent-port-design.md:114-129 merely describes agentResponseTextConnector as sitting "next to the existing bestConnectionMethod"; it is descriptive, not a ruling to keep the two-function split.

None of the five ratchets, the frozen @agent/* surface, the PocketFlow engine, host/platform composition, the six browser-reachable @utils modules, or the AgentEvent/SessionFact split is involved. No CLI result-JSON contract surface is touched, so risk stays low.

</details>

#### Fold googleHandlerShared back into the only Google handler that survived

- **Area**: `model-handlers-rest` · **Kind**: single-caller-wrapper · **Risk**: medium
- **Net**: -35 LoC, -3 elements

**Evidence**

`src/agent/modelHandlers/google/googleHandlerShared.ts` (205 LoC) exists because there used to be TWO Google handlers. Commit e23c8b76b0 "refactor: use Google Interactions exclusively" (2026-08-02, 23 days ago) deleted `modelHandlerGoogleGenAI.ts` and `googleUsage.ts`; issue #9410 ("delete the feature-frozen Google GenAI fallback handler") is CLOSED. The shared layer was never collapsed after.

Production consumer counts (rg over src/ + packages/*/src):

- `resolveGoogleClient` — 1 production caller: `modelHandlerGoogleInteractions.ts:598`. Non-production: 1 (`src/test-kernel/agent/modelHandlers/GoogleClientRouteCache.vitest.ts:13`).
- `GoogleClientCache` — 1 production use: `modelHandlerGoogleInteractions.ts:576` (`private googleClient: GoogleClientCache | null`). Non-production: 1 (same vitest).
- `uploadGoogleMediaEntries` — 1 production caller: `modelHandlerGoogleInteractions.ts:720`, instantiated at exactly one type (`<Content>`). Non-production: 0 (one doc-comment mention in `support/mediaClassification.ts:19`).
- `GoogleMediaSource` — 1 production use: `modelHandlerGoogleInteractions.ts:1018`.

The generality is provably unexercised, not just single-caller:

- `ResolveGoogleClientParams.sdkLabel` (`googleHandlerShared.ts:30`) is documented as "SDK surface label used in debug logs, e.g. 'Interactions'" — the one caller passes the literal `'Interactions'` (`modelHandlerGoogleInteractions.ts:599`).
- `cached` / `setCached` / `rememberRoute` (`googleHandlerShared.ts:33-41`) are three callbacks whose only job is to read and write `this.googleClient` and call `this.rememberClientCredentialRoute` back on the single handler (`modelHandlerGoogleInteractions.ts:600-607`).
- `uploadGoogleMediaEntries<T>` (`googleHandlerShared.ts:108`) is generic over `T` with `buildMedia`/`buildLabel`/`getClient`/`logger`/`onInsertedEntry` callbacks; the single call site (`:719-729`) pins `T = Content` and every callback delegates straight back to a handler method (`this.buildMedia`, `this.textMedia`, `this.getClient`, `this.logger`).

**Proposal**

Inline `resolveGoogleClient` into `ModelHandlerGoogleInteractions.getClient()` (`modelHandlerGoogleInteractions.ts:594-608`): the client cache it manages IS `this.googleClient`, so the body reads/writes the field directly and calls `this.rememberClientCredentialRoute` directly. That deletes the exported `resolveGoogleClient`, the exported `GoogleClientCache` interface (replaced by a file-local type on the handler), and the whole 12-line `ResolveGoogleClientParams` interface including the dead `sdkLabel` parameter.

For the media pipeline, keep `uploadGoogleMediaEntries` in its own file (the handler is already 2268 lines; moving 90 more lines in would fight the repo's long-file rule) but delete its speculative generality: drop `<T>`, type it against `Content` directly, and drop the `buildMedia`/`buildLabel` indirection in favour of the two handler methods passed as a single `handler`-shaped param or plain function args. `GoogleMediaSource` stays (it is the real input union).

Move the two cache-identity assertions from `GoogleClientRouteCache.vitest.ts` onto the handler (the sibling `GoogleClientRefresh.vitest.ts` already drives caching through the handler), and delete the now-empty file rather than rewriting it around the new shape, per AGENTS.md "Testing discipline".

**What we give up**

The ability to add a second Google SDK surface (a hypothetical future chat/Live handler) without re-extracting the client-cache and upload helpers. That is exactly the speculative generality this repo bans — the second handler was deleted 23 days ago and #9410 is closed, so there is no product owner for it. Also gives up the `sdkLabel` debug-log discriminator, which has had one possible value since the day the other handler died.

**Verifier corrections to the evidence above**

Two corrections. (1) FALSE PREMISE: "the sibling GoogleClientRefresh.vitest.ts already drives caching through the handler." It does not. src/test-kernel/agent/modelHandlers/GoogleClientRefresh.vitest.ts:29-34 defines `class GoogleInteractionsRefreshProbe extends ModelHandlerGoogleInteractions` with `override async getClient()` that returns a stub and reads the private `googleClient` field through an `as unknown as GoogleHandlerWithCache` cast; the second case replaces both getClient and refreshClient with closures. The credential-identity comparison in resolveGoogleClient is never executed there. Reproducing GoogleClientRouteCache's two assertions at handler level requires driving ModelHandler.resolveClientCredential (src/agent/modelHandlers/ModelHandler.ts:502-527) through fetchApiKeyOrThrow and resolveProxyEndpoint, i.e. real credential stubbing — not a two-line move, and likely net-positive test LoC. (2) LOC OVERSTATED AND MEDIA HALF MISSCOPED: the media rework deletes essentially nothing. UploadGoogleMediaEntriesOptions' buildMedia/buildLabel cannot be inlined (modelHandlerGoogleInteractions.ts:1018 buildMedia dispatches on mime type and calls this.mediaResolutionFields/this.isGemini3Model; buildLabel calls this.textMedia at :1005), so "plain function args" is a rename; erasing <T> in favour of Content costs a new cross-file type import and saves 0 lines. It also conflicts with OPEN issue #11297, which rewrites uploadGoogleMediaEntries' two failure branches (googleHandlerShared.ts:150-160, 172-178) — a live masking-site fix, not shape to churn. Additional evidence in the claim's favour that it omitted: no sibling handler caches its client at all, so the Google cache is genuinely handler-local state and the three callbacks exist only to reach back into it.

<details><summary>Verifier reasoning</summary>

The core survives, but only the client half. I re-ran the greps independently: `resolveGoogleClient` has exactly one production caller (modelHandlerGoogleInteractions.ts:598) plus one test (GoogleClientRouteCache.vitest.ts:13); `GoogleClientCache` one production use (:576); `uploadGoogleMediaEntries` one caller (:720, pinned <Content>); `GoogleMediaSource` one use (:1018). No config key, command ID, package.json contribution, agent YAML, prompt, or supabase reference. Provenance confirmed: 13bdfa729f (#6634) extracted the file to serve TWO handlers, and e23c8b76b0 deleted modelHandlerGoogleGenAI.ts (934 lines) + googleUsage.ts, leaving the seam unserved. Not already done, not filed (symbol searches and area:model-handlers issues return only unrelated #11297/#11031), not on any settled surface (no ratchet entry, not the frozen @agent/* manifest, not the PocketFlow kernel, not AgentEvent/SessionFact). Supporting evidence the claimer missed and I found: every sibling handler builds its client INLINE in getClient with no helper (OpenAICompatibleModelHandler.ts:52-76, modelHandlerAnthropic.ts:403-416) — Google is the sole handler inverting control through cached/setCached/rememberRoute callbacks, so inlining converges on the house pattern rather than inventing one. The dated audits (docs/dev/audits/2026-07-01:71, 2026-07-05:160-172) that call googleHandlerShared "clean" argue the two-handler case explicitly ("Two full Google handlers for one provider... shared mechanics are already hoisted"), so they do not rule against collapsing it now that one handler remains. WHERE THE CLAIM FAILS: (a) the media half is churn, not deletion — buildMedia dispatches on mime type using handler state (isGemini3Model/mediaResolutionFields) and buildLabel calls this.textMedia, so neither callback can be removed; dropping <T> for Content saves zero lines and drags the Interactions Content type into the shared file (relocated coupling, section 14 R6). Worse, issue #11297 is OPEN and rewrites exactly those failure branches in uploadGoogleMediaEntries as a section-15 masking defect (possibly routing through reportMediaAttachmentFailure) — reshaping the signature now collides with queued work on the same function. (b) The claim that "GoogleClientRefresh.vitest.ts already drives caching through the handler" is false, so the test-migration step is not free. Record the client-resolution inline only.

</details>

#### Collapse the four workspace-snapshot hydration entry points left forked after #10789 deleted the legacy arm

- **Area**: `agent-core-node` · **Kind**: expired-compat · **Risk**: low
- **Net**: -35 LoC, -3 elements

**Evidence**

`AgentWorkspaceState.fromSnapshot` (src/agent/core/state/AgentWorkspaceState.ts:378-381) and `AgentWorkspaceState.fromCanonicalSnapshot` (:382-387) now have byte-identical bodies: each calls `AgentWorkspaceStateSnapshotSchema.parse(snapshot)` then `AgentWorkspaceState.fromParsedFields(parsed)` (:389-400). The only difference is the parameter type (`unknown` vs `AgentWorkspaceSnapshot`) and the docstrings. `git show 83b9d8e4b4 -- src/agent/core/state/AgentWorkspaceState.ts` (#10789, 2026-08-17, 'refactor: retire legacy state normalizers') shows why: before that PR `fromSnapshot` parsed a three-arm union (`AgentWorkspaceCurrentSnapshotSchema` | `AgentWorkspaceLegacySnapshotSchema` | `EmptyAgentWorkspaceSnapshotSchema`) while `fromCanonicalSnapshot` deliberately parsed only the strict arm. The PR deleted the legacy and empty arms and merged the schemas, but kept both entry points. A fourth layer sits on top: `workspaceFromSnapshot` (src/agent/implementations/flows/reflection/helpers.ts:42-46) is a one-line pass-through to `fromCanonicalSnapshot` whose own justification comment at :39-40 — 'so the legacy migration arm of `AgentWorkspaceState.fromSnapshot` is never re-evaluated mid-flow' — is now false. Production consumers, grepped: `fromSnapshot` 1 (ToolUsePrepareNode.ts:76); `fromCanonicalSnapshot` 2 (ToolUseCycleNode.ts:44 and helpers.ts:45); `workspaceFromSnapshot` 2 (MediaExtractionNode.ts:27, ResponseCycleNode.ts:51); `fromParsedFields` 2, both in-file. Non-production: src/test-kernel/agent/AgentWorkspaceWorkPlanState.vitest.ts:20,27 (`fromSnapshot`) and :47 (`fromCanonicalSnapshot`). A stale comment also survives at ToolUseCycleNode.ts:43.

**Proposal**

Delete `fromCanonicalSnapshot` and inline `fromParsedFields` into `fromSnapshot`, leaving one `static fromSnapshot(snapshot: unknown)`. Delete `workspaceFromSnapshot` from reflection/helpers.ts and have MediaExtractionNode.ts:27 and ResponseCycleNode.ts:51 call `AgentWorkspaceState.fromSnapshot` directly, as ToolUsePrepareNode already does. Point ToolUseCycleNode.ts:44 and the one test at AgentWorkspaceWorkPlanState.vitest.ts:47 at `fromSnapshot`. Delete the two stale comments (helpers.ts:35-41, ToolUseCycleNode.ts:43) that reference a legacy migration arm removed in #10789, and trim `fromSnapshot`'s docstring, which still says 'use fromCanonicalSnapshot instead'. Two of the edited files (helpers.ts, the reflection/tooluse nodes) are under src/agent/implementations/, outside this area's paths.

**What we give up**

The type-level signal that a call site is handing over a snapshot it produced itself this run rather than untrusted persisted bytes: the surviving entry point takes `unknown`. Since both methods run the identical parse, that signal buys no behavioural difference today — it only documented which arm used to run. If a legacy arm is ever reintroduced, the fork has to come back with it.

**Verifier corrections to the evidence above**

Line numbers in the claim are off by ~7 for the first method; everything else checks out.

Actual at HEAD (8968988375), src/agent/core/state/AgentWorkspaceState.ts:

- `static fromSnapshot(snapshot: unknown)` at :371-374 (not :378-381), docstring :359-370 whose last line (:369) still says "use `fromCanonicalSnapshot` instead".
- `static fromCanonicalSnapshot(snapshot: AgentWorkspaceSnapshot)` at :382-387 (docstring :376-381).
- `private static fromParsedFields` at :389-398.
  Bodies are byte-identical: `AgentWorkspaceStateSnapshotSchema.parse(snapshot)` then `AgentWorkspaceState.fromParsedFields(parsed)`.

The "canonical vs union" distinction is genuinely gone: `AgentWorkspaceStateSnapshotSchema` (:319-324) is now a single `z.looseObject({workPlan: z.unknown()}).refine(...).transform(...)` — no `z.union`, no `AgentWorkspaceCurrentSnapshotSchema`, no `AgentWorkspaceLegacySnapshotSchema`, no `EmptyAgentWorkspaceSnapshotSchema` anywhere in the tree. `git show --stat 83b9d8e4b4` (#10789) confirms the deletion.

Consumer grep re-run across src/, packages/{agent,cli,desktop,extension}/src, docs/, config/, prompts/, supabase/, resources YAML:

- `fromCanonicalSnapshot`: 3 non-doc call sites — ToolUseCycleNode.ts:44, reflection/helpers.ts:45, and test AgentWorkspaceWorkPlanState.vitest.ts:47. Matches the claim.
- `workspaceFromSnapshot`: defined helpers.ts:42-46, imported/called at MediaExtractionNode.ts:7,27 and ResponseCycleNode.ts:18,51. Matches.
- `AgentWorkspaceState.fromSnapshot`: ToolUsePrepareNode.ts:76 plus test :20,:27 plus one doc mention (docs/architecture/2026-06-20-pocketflow-state.md:44, which stays valid since the surviving name is `fromSnapshot`).
- Zero `AgentWorkspaceState` references in any packages/_/src host, so no host-agent-import-baseline exposure. Zero matches in config/ratchets/_.json, so no knip/ratchet baseline edit needed.

Two easements the claim did not mention, both favorable: MediaExtractionNode.ts:4 and ResponseCycleNode.ts:4 already import `AgentWorkspaceState` as a value, so switching to `AgentWorkspaceState.fromSnapshot` adds no import. And deleting `workspaceFromSnapshot` orphans both helpers.ts:3 and :4 imports (the file has no other `AgentWorkspaceState`/`AgentWorkspaceSnapshot` use), so helpers.ts loses ~15 lines, not the ~13 implied. Net is closer to -35 than -30.

Stale comments confirmed: helpers.ts:34-41 ("so the legacy migration arm of `AgentWorkspaceState.fromSnapshot` is never re-evaluated mid-flow") and ToolUseCycleNode.ts:40-44 ("never raw persisted/legacy data ... canonical-only path") both describe machinery deleted in #10789.

<details><summary>Verifier reasoning</summary>

Survives. I tried four refutation routes and all failed.

1. Missed consumer — none. The full grep (src, all four host packages, docs, config, prompts, supabase, resources) yields exactly the 5 production call sites and 3 test sites the claim lists. No string-literal, command-ID, config-key, or wire-name form exists for these symbols; they are pure TypeScript statics with no serialized surface. `packages/extension/package.json` contributions, commands.ts, coreSettings.ts/stateSettings.ts, and the agent YAML are all irrelevant here — none mention workspace hydration entry points.

2. Already done — no. `git log -15` on both paths shows #10789 (83b9d8e4b4) removed the arms, and only #10872 and #10875 touched the files since; neither removed the fork. `git log --all --grep=fromCanonicalSnapshot` returns only the four squash-duplicate commits of the older "confine legacy migration to hydration boundary" work, all predating #10789.

3. Already filed — no. `gh issue list --state all --search "fromCanonicalSnapshot"` returns nothing about the fork itself. The nearest issues are #10763 ("Age out the intermediate-era legacy-normalization arms", CLOSED, implemented by #10789) and #9422 (tracking umbrella, CLOSED); both are about deleting the legacy _arms_, which is done, and neither mentions the identical twins left behind. That is precisely the residue this candidate targets.

4. Deliberately justified — the opposite. docs/dev/audits/2026-07-29-agent-sdk-readiness-checkpoint.md:168-178 (§New-2) names this exact pair as debt and states the desired end state: "the `*CanonicalSchema` / `fromCanonicalSnapshot` twins disappear ... This is the house Zod rule ('normalize legacy formats once at the entry point') applied." The 2026-07-30 checkpoint at :157-164 re-verifies it as still present and TRACKED. So the dated rulings back the deletion. The one contrary-looking hit, docs/proposals/2026-08-03-ssot-consolidation-plan.md:897, cites "the `AgentWorkspaceState` pattern: a canonical-only schema for interiors, the union+transform at the boundary" only as an illustration for _other_ schemas — and that union no longer exists, so it pins nothing here.

5. Settled surfaces — untouched. Not one of the five ratchets (no config/ratchets/ hit), not the frozen @agent/* SDK boundary (no host imports these symbols), not src/agent/node/index.ts, not the platform composition root, not the six browser-reachable @utils modules, not the AgentEvent/SessionFact split.

6. Checklist §14 R5/R6 and §13 — this is element removal, not relocation: two exported functions and one private helper go away, three call sites retarget to a symbol they already import, and no new file, type, or indirection appears. No unrelated churn is forced; the only non-production edit is one line in an existing vitest.

7. §15 catch/fallback taxonomy — not applicable. There is no catch, no `??` over a failed read, no `.catch(default)`. Both methods `.parse()` and throw on bad input; validation strictness is unchanged after the collapse because both already run the identical parse.

The one honest cost, which does not refute: `fromCanonicalSnapshot`'s `AgentWorkspaceSnapshot` parameter type is slightly stricter than `unknown`, so the three per-round call sites lose a compile-time nudge. That is documentation-grade value only — the runtime paths are identical — and it is outweighed by the repo's pass-through-collapse rule plus the two comments that currently assert something false about the code (helpers.ts:39-40 and ToolUseCycleNode.ts:43 both promise a "legacy migration arm" that no longer exists, which is actively misleading to the next reader).

Scope note: this is a bounded deletion of an expired-compat residue with a known trigger already fired, not a design question. `recordAs: issue`. The claim's own caveat that helpers.ts and the two reflection/tooluse nodes sit under src/agent/implementations/ is a scoping remark for the filing area, not a blocker — the edit is mechanical and all in one PR.

</details>

#### Stop mirroring the run's storageKey into OutputState; carry it on the services object

- **Area**: `agent-flows` · **Kind**: dual-representation · **Risk**: low
- **Net**: -22 LoC, -1 elements

**Evidence**

`storageKey` is decided once at src/agent/implementations/flows/reflection/runReflectionFlow.ts:72 (a `RunReflectionFlowInput` field) and is already present at runtime on the services object built at :159 (`const services: ReflectionServices<C> = { ...input, ... }`) — it just isn't declared on the `ReflectionServices` type (ReflectionServices.ts:16-31). Instead the value is re-parked in mutable state: outputState.ts:33 declares `storageKey: StorageKey | null`, :57 inits it to null, :167-184 `setActiveRun(state, deps, storageKey)` assigns it, and :101-108 `getStorageKey(state)` throws `'OutputState.storageKey is unset: setActiveRun() must run before...'` if it wasn't. PRODUCTION readers of getStorageKey: 2, and BOTH are debug-only — roundSummary.ts:64 feeds it into the `logger.debug('Finalized round', { data: { round, storageKey, files } })` at :77, and outputValidation.ts:36 feeds it into the `debugInternal(..., \`No expected outputs for round ${currRound} storageKey=${storageKey}\`)`at :72. PRODUCTION callers of setActiveRun: 1 — runReflectionFlow.ts:174. NON-PRODUCTION consumers of getStorageKey and setActiveRun: 0 in src/test-kernel (createOutputState is used by 6 test files, but neither of these two). Because setActiveRun has exactly one caller, fired immediately after`createOutputState()` at :113, its idempotence guard at :172 (`if (storageKey === state.storageKey) return;`) and its resets at :176 (`state.runPreparation = null`) and :179 (`state.openedOutputs.clear()`) can never observe a non-initial state.

**Proposal**

Add `readonly storageKey: StorageKey` to `ReflectionServices` (ReflectionServices.ts) and to `OutputDependencies` (outputState.ts:42-49) — a pure type declaration, since the services literal already spreads it in. Then delete `OutputState.storageKey` (outputState.ts:33, :57), delete the exported `getStorageKey` accessor (:101-108), and have roundSummary.ts:64 and outputValidation.ts:36 read `deps.storageKey`. Reduce `setActiveRun` to a two-statement `startRunWorkspacePreparation(state, deps)` that only kicks off `deps.fileService.prepareRunWorkspace(...)`, dropping the dead guard and the two dead resets and the now-unused `storageKey` parameter.

**What we give up**

The `storageKey`-is-unset runtime guard, which today converts a hypothetical ordering mistake into a thrown Error. After the change the field is non-optional on a typed same-process handoff, so `npm run typecheck` enforces it instead — which is the repo's stated 'trust your inputs / define-errors-out-of-existence' position. Also gives up the ability for a single OutputState to be re-pointed at a second run mid-life, which nothing does.

**Verifier corrections to the evidence above**

Line-number and dedupe corrections: (1) createOutputState() in runReflectionFlow.ts is at :115, not :113. (2) The claim omits two dated documents that a filed issue must cite. docs/proposals/2026-08-07-prod-structural-leads-triage.md:68-70 already triaged these exact symbols and ruled "leave getStorageKey/setActiveRun - multi-consumer" - but that verdict rejects inlining the one-line accessors into OutputNode, not deleting the mirrored state field, and its own rationale is stale (it asserts 3 prod callers of getStorageKey; there are 2, both debug-only). The candidate is a different and stronger fix, so it beats that note, but the issue should say so explicitly or it will be closed as already-triaged. (3) docs/prds/2026-01-30-code-review-fixes.md:114-125 records `state.runPreparation = null` (outputState.ts:176) as a deliberate code-review fix for orphaned workspace-preparation promises under "rapid storage key changes". That scenario is now unreachable (single caller, fresh state per run), so the deletion is correct, but the issue must cite this PRD so a reviewer does not restore it as a regression. (4) Test constructions of the two types are at OutputProgressEvents.vitest.ts:111, XmlOutputManager.vitest.ts:42, MediaExtractionNodeTranscriptLog.vitest.ts:23, ResponseCycleCancellation.vitest.ts:70 - all `as unknown as` casts, so none blocks the type addition. (5) The claim's dedupe hit #10285 is a false positive from GitHub's loose search: `gh issue view 10285` contains no occurrence of storageKey, setActiveRun, or outputState. Dedupe conclusion stands. (6) One scope note: after the guard and resets go, the remainder is a two-statement single-caller helper, which the repo's single-caller-extraction rule argues should be inlined into runReflectionFlow (exporting collectRunSupportFiles if needed) rather than renamed to startRunWorkspacePreparation.

<details><summary>Verifier reasoning</summary>

Survives. I re-derived every load-bearing fact. `getStorageKey` (src/agent/implementations/flows/reflection/output/outputState.ts:101) has exactly 2 production readers, both debug-only: outputValidation.ts:36 -> debugInternal string at :72, and roundSummary.ts:64 -> logger.debug data bag at :77. `setActiveRun` (outputState.ts:167) has exactly 1 production caller, runReflectionFlow.ts:174, fired right after the single production `createOutputState()` at runReflectionFlow.ts:115 - so the idempotence guard at :172 and the resets at :176/:179 can never observe a non-initial state. The value is already on the services object at runtime (`const services: ReflectionServices<C> = { ...input, ... }` at runReflectionFlow.ts:160, with `storageKey` declared on RunReflectionFlowInput at :72), so declaring it on the type is a pure type change. Crucially, no production code anywhere builds an OutputDependencies or ReflectionServices literal: every consumer receives `this.services` (OutputNode) or `services` (runReflectionFlow), and all four test constructions use `as unknown as` casts, so adding a required field breaks no typecheck. Runtime test impact is nil - checkExpectedOutputs is the only path that would newly execute, and all four `endTurn` values in OutputProgressEvents.vitest.ts are `false`, so it is never reached; I ran that suite and it passes 7/7. No settled-surface collision: outputState is not re-exported from packages/agent/src, absent from config/ratchets/knip-baseline.json, untouched by any architecture ratchet, and unrelated to the CLI result-JSON contract. Not filed (verified #10285 has no mention of these symbols). Deleting the mirror also strengthens the invariant rather than weakening it: today a missing key is a runtime throw on a debug-only value; after the change it is a compile-time requirement on ReflectionServices.

</details>

#### Delete the dead `changed` flag and its isDeepStrictEqual deep-compare from parseToolUseShared

- **Area**: `agent-flows` · **Kind**: dead-export · **Risk**: low
- **Net**: -15 LoC, -2 elements

**Evidence**

src/agent/implementations/flows/tooluse/nodes/types.ts:127-145 defines `ParsedToolUseSharedResult` with a `changed: boolean` arm, computed at :143 as `changed: !isDeepStrictEqual(shared, parsed.data)`, which is the sole reason for the `import { isDeepStrictEqual } from 'node:util'` at :1. PRODUCTION consumers of parseToolUseShared: 2 — src/agent/implementations/flows/tooluse/runToolUseFlow.ts:458 and src/agent/runtime/SessionResumeRetrieval.ts:144 (outside this area). Grepped both: they read only `.success`, `.data`, `.error`; neither touches `.changed`. NON-PRODUCTION consumers of `.changed`: 3, all in src/test-kernel/agent/SessionResumeRetrieval.vitest.ts:576, 588, 606. Ambiguous (scripts/, docs/): 0. The last production reader was deleted by bc6e58ac82 `refactor: simplify flow topology boundaries (#10803)` on 2026-08-17 — `git show bc6e58ac82 -- .../runToolUseFlow.ts` shows the removed `let shouldWriteShared = parsedShared.changed` / `if (parsedShared.changed)` normalize-and-rewrite block. The residue is not free: `isDeepStrictEqual(shared, parsed.data)` deep-compares the entire persisted shared blob — including the full `messages: ProviderMessageArraySchema` conversation — on every tool-use resume and on every SessionResumeRetrieval probe.

**Proposal**

In src/agent/implementations/flows/tooluse/nodes/types.ts: drop the `node:util` import, drop the `changed` field from `ParsedToolUseSharedResult`, and let `parseToolUseShared` return `ToolUseRunSharedSchema.safeParse(shared)` directly (its inferred safe-parse result already carries success/data/error), removing the hand-written `ParsedToolUseSharedResult` alias. Both production call sites compile unchanged. In src/test-kernel/agent/SessionResumeRetrieval.vitest.ts, delete the three `changed` assertions/fixtures at :576, :588, :606 — they pin behavior the product no longer intends to preserve (AGENTS.md testing discipline: retired behavior takes its tests with it).

**What we give up**

Nothing observable. The flag reported whether Zod's parse normalized or stripped anything from the persisted record; no code has acted on that since 2026-08-17. If a future 'did this record need rewriting?' signal is wanted, it should be reintroduced with the writer that consumes it, not carried speculatively.

**Verifier corrections to the evidence above**

Three corrections. (1) The perf framing is overstated: runToolUseFlow.ts:458 sits in the NON-resume branch (the `else` after `if (input.resume)`) — the fresh-launch stale-record collision check that throws immediately — not on the resume path. Per actual tool-use resume the deep compare runs once, at SessionResumeRetrieval.ts:144. The win is dead-code deletion, not a meaningful hot-path saving. (2) Dedupe is thinner than claimed: closed issue #10764 ("Delete the four owned-invariant double-checks (entry #4)") already owned sub-item (a), the resume double-read + isDeepStrictEqual drift check, and its follow-through (#10794/#10890/#10803) reported the compare gone. It is closed and never names the `changed` field or types.ts, so this is unfiled residue of landed work rather than a live duplicate — but the filing should reference #10764 and #10803 rather than present the flag as newly discovered. (3) The three test lines are not inert fixtures: 576 and 606 sit inside `toEqual`/`toMatchObject` blocks and 588 reads `toMatchObject({ success: true, changed: false })`; they use `changed: false` as a weak proxy for "the parse did not normalize". Deleting them loses that proxy, though each test's substantive `data` assertions remain. Line counts: production removal is import+blank (-2), the `ParsedToolUseSharedResult` alias and its blank (-4), and the function body collapsing from 10 lines to 3 (-7) = -13; tests net about -2 (one line becomes shorter rather than disappearing).

<details><summary>Verifier reasoning</summary>

Survives verification. Independent repo-wide greps (excluding node_modules/.git/dist) find exactly two production consumers of parseToolUseShared: src/agent/implementations/flows/tooluse/runToolUseFlow.ts:458 and src/agent/runtime/SessionResumeRetrieval.ts:144. I read both: runToolUseFlow reads only .success and .error (throws PersistedFlowStateError('invalid-shared')); SessionResumeRetrieval reads only .success, .error, .data. A grep for `.changed` across src/ and all four host packages returns zero hits; the only occurrences of the token are three test lines in src/test-kernel/agent/SessionResumeRetrieval.vitest.ts:576, 588, 606. The last production reader was indeed removed in #10803 — `git log -S"parsedShared.changed"` points at bc6e58ac82, whose runToolUseFlow.ts diff deletes `let shouldWriteShared = parsedShared.changed` and the `if (parsedShared.changed)` rewrite block; `shouldWriteShared` has zero hits today. No command IDs, config keys, wire strings, extension package.json contributions, resources YAML, prompts, or supabase functions are involved — this is a file-local type plus one internal function. Not in config/ratchets/, and it touches no settled surface (no ratchet, no @agent/* SDK edge, no src/agent/node engine file, no AgentEvent/SessionFact split, no CLI result-JSON contract). Not a masking site: the deleted expression is a pure comparison, not a catch or fallback, and the loud `success:false` path is untouched, so checklist §15 does not apply. Design check: docs/proposals/2026-08-16-overdefensive-top10.md entry 4(a) prescribes making the resume window unrepresentable so that "the second read and the isDeepStrictEqual compare are gone", and marks it LANDED (#10794/#10890) — the dated ruling points the same way as this candidate. The schema header at types.ts:36-45 independently confirms the flag is semantically dead: unknown top-level keys are stripped by design and "the resumed flow's first persisted step then rewrites the stripped record" unconditionally, so no caller needs to know whether the parse normalized. `z` remains used at 10+ other sites in the file, so dropping the `z.ZodError` alias forces no unrelated churn, and zod v4's safe-parse result narrows on .success exactly as the hand-written union does (the code already `return parsed`s the failure arm), so both call sites compile unchanged. Bounded single-file deletion plus two test-line edits: an issue, not a proposal.

</details>

#### Fold processMultipleOutputs into extractFilesFromXml and drop its knip-baseline row

- **Area**: `agent-flows` · **Kind**: single-caller-wrapper · **Risk**: low
- **Net**: -15 LoC, -2 elements

**Evidence**

src/agent/implementations/flows/reflection/output/outputFileExtraction.ts:133 exports `processMultipleOutputs(state, deps, xmlManager, outputLocation, currRound)`. Its ONLY production caller is `extractFilesFromXml` at :198, defined at :179 with the byte-identical 5-parameter signature — extractFilesFromXml adds only a `withOutputStage` wrapper, an awaited `prepareRunWorkspaceIfNeeded`, and `ensureRoundData(state, currRound).rawOutput ??= outputLocation` before delegating. The in-code comment at :195-197 ('The unified protocol emits <documents><document name="..."> containers (N >= 1), so all agents route through the multi-document path') confirms the 'multiple' branch is now the only branch, so the split no longer separates two cases. PRODUCTION consumers of processMultipleOutputs outside the file: 0. NON-PRODUCTION consumers: 4 call sites in 2 files — src/test-kernel/agent/output/XmlOutputManager.vitest.ts:916 and :1370, src/test-kernel/agent/output/OutputProgressEvents.vitest.ts:329 and :370. Because it is exported for tests only, it already carries a grandfathered row in config/ratchets/knip-baseline.json:1361-1365 (`category: production-dead, kind: exports`). This is a baselined entry that can now LEAVE the baseline. Note the tests call `createOutputState()` whose `runPreparation` is null, so the added `prepareRunWorkspaceIfNeeded` is a no-op for them.

**Proposal**

Inline the body of `processMultipleOutputs` into `extractFilesFromXml`'s `withOutputStage` callback (outputFileExtraction.ts:179-207), delete the separate export, and repoint the four test call sites to `extractFilesFromXml` — a same-arity, same-argument swap. Remove the `src/agent/implementations/flows/reflection/output/outputFileExtraction.ts / processMultipleOutputs` row from config/ratchets/knip-baseline.json (shrinking a baseline, never widening one). Update the stale reference in outputOperations.ts:31, which names `processMultipleOutputs` in a docstring.

**What we give up**

The ability to exercise the document-splitting step in isolation from the output stage wrapper. The OutputProgressEvents tests assert on emitted run facts, so routing them through extractFilesFromXml means one extra `Output: Process files rN` stage appears in the recorded event stream; those two assertions may need the stage accounted for. That is the only real cost.

**Verifier corrections to the evidence above**

Corrections/additions to the original evidence: (1) The claim calls the test swap "same-arity, same-argument" without noting the tests would newly execute withOutputStage; that is fine but only because withOutputStage passes `skip: true` and TraceEmitter.openStage returns a SkippedStageHandle that emits nothing (src/agent/trace/TraceEmitter.ts:215-234, 309-327) and because XmlOutputManager.vitest.ts:39-48 uses a non-strict spiedTrace (a strict double would throw on the openStage read). (2) The sole production caller is not a bare call: OutputNode.ts:93-102 wraps extractFilesFromXml in tryOperation(..., recoverWarn('Output processing')), so the folded function stays inside an existing recovery boundary. (3) The knip-baseline row spans config/ratchets/knip-baseline.json:1360-1365 (file at :1361, name at :1364), and deleting it removes ~6 JSON lines on top of the production delta. (4) The stale docstring at outputOperations.ts:31 names processMultipleOutputs alongside LatexDiffManager in a sentence about shared error-recovery boilerplate; it should be repointed to extractFilesFromXml, not just deleted.

<details><summary>Verifier reasoning</summary>

I could not refute it. Independent verification:

CONSUMER GREP (repo-wide, excluding node_modules and built bundles in packages/extension/dist and packages/cli/.texra-validate-run): `processMultipleOutputs` appears in exactly 7 source locations — its declaration (src/agent/implementations/flows/reflection/output/outputFileExtraction.ts:133), its one in-file call (:198), a stale docstring mention (src/agent/implementations/flows/reflection/output/outputOperations.ts:31), the knip-baseline row (config/ratchets/knip-baseline.json:1361-1365), and 4 test call sites plus 2 test imports in src/test-kernel/agent/output/XmlOutputManager.vitest.ts (:6, :916, :1370) and src/test-kernel/agent/output/OutputProgressEvents.vitest.ts (:13, :329, :370). Zero production consumers outside the file. No hits in packages/extension/package.json, commands.ts, coreSettings.ts/stateSettings.ts, resources/ YAML, prompts/, or supabase/functions/ — this is an internal function name, not a command id, setting key, event name, or wire string. `extractFilesFromXml` has exactly one production caller: src/agent/implementations/flows/reflection/nodes/OutputNode.ts:95 (inside a tryOperation recoverWarn('Output processing')).

NOT DONE: git log for the file shows 273ee5a633, d3d0ecf753 (#11049), 1d17d1b29a, 7481e16337, 2c2e04ac2a. #11049's own message says it folded the single-use OutputFileProcessor class into module functions; processMultipleOutputs is the leftover of that fold, still exported only for tests. `git log --all --grep` for either symbol returns only unrelated old "multiple outputs" feature commits.

NOT FILED: gh issue search for processMultipleOutputs / outputFileExtraction / extractFilesFromXml returns only #4205 (unrelated CLI --input path bug).

NO PROTECTING RULING: the only docs/ hit is docs/dev/audits/2026-05-29-agent-sdk-readiness-audit.md:1141, which merely notes the xmlExtraction.ts → outputFileExtraction.ts rename as feature work. Nothing in docs/proposals/, docs/architecture/, AGENTS.md, or CLAUDE.md defends this split. It touches none of the settled surfaces: not a ratchet invariant being widened (it SHRINKS knip-baseline), not the @agent/* host deep-import baseline (test-kernel already imports this specifier and would keep importing the same module path, just a different symbol — no NEW distinct specifier), not src/agent/node/index.ts, not the platform composition root, not the browser-safe @utils set, not the AgentEvent/SessionFact split, and not the CLI result-JSON contract consumed by texra-action.

NO FALLBACK LOSS (§15): the fold moves, not deletes, the two loud paths — tryOperation's recover → handleNoOutputs, and handleNoOutputs' logger.warn about unwrapped <documents>. Neither is a masking site being removed.

§13/§14 R5/R6: this is a real element reduction (one exported symbol deleted, one baseline row deleted, no new construct), not a relocation. The one thing the claim understates, which I checked and which does NOT refute it: repointing the tests to extractFilesFromXml additionally runs them through withOutputStage. That is inert in tests — withOutputStage (outputState.ts:~285) passes `skip: true`, and TraceEmitter.openStage:218 returns a SkippedStageHandle whose run()/within() only set async-local stage context and emit nothing (TraceEmitter.ts:309-327); the XmlOutputManager tests pass a NON-strict `spiedTrace()` in processorDeps (:39-48), so openStage falls through to noopTrace.openStage. The claim's note about prepareRunWorkspaceIfNeeded being a no-op (createOutputState sets runPreparation: null) is correct.

Residual costs, both small: extractFilesFromXml becomes a ~45-line function with three nesting levels (withOutputStage callback → tryOperation callback), and the deeper indentation will cost a few prettier re-wraps against the claimed -14.

</details>

#### Delete AgentRosterSnapshot.agents: computed on every snapshot(), read by nobody

- **Area**: `agent-trace-misc` · **Kind**: other · **Risk**: low
- **Net**: -5 LoC, -2 elements

**Evidence**

`AgentRosterSnapshot.agents: ByCategory<Entry[]>` is declared at src/agent/roster/AgentRosterController.ts:71 and written at :223 (`agents: byCategory((category) => this.getVisibleAgents(category))`). `snapshot()` (:203) has exactly two callers repo-wide: packages/cli/src/runtime/agentRoster.ts:27 and src/test-kernel/controllers/AgentRosterController.vitest.ts:279. Neither reads `.agents` — the CLI copies selection/effectiveSelection/defaultTeamId/missingTeamId/unresolvedNames (agentRoster.ts:31-39) and gets its key lists from a separate `roster.getEnabledAgentKeys(category)` call (:36-38); the test reads only `.missingTeamId`. Grep of `.agents` across src+packages returns only `preset.agents.*` (SettingsAgentCatalogController.ts:133,174; SettingsTeamRosterController.ts:71) and CLI `result.agents` from a different record (packages/cli/src/commands/agents.ts:51-53) — production consumers of this field: 0; non-production: 0. The write is not free: `getVisibleAgents` (:181-194) resolves every selected identifier through `resolveEntry` and de-dupes via a Map, for both categories, on every snapshot.

**Proposal**

Delete the `agents` field (:71) and the `byCategory(...)` line (:223). `AgentRosterSnapshot`'s `Entry` type parameter (:60-62) then has no referent, so the interface collapses to a non-generic `AgentRosterSnapshot` and the three `AgentRosterSnapshot<Entry>` annotations (:176, :203, :277) lose their argument. `getVisibleAgents` stays — it has 6 real production callers (packages/cli/src/commands/{config,orchestrate,init}.ts, packages/cli/src/runtime/agents.ts, SettingsAgentCatalogController.ts, desktopAgentSettingsController.ts) reached directly, not through the snapshot. Composes with candidate 1, which un-exports the same interface.

**What we give up**

A caller that wanted the resolved per-category entry lists and the selection facts from one call now makes two (`snapshot()` plus `getVisibleAgents(category)`). No current caller does.

**Verifier corrections to the evidence above**

Two corrections, neither load-bearing. (a) The claim's "getVisibleAgents ... has 6 real production callers ... reached directly" conflates two symbols: the controller _method_ `AgentRosterController.getVisibleAgents` has 3 direct production callers (src/agent/index/agentRegistry.ts:422, packages/cli/src/commands/config.ts:149, packages/extension/src/frontend/agents/register.ts:19), while the free function `getVisibleAgents` re-exported from `@agent/index` (agentRegistry.ts:421) has ~10 (agentRegistry.ts:437,471,591,594; runChatTui.tsx:211; runtime/agents.ts:312; commands/init.ts:49; commands/orchestrate.ts:175; SettingsAgentControllerFactory.ts:55; desktop/main/index.ts:687). Either way the method survives the deletion. (b) The claim did not note that `AgentRosterSnapshot` also appears in `packages/agent/dist/types/src/agent/roster/AgentRosterController.d.ts:17,34,37`; I verified that path is untracked build output (0 files under `git ls-files packages/agent/dist`), so it is not a contract and regenerates.

<details><summary>Verifier reasoning</summary>

Independently confirmed as a genuine write-only field. (1) `snapshot()` has exactly two callers repo-wide: `packages/cli/src/runtime/agentRoster.ts:27` and `src/test-kernel/controllers/AgentRosterController.vitest.ts:279`. I re-grepped `roster.snapshot|.snapshot(|rosterSnapshot` across src + all four packages (excluding node_modules and bundled .texra-validate-run artifacts) and found no third site. The CLI reads only `selection`, `effectiveSelection`, `defaultTeamId`, `missingTeamId`, `unresolvedNames` (agentRoster.ts:31-39) and gets key lists from `roster.getEnabledAgentKeys(category)` (:36-38); `CliAgentRosterRecord` (agentRoster.ts:11-22) has no `agents` field at all, so the CLI result-JSON contract consumed by texra-action is untouched. The test reads only `.missingTeamId`. (2) The one nearby-looking consumer I checked as a possible refutation, `packages/cli/src/chat/tui/forms/AgentRosterForm.tsx:280,310` (`data.agents.toolUse`), is a different object: `AgentRosterData.agents` is built in `loadRosterData()` (:110-117) from `byCategory((category) => getAgentsByCategory(category))`, not from the snapshot. Every other `.agents` hit in the repo is `preset.agents` (AgentModePreset) or `result.agents` from the agents-command record. (3) `AgentRosterSnapshot` is referenced only inside its own defining file (:60, :176, :203, :277) plus the untracked build artifact `packages/agent/dist/types/...` (`git ls-files packages/agent/dist` = 0 files), so it is not on the frozen `@texra-ai/agent` surface — `packages/agent/src/{index,node,schemas}.ts` never mention roster. (4) No ratchet touches it: `config/ratchets/*.json` mentions AgentRoster only for four `AgentRosterForm.tsx` knip rows. (5) No docs/proposals/architecture ruling justifies the field; `git log -20 -- src/agent/roster/` shows no prior removal attempt and `git log --all --grep AgentRosterSnapshot` is empty. (6) Not filed: tech-debt search for "AgentRosterSnapshot" and "roster snapshot" returns nothing matching; #11014 (OPEN) covers `repairLegacySelection` in the same file, a genuinely different finding. (7) No unrelated churn: `byCategory`/`ByCategory` remain used at :334-412, so imports are unaffected; the `Entry` param stays on `AgentRosterControllerDeps` and the class (`getVisibleAgents` at :181 keeps many production callers via `agentRegistry.ts:421` plus direct method calls at config.ts:149 and register.ts:19). (8) Not a masking-fallback site (§15 N/A); it is speculative generality removal, which §14 R5/R6 favors, and it is net-negative LoC. Bounded, low-risk, one-file deletion — an issue, not a proposal. Only caveat: the win is small (~5 LoC, one field + one type parameter + a per-call double `getVisibleAgents` resolve), so it is near the too-thin line but clears it because it also collapses a generic parameter to nothing.

</details>

#### Un-export 10 types with zero cross-file references in agent trace/roster/review/followUp

- **Area**: `agent-trace-misc` · **Kind**: dead-export · **Risk**: low
- **Net**: 0 LoC, -10 elements

**Evidence**

Repo-wide `rg -w <name>` (excluding node_modules/dist/out) shows each of these appears ONLY inside its own defining file — 0 production consumers, 0 test-kernel consumers, 0 script/doc consumers: `AgentRosterSnapshot` (src/agent/roster/AgentRosterController.ts:60; other refs :176, :203, :277 all same-file); `CollectReviewDiffResult` (src/agent/review/reviewDiff.ts:66; :277); `BaseBranchCandidate` (src/agent/review/reviewDiff.ts:184; :198); `AppendFollowUpResult` (src/agent/followUp/followUpMessages.ts:78; :87, :150); `FollowUpPresentation` (src/agent/followUp/ToolUseFollowUp.ts:43; :81); `SubmitFollowUpOptions` (src/agent/followUp/ToolUseFollowUp.ts:46; :124, :231); `FollowUpConsumerKind` (src/agent/followUp/ToolUseFollowUpQueueManager.ts:13; :40, :95, :307); `FollowUpSubmission` (src/agent/followUp/ToolUseFollowUpQueueManager.ts:55; :156); `ChildRunDeliveryResult` (src/agent/followUp/childRunDelivery.ts:9; :18); `DrainedFollowUpItem` (src/agent/followUp/FollowUpQueue.ts:37; :50, :99). None is re-exported by src/agent/trace/index.ts, src/agent/followUp/index.ts, src/agent/review/index.ts, src/agent/index/index.ts, or packages/agent/src/index.ts (grepped each). They are invisible to `check:dead-code-ratchet` because a type reachable from an exported signature counts as used — the exact fourth gap recorded in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md §4. `AppendFollowUpResult` is already named as a lead in docs/proposals/2026-08-07-prod-structural-leads-triage.md:197 ("15 zero-production-caller exported types (AppendFollowUpResult, CurrentToolContexts, SeverityCounts, ...) prunable by type-export audit") and was never filed or acted on.

**Proposal**

Drop the `export` keyword from all 10 declarations. Nothing else changes: each is a return type, parameter type, or local alias consumed only from within its own module, so inference at every call site is unaffected. Direct replication of PR #11392 ("refactor(controllers): un-export 13 symbols with no cross-file consumer", closed #11386), which did exactly this for src/controllers/**; that PR was 14 insertions / 16 deletions and left the ratchet green with no baseline change. Verify with `npm run typecheck` and `npm run check:dead-code-ratchet`.

**What we give up**

Nothing behavioral. A future consumer that wants to name one of these types by hand has to re-add the export keyword. Two adjacent same-species types are deliberately excluded because a test-kernel file names them and un-exporting would force a test edit: `AgentRosterEntry`/`AgentRosterControllerDeps` (AgentRosterController.vitest.ts:4-7) and `CollectReviewDiffOptions` (AgentReviewDiff.vitest.ts).

**Verifier corrections to the evidence above**

Two corrections to the original evidence, plus one scope note.

CORRECTION 1 (the significant one). The claim cites "the exact fourth gap recorded in docs/proposals/2026-08-19-dead-code-gate-blind-spots.md §4" and states the mechanism is "a type reachable from an exported signature counts as used." That mechanism was RETRACTED. §4 at HEAD is titled "Un-exporting a type is never flagged - mechanism unconfirmed" and is explicitly labelled "Open question, not an established gap." It says: "The mechanism is not established, and an earlier draft of this section got it wrong. That draft claimed the distinguishing factor was reachability from an exported signature." The retraction landed in afb35b99f2 / 5b02ff6293 (#11406), and #11409 is still open about related backwards claims in the sibling audit doc. Any issue filed from this candidate must NOT repeat the retracted mechanism.

Silver lining: §4 states what is needed to establish the gap - "a specimen that is exported, has no test consumer, has no cross-file production consumer, and is still absent from the baseline." All ten of these are exactly that specimen (I confirmed absence from knip-baseline.json myself). The issue should offer them as the missing specimen rather than assert the mechanism.

CORRECTION 2 (cosmetic). The title says "trace/roster/review/followUp" but no src/agent/trace symbol is in the list. The areas are roster (1), review (2), followUp (7). Retitle to "Un-export 10 types with zero cross-file references in agent roster/review/followUp".

SCOPE NOTE. `FollowUpConsumerKind` and `SubmitFollowUpOptions` are members/parameters of types the @agent/followUp barrel makes cross-host public (FollowUpRecoveryLease, submitFollowUp). Still zero-reference and still safe to un-export, but they belong in a separately-justified bucket in the issue, not lumped with the eight purely internal ones.

Everything else in the claimed evidence reproduced exactly, including all path:line citations.

<details><summary>Verifier reasoning</summary>

All ten claims survive my own repo-wide verification, but two supporting statements in the evidence are wrong and one symbol needs a per-symbol judgement rather than a blanket sweep.

WHAT I VERIFIED MYSELF

1. `rg -n -w <name>` over the whole repo (excluding node_modules/dist/out/_.map, including docs/, prompts/, supabase/, packages/extension/resources/, packages/extension/package.json, packages/_/src, src/test-kernel) returns only same-file hits for every one of the ten. Zero production, zero test-kernel, zero script, zero doc consumers (the single doc hit is the AppendFollowUpResult lead line in docs/proposals/2026-08-07-prod-structural-leads-triage.md:197). These are types, so there is no string-literal/command-ID/config-key/wire-name form to miss.
2. No barrel re-exports them. `rg "^export \*" src/agent packages/agent/src` returns nothing (no star barrels in src/agent at all). I read src/agent/followUp/index.ts (exports only describeFollowUpFailure, notifyFollowUpSent, presentFollowUpResult, submitFollowUp, SubmitFollowUpResult, FollowUpQueueInput, FollowUpRecoveryLease), src/agent/review/index.ts (collectReviewDiff, isPathInChangeSet, listBaseBranchCandidates, and the reviewIssues vocabulary), and packages/agent/src/index.ts. None of the ten appears. src/agent/roster/ has no index.ts.
3. Ratchets: none of the ten is in config/ratchets/knip-baseline.json (grep for all ten and for "followUp|roster|review" -> only an unrelated `toolHeaderPreviewBudget`). Un-exporting can only shrink, never widen, a baseline, so host-agent-import-baseline, shared-schemas-deep-import, host-agent-mock, and architecture-edges are all untouched.
4. Declaration-emit safety, the one way this could actually break: tsconfig.build.json runs `declaration: true, emitDeclarationOnly: true` over the packages/agent graph, which pulls in src/agent/followUp/*. Every one of the ten is referenced only from within its own module, so tsc emits the un-exported declaration into that module's own .d.ts. TS4023 ("cannot be named") only fires across modules, and no cross-module reference exists. Safe.
5. Not already done: `git log --oneline -15 -- src/agent/followUp/ src/agent/review/ src/agent/roster/` shows only single-owner-session work (bf635cda98, 3fb940c75a, 30dc3e9f10, 95e1555035) and Tier-1 barrel seeding (68bc4fefec). `git log --all --grep="un-export"` shows 3d8fba40d7/a1f6a3c7cd (#11392) scoped to src/controllers/** and 5e3755759d (#9242) scoped to schemas.
6. Not already filed: #11386 (CLOSED, controllers-only, closed by #11392) is the precedent, not a duplicate. No open tech-debt issue covers src/agent type exports (I listed all 6 open tech-debt issues; none is related).
7. Settled surfaces untouched: no @agent/* deep-import specifier changes, no PocketFlow engine, no host/platform composition, no browser-safe @utils set, no AgentEvent/SessionFact split, no catch/fallback (§15 M1-M6 not implicated), no CLI result-JSON contract.

WHY IT IS STILL WORTH RECORDING (§13/§14 R5/R6): 0 net LoC, -10 exported elements, no relocation of complexity, no forced churn anywhere. The compiler verifies each removal. That is the same shape as #11392, which landed green.

CAVEAT WORTH WRITING INTO THE ISSUE (not a refutation): two of the ten sit on the documented cross-host door rather than being purely internal.

- `FollowUpConsumerKind` (src/agent/followUp/ToolUseFollowUpQueueManager.ts:13) types `FollowUpConsumerLease.kind` (:40), and `FollowUpRecoveryLease` extends that lease (:43) and IS re-exported through the @agent/followUp barrel and imported by packages/cli/src/chat/chatSessionController.ts:24. Un-exporting compiles fine, but it leaves a barrel-public type whose member type hosts cannot name.
- `SubmitFollowUpOptions` (src/agent/followUp/ToolUseFollowUp.ts:46) is the options bag of `submitFollowUp`, the barrel's flagship cross-host function (used at :231). Hosts construct it inline today, so inference covers them, but the type becomes un-nameable.
  Both are defensible to un-export; they just deserve the same explicit per-symbol note #11386 gave its test-kernel-only carve-out, so a reviewer is not surprised.

</details>

### L5-tools — Tools

**Paths**: `src/tools/**` except `ExecutionsTool.ts`

#### Delete the never-configured maxSessions capacity-eviction path from the direct Lean LSP adapter

- **Area**: `tools-document` · **Kind**: speculative-generality · **Risk**: medium
- **Net**: -120 LoC, -5 elements

**Evidence**

`DirectLspLeanAdapterOptions.maxSessions` (`src/tools/lean/direct/directLspAdapter.ts:64-70`) has ZERO production configurators. The only production construction is `registerDirectLeanLanguageServices` at `:82` — `const leanAdapter = createDirectLspLeanAdapter();` with no argument — and that is the sole wiring for CLI and desktop (`grep -rn maxSessions src packages --glob '!node_modules'` outside the defining file returns only `src/test-kernel/tools/lean/DirectLspAdapter.vitest.ts:255,296,344,389,471,639`). There is no `texra.lean.*` setting for it in `src/shared/schemas/coreSettings.ts` or `stateSettings.ts`. The option's own doc comment concedes it: "Unset means no capacity eviction — parallel worktrees stay up until they go idle" (`:66-68`).

With `maxSessions == null`, `evictForNewSession` (`:337-353`) degenerates to `await evictIdleSessions()` and returns at `:342`, which makes the following dead in production:

- `lruRootExcept` (`:322-335`, 14 lines) — only caller is `:345`, inside the `maxSessions` while-loop.
- `sessionFreedWaiters` / `notifySessionFreed` / `waitForSessionFreed` (`:106`, `:134-143`) — the waiter set exists solely to unblock `:350`; its three notify calls at `:188`, `:254`, `:388` then have no listener.

The genuine production protection against too many `lean --server` processes is a different, reachable path: EMFILE/ENFILE recovery via `isFileTableExhausted` → `evictOthersForExhausted` (`:360-385`, called from `:444`) plus the 30-minute idle timer (`DEFAULT_LEAN_IDLE_TIMEOUT_MS`, `:48`). Removing `maxSessions` does not touch either, nor the per-run owner set / lease machinery (`registerSessionOwner`, `beginUse`/`endUse`, `stopSessionsForRun`) that #10248/#10350 added for run-end ownership.

Introduced 2026-08-14 by `68d6dc8b21` (#10248, `git log -S"maxSessions"` returns exactly that one commit); the tail never closed.

**Proposal**

Delete `maxSessions` from `DirectLspLeanAdapterOptions` and its clamp at `:100-101`; delete `lruRootExcept`, `sessionFreedWaiters`, `notifySessionFreed`, `waitForSessionFreed` and the three `notifySessionFreed()` calls; fold `evictForNewSession` into its body — rename the two call sites at `:432` and `:499` to call `evictIdleSessions()` directly, since that is all it does once the capacity loop is gone. Delete the six `maxSessions`-configured cases in `src/test-kernel/tools/lean/DirectLspAdapter.vitest.ts` (they pin retired behavior; AGENTS.md "Testing discipline" says delete rather than rewrite them). Keep `idleTimeoutMs`, `now`, and `lakeCommand`, which are real injection seams for the eviction and spawn paths that DO run in production.

**What we give up**

A hard ceiling on concurrent `lake env lean --server` processes that nothing can currently set. If a future host wants one, it comes back as a settings-backed option with a real configurator instead of a dormant parameter. Until then, unbounded growth is still bounded by idle eviction and by the EMFILE retry path.

**Verifier corrections to the evidence above**

Three corrections. (1) The claim that all six maxSessions test cases "pin retired behavior" is false. `:296` ("stops an idle workspace before opening another", maxSessions: 2, idleTimeoutMs: 1_000, injected clock) and `:639` ("treats project commands as session activity", maxSessions: 2) both run with only two projects, so the `while (sessions.size >= maxSessions)` loop at `:343` never fires — `evictIdleSessions()` has already dropped the stale session before the check. Those two pin idle-eviction and lastUsedAt-refresh semantics that remain in production; the correct edit is to drop the one `maxSessions:` line from each and keep the test. (2) `:471` ("does not release a replacement session from a project command that never acquired it") is a lease/double-release regression test, plausibly from the #10804/#10350 line of bugs, that merely uses maxSessions:1 to construct the race; deleting it outright loses coverage of a live invariant — it should be retargeted onto idleTimeoutMs rather than deleted. Only `:255`, `:344`, and `:389` are genuinely capacity-only and deletable. (3) Missing supporting evidence, in the claim's favor: `config/ratchets/knip-baseline.json:2342` and `:2354` already list `createDirectLspLeanAdapter` and `DirectLspLeanAdapterOptions` as production-dead, and the only non-test consumer chain is `src/platform/defaults/nodeAgentRuntime.ts:34`; the claim's grep also missed `src/test-kernel/cli/CliInitPlatform.vitest.ts:182` (a mock, not a configurator).

<details><summary>Verifier reasoning</summary>

I re-ran every search independently and the production claim holds. `maxSessions` exists only in `src/tools/lean/direct/directLspAdapter.ts:70,100-101,342-343` and in six test call sites in `src/test-kernel/tools/lean/DirectLspAdapter.vitest.ts` (255, 296, 344, 389, 471, 639); a repo-wide grep excluding node_modules/.git returns nothing else outside built `dist/` bundles. The sole production construction path is `src/platform/defaults/nodeAgentRuntime.ts:34` → `registerDirectLeanLanguageServices(lifecycle)` → `createDirectLspLeanAdapter()` at `directLspAdapter.ts:86` with no argument (the only other reference is a `vi.fn()` mock in `src/test-kernel/cli/CliInitPlatform.vitest.ts:182`). No `texra.lean.*` setting exists in `src/shared/schemas/coreSettings.ts` or `stateSettings.ts` (neither file has any Lean key at all), no env var, no extension `package.json` contribution, no resources/ YAML. Independent corroboration I found that the claimant did not cite: `config/ratchets/knip-baseline.json:2342,2354` already classifies `createDirectLspLeanAdapter` and `DirectLspLeanAdapterOptions` as `production-dead` exports — the ratchet itself agrees there is no production configurator. With `maxSessions == null`, `evictForNewSession` (`:337-353`) returns at `:342` after `evictIdleSessions()`, so `lruRootExcept` (`:322-335`, only caller `:345`) and the `sessionFreedWaiters` set / `notifySessionFreed` (`:134-137`) / `waitForSessionFreed` (`:139-143`, only caller `:350`) are unreachable; the three notify calls at `:188`, `:254`, `:388` then have no listener. I checked each refutation angle and none lands: no docs ruling — `docs/guide/lean.md:32` documents exactly the two surviving mechanisms ("a server stops when the agent run that was using it ends, and an unused one stops after thirty minutes"), with no session cap, and there is no proposal/architecture/audit doc mentioning a Lean session cap; `git log --all --grep`/`-S"maxSessions"` returns exactly `68d6dc8b21` (#10248) and no later removal; `gh issue list` finds no filed duplicate (only #10283, CLOSED, about run-end ownership). It touches none of the settled surfaces (no ratchet edge, no @agent SDK surface, no PocketFlow engine, no host/platform composition change, no browser-safe utils, no AgentEvent/SessionFact split), and nothing here is a masking catch/fallback — the load-bearing protections against too many `lean --server` processes are the EMFILE/ENFILE path (`isFileTableExhausted` → `evictOthersForExhausted`, `:360-385`, called at `:444`) and the 30-minute idle timer, neither of which the deletion touches, plus the per-run owner/lease machinery from #10248/#10350 which is orthogonal. No CLI result-JSON contract involvement. Where the claim IS wrong is the test plan, and that changes the scope, not the verdict: two of the six "maxSessions-configured" cases configure it inertly and pin behavior that SURVIVES the deletion, so deleting them would remove live-path coverage rather than retired behavior.

</details>

#### Collapse the three single-caller delegation-availability wrappers into one annotator

- **Area**: `tools-delegation` · **Kind**: single-caller-wrapper · **Risk**: low
- **Net**: -110 LoC, -8 elements

**Evidence**

src/tools/delegation/delegationAvailability.ts:185-197 (withDelegationAgentAvailability), :262-272 (withDelegationModelAvailability), :299-311 (withDelegationWorktreeAvailability) are each a one-expression pass-through to replaceDelegationDescriptionBlock (:58-74) with a module-constant regex (:85, :203, :279) and a constant appendIfMissing. Production consumers, grepped across src + packages/*/src: exactly ONE site for all three — src/agent/runtime/agentToolResolution.ts:39-41 (imports) and :187, :192-196 (annotateDelegationTool), which itself has one caller (:162-165 inside resolveAgentTools). visibleDelegationAgentsBlock (:141) likewise has exactly one production consumer (agentToolResolution.ts:194). replaceDelegationDescriptionBlock has ZERO production consumers outside its own file and is already carried as a grandfathered dead export in config/ratchets/knip-baseline.json:2242-2247 ("production-dead", kind "exports"). Non-production consumers: 4 test files — src/test-kernel/tools/DelegationAgentAvailability.vitest.ts (371 LoC), DelegationWorktreeAvailability.vitest.ts (168), DelegationModelAvailability.vitest.ts (118), DelegationDescriptionBlock.vitest.ts (79) — for one 311-LoC module (R7: one suite per module). DelegationAgentAvailability.vitest.ts:5-32 and DelegationWorktreeAvailability.vitest.ts:5-34 duplicate the same 20-line vi.hoisted/vi.mock block verbatim, comment included, and each redefines its own DELEGATE_AGENT_DESCRIPTION literal. Ambiguous consumers: none (no scripts/ hits). Fix spans one file outside the area: src/agent/runtime/agentToolResolution.ts.

**Proposal**

Delete withDelegationAgentAvailability, withDelegationModelAvailability, withDelegationWorktreeAvailability and agentToolResolution.ts's annotateDelegationTool. Replace them with one exported annotateDelegationAvailability(tool, availableModelNames) in delegationAvailability.ts that reads tool.availabilityCategory itself, keeps the existing early guards (no category / no description / undefined model list), and applies the three block replacements in the current order using the file-local regexes. Drop the export keyword on replaceDelegationDescriptionBlock (removing its row from config/ratchets/knip-baseline.json) and on visibleDelegationAgentsBlock; availableModelNamesFromOptions stays exported (proposalFlow.ts:31 also uses it). Fold DelegationDescriptionBlock/DelegationModelAvailability/DelegationWorktreeAvailability suites into DelegationAgentAvailability.vitest.ts, which already drives the real resolveAgentTools path, and share the one mock header.

**What we give up**

The ability to apply the agents, models, or worktree annotation independently of the other two — nothing in production or the CLI/desktop/extension hosts does. Direct unit coverage of replaceDelegationDescriptionBlock's regex/thunk mechanics in isolation; those cases keep their assertions but run through the annotator instead of the raw helper.

**Verifier corrections to the evidence above**

Three corrections, none fatal.

1. The two mock headers are near-duplicate, not "verbatim, comment included". `DelegationWorktreeAvailability.vitest.ts:5-27` additionally mocks `isWorktreeSupportEnabled` and adds a whole `vi.mock('@utils/config/worktreeConfig')` block; only the `agentRegistry` + `computeModelOptions` portion (~13 lines, including the shared scope comment) is identical to `DelegationAgentAvailability.vitest.ts:5-22`. The two `DELEGATE_AGENT_DESCRIPTION` literals also differ (the worktree one carries an "Available models:" line and a `Git worktree support:` placeholder), so the fold needs one superset fixture, not a straight de-duplication — and merging pulls the worktree mock over the agent suite, which today exercises the real `isWorktreeSupportEnabled`.

2. The proposal says "Fix spans one file outside the area". It actually spans `src/agent/runtime/agentToolResolution.ts`, `config/ratchets/knip-baseline.json` (delete the `replaceDelegationDescriptionBlock` row), and four test files. Also note the ordering constraint the write-up leaves implicit: `DelegationAgentAvailability.vitest.ts:26` currently imports `visibleDelegationAgentsBlock`, so its export cannot be dropped until that suite stops importing it — the test fold is a prerequisite of the de-export, not an optional extra.

3. The module is covered by 4 suites, but `src/test-kernel/tools/` holds 7 `Delegation*.vitest.ts` files (adding `DelegationAgentScope` 93, `DelegationTools` 216, `DelegationHeadless` 1497); the other three cover different modules and are out of scope for the R7 fold.

<details><summary>Verifier reasoning</summary>

I tried to refute this and could not. Every load-bearing fact checks out against head.

Consumers (my own repo-wide grep, excluding node_modules/dist and the stale bundled `packages/cli/.texra-validate-run/bin/texra.js`): `withDelegationAgentAvailability`, `withDelegationModelAvailability`, `withDelegationWorktreeAvailability` have exactly one production call site each, all inside `src/agent/runtime/agentToolResolution.ts:178-197` (`annotateDelegationTool`), whose only caller is `resolveAgentTools` at `:163`. `visibleDelegationAgentsBlock` (`src/tools/delegation/delegationAvailability.ts:141`) has one production consumer, `agentToolResolution.ts:194`. `replaceDelegationDescriptionBlock` (`:58`) has zero production consumers outside its own file and is already carried as a grandfathered `production-dead` export at `config/ratchets/knip-baseline.json:2242-2247`. Nothing in `packages/extension/package.json`, `commands.ts`, `coreSettings.ts`/`stateSettings.ts`, `packages/extension/resources/`, `prompts/`, `supabase/functions/`, or `scripts/` references any of these names — they are internal function symbols, not command IDs, config keys, or wire strings. `formatAgentList`/`getDelegationAgents` do have a second production consumer (`src/agent/prompt/userVars.ts:24-27`), and `availableModelNamesFromOptions` a second one (`src/tools/delegation/proposalFlow.ts:31`); the proposal already keeps both exported.

Already done / already filed: no. `git log -S"withDelegationWorktreeAvailability"` shows only #6664 (introduction) and #9943; `git log --all --grep` for the symbols returns nothing. The most recent sweep over these paths, `b0bfa1f41e` ("sweep the cold surface", Round 3, whose stated categories are literally "dead exports" and "pass-through inlining"), touched `agentToolResolution.ts` only to de-export `ResolveAgentToolsInput` and did not touch `delegationAvailability.ts` at all — so the wrappers survived by omission, not by a considered ruling. `gh issue list` for delegationAvailability / withDelegationAgentAvailability / "delegation annotator" returns nothing on point (#11172, #10855, #11293 are unrelated).

Deliberate-design check: `docs/proposals/2026-08-14-delegation-flow-substrate-consolidation.md:126-136` forbids removing the `src/agent/runtime` -> `@tools/delegation` availability edge and forbids requiring `architecture-edges` to shrink. This proposal preserves that edge (one import instead of five) and does not touch the ratchet, so the ruling does not bite. The only counter-evidence is the module header at `delegationAvailability.ts:19-25` ("Each annotation owns its anchor pattern and copy; they share one injection contract") — a design statement, but an undated in-file comment, not a ruling, and it is the exact shape §13/R5 bans ("Single-caller extractions remain banned").

Settled surfaces: untouched. Not the `@agent/*` SDK surface (no `packages/agent/src` reference to this module), not `src/agent/node/index.ts`, not a host/platform root, not a browser-reachable `@utils` module, not the AgentEvent/SessionFact split, and the only ratchet involved shrinks by one row. §15: no catch/fallback is deleted — the `try/catch` at `agentToolResolution.ts:84-95` (an L4/L3 loud best-effort with `log.warn`) and the `null`-vs-`undefined` model-names distinction both survive in the merged guard. Nothing goes near the CLI result-JSON contract.

R5/R6: this genuinely reduces elements rather than relocating them — four module-level functions (three wrappers plus `annotateDelegationTool`) collapse to one, and two exports are removed while one is added. The relocation of `annotateDelegationTool` into `@tools/delegation` introduces no new import direction (`delegationAvailability.ts` already imports `@agent/index/agentRegistry` and `@agent/runtime/RunContext`).

</details>

#### Delete the external-inquiry execution mirror: nothing has read it since #11050

- **Area**: `tools-session` · **Kind**: dead-export · **Risk**: low
- **Net**: -62 LoC, -4 elements

**Evidence**

`ensureExternalInquiryThreadMirror` (src/tools/inquiry/externalInquiryStorage.ts:242-250) recursively copies a thread's whole global-storage directory into `runs/<executionId>/ei/<threadId>` via `copyGlobalDirectoryToExecution` (src/tools/inquiry/externalInquiryStorage.ts:219-240, plus `const EXEC_DIR = 'ei'` at :35). It runs on every ask and every read: src/tools/inquiry/ExternalInquiryTool.ts:157-169 (`mirrorThreadBestEffort`) called at :321 and :408.

Production readers of the mirrored location: 0. `rg -n "ensureExternalInquiryThreadMirror|mirrorThreadBestEffort|/ei/" src packages --glob '!*.vitest.ts'` returns only the writer and its own two call sites; the only other hit for `ei` is the unrelated `EXTERNAL_INQUIRY_THREADS_DIR = 'ei_threads'` (src/common/storage/storageLayout.ts:21). Non-production consumers: 1 (`ensureExternalInquiryThreadMirror: vi.fn()` mock at src/test-kernel/tools/ExternalInquiryAction.vitest.ts:11).

The mirror is not even discoverable: `listRunGeneratedFiles` scans `RUN_FILE_SCAN_DEPTH = 2` (src/tools/executions/runGeneratedFiles.ts:36,55), so `/executions/{id}/files` shows the `ei` and `ei/<threadId>` directories but never the `manifest.json` inside them, and `EXECUTION_PATH_CATALOG` (src/tools/executions/pathCatalog.ts:7-58) documents no inquiry path. The one mechanism that ever handed the agent the mirrored paths — `executionMirrorPaths` / `ExternalInquiryExecutionMirrorPaths` — was deleted as unreachable by #11050 (commit 84383d5884), whose body says "Thread mirroring itself is untouched"; that is the tail this closes. Meanwhile the documented way to reach the same data is first-class: `inquiry(command:'read')` "Read the full untruncated transcript of one inquiry thread" (src/tools/inquiry/ExternalInquiryTool.ts:103-113), reading the canonical manifest at src/tools/inquiry/externalInquiryStorage.ts:563.

**Proposal**

Delete `ensureExternalInquiryThreadMirror` and `copyGlobalDirectoryToExecution` (externalInquiryStorage.ts:215-250) and `EXEC_DIR` (:35); drop the now-unused `RUNS_STORAGE_DIR` import (:8), `StorageFS` from the pair import (:31), and `isFile` from the fsEntryType import (:32 — `isDirectory` is still used at :601). Delete `mirrorThreadBestEffort` (ExternalInquiryTool.ts:152-169), its two call sites (:321, :408), and the `executionId` parameter threaded into `executeRead` solely to feed :408. Remove the `vi.fn()` mock line in src/test-kernel/tools/ExternalInquiryAction.vitest.ts:11. Replacement: none needed — `inquiry(command:'read')` already serves the full transcript.

**What we give up**

The undocumented ability for an agent that guesses the path to read raw mirrored inquiry files through `/executions/{id}/files/ei/<threadId>/manifest.json`, and the per-run archival snapshot of a thread inside the run directory (the canonical thread under `ei_threads/` is untouched and survives the run). Runs that used inquiry stop showing stray `ei` entries in `/executions/{id}/files`.

**Verifier corrections to the evidence above**

"Production readers of the mirrored location: 0" is right about named readers but overstates unreachability. The mirrored bytes ARE generically reachable: ExecutionsTool.readFile (src/tools/ExecutionsTool.ts:802-819) resolves any relative path under the run dir via findExistingRunStoragePath, so `/executions/{id}/files/ei/<threadId>/manifest.json` would be read if an agent guessed the filename. Also, walkRunStorage at RUN_FILE_SCAN_DEPTH=2 (src/tools/executions/runGeneratedFiles.ts:58-117) pushes directory entries too, so `ei` and `ei/<threadId>` currently DO appear as rows in `/executions/{id}/files` and in the CLI history detail file list (packages/cli/src/runtime/history.ts:186, mergeHistoryFiles). Deleting the mirror therefore removes two undocumented directory rows from those listings and an unadvertised read affordance - a real if trivial behavior change the issue should state, not a consumer. Nothing in the path catalog, prompts/, or agent YAMLs ever directs anyone to `files/ei/...`, and #11050 removed the only mechanism that ever handed those paths to the agent. Second correction: the claim's "#11050 explicitly left it in place" framing should not be read as a deliberate keep - the commit body is a scope disclaimer. Third: the mirror also costs a full recursive global-to-run directory copy on every ask and every read, so deletion is a small I/O win as well as a LoC win.

<details><summary>Verifier reasoning</summary>

Survives. I re-ran the greps myself: `ensureExternalInquiryThreadMirror` exists only as its definition (src/tools/inquiry/externalInquiryStorage.ts:242-250), its private helper `copyGlobalDirectoryToExecution` (:219-240), `EXEC_DIR = 'ei'` (:35), the two call sites via `mirrorThreadBestEffort` (src/tools/inquiry/ExternalInquiryTool.ts:157-169, called at :321 and :408), and one `vi.fn()` mock (src/test-kernel/tools/ExternalInquiryAction.vitest.ts:11). No prompt, YAML, command, setting, schema, or edge function references the mirrored location: `EXECUTION_PATH_CATALOG` (src/tools/executions/pathCatalog.ts:7-58) lists no inquiry path, prompts/agents/**/_.yaml mention only /executions/{id}/files/diffs and compile/_.log, and packages/extension/resources/tool_use_agents/assistant.yaml mentions `inquiry` only as a tool name. The contrast case proves the pattern: a run subdir with a real reader has a named consumer (src/tools/delegation/subagentResults.ts:462 joins runDir with 'diffs'); `ei` has none. Not already done (git log -15 -- src/tools/inquiry; the mirror is still on HEAD). Not already filed (gh issue searches for "inquiry mirror" and the symbol return only unrelated rows). Not deliberately justified: 84383d5884 (#11050)'s "Thread mirroring itself is untouched" is a scope note, not a ruling, and docs/proposals/2026-08-07-prod-structural-leads-triage.md:449-451 triages a different externalInquiryStorage item (listOpenThreads). Touches no settled surface (no ratchet, no @agent/* edge, no PocketFlow engine, no browser-safe utils, no AgentEvent/SessionFact split, no CLI result-JSON contract). Section 15 does not save it: `mirrorThreadBestEffort`'s catch is a loud warn, and the proposal deletes the whole operation rather than silencing a failure, so no masking site is being created. Section 14 R5/R6: this is pure element removal (two functions, one constant, one param, three imports, one mock line) with no relocation, no new helper, and no unrelated churn; the only ripple is dropping the `executionId` param from `executeRead` while `execute()` keeps it for the ask path (:309 parentExecutionId), which is one-line mechanical.

</details>

#### Delete the inline-comment runtime availability sentinel now that `hosts:` owns the same fact

- **Area**: `tools-document` · **Kind**: dual-representation · **Risk**: low
- **Net**: -55 LoC, -4 elements

**Evidence**

`InlineCommentTool` carries TWO mechanisms for "this tool only works in the VS Code extension host".

(a) Static, enforced: `src/tools/comment/InlineCommentTool.ts:137-139` declares `hosts: { cli: {available:false}, desktop: {available:false} }`. That is read by 7 production sites — `src/tools/registry.ts:185,194`, `packages/cli/src/runtime/runExecution.ts:471`, `packages/cli/src/chat/chatSessionController.ts:352,444`, `packages/cli/src/runtime/tools.ts:40`, `packages/desktop/src/main/desktopAgentLaunch.ts:38`, `packages/desktop/src/main/desktopAgentResume.ts:83`, `src/controllers/settingsView/ToolDashboardData.ts:168` — and lands as `runtimeUnavailableTools` in `src/agent/implementations/flows/tooluse/runToolUseFlow.ts:187`, where `resolveAgentTools` drops the tool from the roster entirely. On CLI/desktop the tool is never instantiated.

(b) Runtime, unreachable: `InlineCommentProvider.available()` (`:50`), the `UNAVAILABLE` sentinel object (`:64-70`), `let provider = UNAVAILABLE` (`:72`), and the early return at `:146-151`. The only production implementation is `packages/extension/src/frontend/comments/inlineComments.ts:97` `available: () => controller !== undefined`; `controller` is created unconditionally in `enable()` (`:147-151`), called once from `registerInlineComments` at activation, and `packages/extension/src/extension.ts:632-633` calls `registerInlineComments(context)` then `setInlineCommentProvider(...)` on the next line. So `available()` is `true` for the entire life of the only host that can reach the tool.

Provenance: `git show b4bf6418eb` (#10806, 2026-08-17) added the `hosts:` block and left path (b) in place — §13 "build implies delete in the same PR" residue, with no #6981 ledger row.

Consumer counts for `provider.available()`: production 1 (`InlineCommentTool.ts:146`), non-production 2 (`src/test-kernel/tools/InlineCommentTool.vitest.ts:15,68`).

Separately, `InlineCommentInputSchema` is exported at `:78` with production consumers outside its own file = 0, non-production = 1 file (`InlineCommentTool.vitest.ts:4,29,38,47,55`), and it is grandfathered in `config/ratchets/knip-baseline.json:2236-2241`. That test block (`InlineCommentTool.vitest.ts:26-61`) asserts only `strictObject` rejection, `min(1)` on body and `min(1)` on line — exactly what the Zod schema guarantees, which AGENTS.md "Testing discipline" says not to test.

**Proposal**

1. Delete `available()` from `InlineCommentProvider` (`:50`), delete the `UNAVAILABLE` const (`:64-70`), change `let provider` to `InlineCommentProvider | undefined`, and replace the `:146-151` early return with a `requireProvider()` that throws the way `getLeanLanguageServices()` (`src/tools/lean/leanLanguageServices.ts:80-90`) does — a host that reached the tool without wiring the provider is a startup bug, not a user-facing state. Drop `available` from the extension impl (`inlineComments.ts:97`) — outside my paths, one line.
2. Delete the `describe('InlineCommentInputSchema')` block (`InlineCommentTool.vitest.ts:26-61`) and the `available: () => false` case (`:66-71`), then un-export the schema (keep it a module-local const used by `defineTool` and `z.infer`) and remove its row from `config/ratchets/knip-baseline.json:2236-2241`.
3. Optional tightening in the same PR: `add()` can then return a non-null `{threadId, resolvedPath}`, removing the `if (!result) throw` at `:184-186`.

**What we give up**

The graceful "Inline comments require the VS Code extension host" tool result, which today no production configuration can produce. If the roster gate is ever bypassed (an embedder handing `inline_comment` in by value on CLI), the failure becomes a thrown ToolError naming the missing registration instead of a soft executed result. Also loses four schema assertions that duplicate Zod's own guarantees.

**Verifier corrections to the evidence above**

Five corrections to the original evidence:

1. WRONG: "On CLI/desktop the tool is never instantiated." It is instantiated on every host — `src/tools/registry.ts:97` `inline_comment: new InlineCommentTool()` inside `createDefaultTools()`. The `hosts:` block filters it out of the resolved agent roster (`agentToolResolution.ts:116,122`), not out of construction. `execute()` is what is unreachable, not the constructor.

2. INCOMPLETE: the `hosts:` fence is not automatic — it is opt-in at each launch site, which must pass `getDefaultUnavailableToolNames(host)`. I verified all four cli/desktop sites plus inheritance through `subagentExecution.ts:168,213` and `workflowScriptAgentRunner.ts:317`. The extension's three launch sites pass nothing, which is correct only because `getDefaultUnavailableToolNames('extension')` is `[]`. A future host launch site that forgets the call would re-expose the tool; with the proposal it fails loudly with a ToolError instead of a quiet no-op, which is the better failure and matches the four siblings.

3. OVERSTATED: "controller is created unconditionally in enable()... so available() is true for the entire life of the only host." `packages/extension/src/extension.ts` has two early-return activation paths before line 632 — `:234` (no workspace folder, or multi-root) and `:240` (unresolvable workspace root) — on which `setInlineCommentProvider` is never called. Those paths register only the welcome view and two standalone commands, so no agent can run and the tool is still unreachable. The conclusion holds; the stated reason does not.

4. STEP 3 IS NOT FREE. `inlineComments.ts:99` `add: ({...}) => { if (!controller) return null; ... }` — that null branch guards `controller === undefined`, which is reachable after `disable()` at deactivation, and is independent of whether `provider` was set. Making `add()` non-null forces that branch to throw. Drop step 3, or state that the extension impl throws there.

5. `src/tools/comment/InlineCommentTool.ts:39-45` (the `InlineCommentProvider` doc block) explicitly documents the sentinel behavior — "Absent on hosts without one (CLI / headless), where `available()` is false and the tool reports the no-op back to the agent." That doc is now stale and must be rewritten in the same PR; the original evidence did not mention it.

Also worth naming in the issue: the behavior delta on the (unreachable) path is `{status:'executed', summary:'Inline comments unavailable'}` becoming `{status:'error'}`, and `src/test-kernel/frontend/InlineComments.vitest.ts:59` calls `getInlineCommentProvider()` but never touches `available`, so it needs no change.

<details><summary>Verifier reasoning</summary>

The core claim holds, but for partly different reasons than stated.

CONFIRMED — the runtime sentinel has exactly one production consumer and it is always true:

- `src/tools/comment/InlineCommentTool.ts:64-70` (`UNAVAILABLE`), `:72` (`let provider = UNAVAILABLE`), `:48-51` (`available(): boolean` on the interface), `:146-151` (early return). Only production reader of `available()` is `:146`.
- Only production implementation: `packages/extension/src/frontend/comments/inlineComments.ts:97` `available: () => controller !== undefined`; `controller` is set unconditionally in `enable()` (`:145-151`) and cleared only by `disable()`, which is pushed as a `context.subscriptions` disposable (`:191`) i.e. deactivation.
- `packages/extension/src/extension.ts:632-633` calls `registerInlineComments(context)` then `setInlineCommentProvider(getInlineCommentProvider())`.

CONFIRMED — the static fence covers every production launch site:

- `ToolHost = 'cli' | 'desktop' | 'extension'` (`src/agent/core/tools/ToolTypes.ts:8`) — only three hosts.
- `getDefaultUnavailableToolNames` is passed at `packages/cli/src/chat/chatSessionController.ts:352,444`, `packages/cli/src/runtime/runExecution.ts:471`, `packages/desktop/src/main/desktopAgentLaunch.ts:38`, `desktopAgentResume.ts:81`. Subagents/workflow-script children inherit it (`src/tools/delegation/subagentExecution.ts:168,213`, `workflowScriptAgentRunner.ts:317`). The three extension launch sites (`AgentReviewService.ts:315`, `setupAssistantCommand.ts:248`, `commands/agent/executeCommand.ts:55`) pass nothing, which is correct: `getDefaultUnavailableToolNames('extension')` is `[]` (pinned at `src/test-kernel/tools/ToolRegistryAliases.vitest.ts:26`).
- `resolveAgentTools` drops it at `src/agent/runtime/agentToolResolution.ts:116,122` for both declared and injected tools. `inline_comment` is declared only by `packages/extension/resources/tool_use_agents/assistant.yaml:25` — no other YAML, prompt, or config references it. No alias maps to it.
- No embedder path: `packages/agent/src/index.ts` does not export `InlineCommentTool`, `setInlineCommentProvider`, or `getDefaultUnavailableToolNames`, and the SDK is unpublished with no named external consumer.

CONFIRMED — the proposed target shape is an existing repo pattern, not an invention:

- `src/tools/lean/leanLanguageServices.ts:72-93` is the exact shape (`let services: T | undefined` + `setX` + throwing accessor whose doc says a host that missed the wiring must fail loudly).
- All four sibling host-fenced tools already throw on a missing capability instead of returning `executed(...)`: `InvokeCommandTool.ts:78-82`, `SendToTerminalTool.ts:62-66`, `DiagnosticsTool.ts:111-116,161-166`. `InlineCommentTool` is the only one carrying a null-object sentinel, so this converges rather than diverges.
- Checklist §15 lists `delete-the-guard (let it crash to an existing L1/L4 boundary)` in the cleaner-solutions menu, and the sentinel is M6-shaped (defensive wrapper around a state that cannot occur). It is not a load-bearing fallback: `ToolError` is caught by the tool `call` boundary and returned as `{status:'error'}`, so the agent still gets a message.

CONFIRMED — the schema un-export:

- `InlineCommentInputSchema` has 0 production consumers outside its own file; baselined at `config/ratchets/knip-baseline.json:2236-2241`. Convention is module-local: 49 `const *InputSchema` vs 4 `export const *InputSchema` in `src/tools/`, and 2 of the 4 exports are knip-baselined dead. Removing a baseline row shrinks a ratchet, which the "never widen a baseline" invariant permits.
- `AGENTS.md:194` states verbatim: "Do not test what `npm run typecheck` or a Zod schema already guarantees" — the `describe('InlineCommentInputSchema')` block at `src/test-kernel/tools/InlineCommentTool.vitest.ts:26-61` tests exactly that.

NOT already done, NOT already filed, NOT deliberately ruled:

- `git log -- src/tools/comment/ packages/extension/src/frontend/comments/`: last functional touch is `b4bf6418eb` (#10806), which added `hosts:` and left the sentinel. Everything since is logger/rename sweeps.
- `gh issue list --state all --search "InlineComment"` → only #9053; `--label tech-debt --search "inline comment"` → #9042. Both are the unbounded thread `Map`, both CLOSED. No duplicate.
- `docs/proposals/2026-07-09-host-parity-audit.md:495` item 23 only rules that `inline_comment` is intentionally extension-only. It predates `hosts:` (#10806, 2026-08-17) and says nothing about the runtime sentinel, so it is not a ruling this claim must beat.
- Touches none of the settled surfaces: no `@agent/*` specifier, no ratchet widened, no PocketFlow engine, no platform composition root, no browser-safe `@utils` module, no AgentEvent/SessionFact change, no CLI result-JSON contract (so risk stays low, not high).

Bounded deletion in two files plus one test file and one baseline row. Record as an issue.

</details>

#### Fold wolframScriptUtils into WolframTool and drop the ExecResult mirror type

- **Area**: `tools-external` · **Kind**: single-caller-wrapper · **Risk**: low
- **Net**: -45 LoC, -4 elements

**Evidence**

`src/tools/wolfram/wolframScriptUtils.ts` (63 LoC) has exactly ONE production consumer: `src/tools/wolfram/WolframTool.ts:19-22` imports `WOLFRAM_CODE_TIMEOUT_MS` and `executeWolframCode`. Grepped `rg -n "wolframScriptUtils|executeWolframCode|WOLFRAM_CODE_TIMEOUT_MS|WolframScriptResult"` across the workspace: production hits = 1 file (WolframTool.ts, lines 20/21/71/72); non-production = `src/test-kernel/tools/Wolfram.vitest.ts:16,51,94,149-172` and two docs/proposals mentions; ambiguous = none. Two concrete redundancies inside it: (1) `WolframScriptResult` (`wolframScriptUtils.ts:14-20`) is a field-renamed mirror of the existing `ExecResult` (`src/shared/schemas/opResults.ts:7-28`) — `output`↔`stdout`, `error`↔`stderr`, plus gratuitous nullability; `executeWolframCode:47-58` does nothing but re-key the object. (2) The `try/catch` at `wolframScriptUtils.ts:45-62` and its `wolframFailure` factory (`:22-30`) guard a callee that cannot throw: `executeCommand` catches everything and returns an `ExecResult` (`src/utils/system/execUtils.ts:115-134` `resultFromExecutionError` → `exitCode 127`, `stderr` = message; the only `throw` on that path, `execUtils.ts:301-307`, is a mode/array-form programmer error unreachable from the fixed `['wolframscript','-code',code]` call). An earlier lead on this same file (docs/proposals/2026-08-07-prod-structural-leads-triage.md:260) was executed — `executeWolframScriptFile` is already gone — but the wrapper itself was left standing.

**Proposal**

Delete `src/tools/wolfram/wolframScriptUtils.ts`. Move `WOLFRAM_CODE_TIMEOUT_MS` and the not-installed message into `WolframTool.ts` as file-local consts; call `executeCommand(['wolframscript','-code',input.code], {truncate:false, timeout, channel:'WolframTool'})` directly in `execute()` after the `checkToolInstalled` guard, and read `result.stdout`/`result.stderr` instead of `result.output`/`result.error`. Drop `WolframScriptResult` and `wolframFailure` entirely — the not-installed case becomes an early `throw new ToolError(...)`, which is what the tool already does with every other failure (`WolframTool.ts:93`). Tests: `Wolfram.vitest.ts:51,94` re-point their `vi.spyOn` from `wolframScriptUtils.executeWolframCode` to `execUtils.executeCommand` — the mechanical shape is already demonstrated by the existing case at `Wolfram.vitest.ts:154-172`; the `describe('wolframScriptUtils')` block folds into the WolframTool suite.

**What we give up**

The module boundary that made `executeWolframCode` independently mockable; tests mock one level lower (`executeCommand`), which is slightly more coupled to execa's result shape. Also gives up the (currently unused) option of a second wolframscript entry point without re-extracting a helper.

**Verifier corrections to the evidence above**

Corrections and additions to the original evidence:

1. Incomplete, not wrong: the claim proves `executeCommand` cannot throw but omits `checkToolInstalled`, the other awaited call inside the same try. It also cannot throw — `src/utils/system/toolUtils.ts` `checkToolInstalled` wraps its body in try/catch and returns `false` on error. Both callees being total is what makes wolframScriptUtils.ts:60-62 dead.
2. `executeCommand`'s catch is at `src/utils/system/execUtils.ts:506-507` (`return logExecutionErrorAndBuildResult(err, options)`), covering the whole body including the internal `throw new Error('No workspace path found')` at :321; `resultFromExecutionError` is at :115-134 and the mode-mismatch throw at :302 as claimed.
3. The re-key block is wolframScriptUtils.ts:51-58 (lines 46-50 are the `executeCommand` call), not 47-58.
4. Sharper mirror evidence: `ExecResult.exitCode` is `z.int()` (non-nullable) and stdout/stderr are non-nullable `z.string()`, so the mirror's nullability is what creates the dead `result.exitCode !== null` guard at `WolframTool.ts:86` and the `result.output ?? ''` at :76 — deleting it removes branches, not just a type alias.
5. Missing from the proposal: `runToolWithCheck` (`src/utils/system/toolUtils.ts`) already implements check+exec and returns `ExecResult | false`, with four existing callers in src/latex/. Prefer it over re-inlining the two-step guard in WolframTool.execute().
6. knip-baseline.json's only wolfram entries are WolframTool.ts's `wolframApprovalCommand`/`wolframRunSummary` (lines 2387-2396); the deletion requires no ratchet edit.

<details><summary>Verifier reasoning</summary>

I re-verified every leg independently and could not refute it.

CONSUMERS: `rg -n "wolframScriptUtils|executeWolframCode|WOLFRAM_CODE_TIMEOUT_MS|WolframScriptResult|wolframFailure"` repo-wide (excluding node_modules) returns exactly: `src/tools/wolfram/WolframTool.ts:20-22,71,72` (prod), `src/test-kernel/tools/Wolfram.vitest.ts:16,51,94,149,154,166` (test), and two docs/proposals mentions. A widened `rg -l -i wolfram` over the whole workspace lists every wolfram-touching file: `src/tools/registry.ts`, `src/tools/externalToolDefs.ts`, `src/shared/constants/latexToolchain.ts`, `src/utils/system/toolUtils.ts` (the `wolframscript` TOOL_CONFIGS entry), `packages/extension/src/progressView/frontend/formatters/constants.ts`, seven `packages/extension/resources/tool_use_agents/*.yaml`, `prompts/agents/remote/*.yaml`, CHANGELOG, four test files — none of them import this module; they all reference the tool _name_ `wolfram`, not the utils module. No hit in packages/cli, packages/desktop, packages/agent, supabase/functions, or extension package.json contributions. Single production consumer confirmed.

DEAD TRY/CATCH: confirmed stronger than claimed. `executeCommand`'s entire body from the workspace-path lookup onward is inside one `try { … } catch (err) { return logExecutionErrorAndBuildResult(err, options); }` (`src/utils/system/execUtils.ts:311-507`), which always returns an `ExecResult` — including the internal `throw new Error('No workspace path found')` at :321. The only throw outside that try is the mode/form mismatch at :302, unreachable from the literal `['wolframscript','-code',code]` array with the default `mode: 'process'`. The claim omitted the other half: `checkToolInstalled` also cannot throw — it wraps its own body in try/catch and returns `false` (`src/utils/system/toolUtils.ts` catch → `log.warn` + `return false`). So both awaited calls are total; the `try/catch` at wolframScriptUtils.ts:45-62 is unreachable, not a load-bearing fallback. Section-15 taxonomy does not apply: nothing is being masked, and the not-installed path stays loud (it becomes an explicit `ToolError` instead of a synthetic failure record).

MIRROR TYPE: confirmed. `ExecResult` (`src/shared/schemas/opResults.ts:7-28`) is `{success, stdout, stderr, timedOut, exitCode: z.int(), outputLimitExceeded?}`; `WolframScriptResult` re-keys stdout→output, stderr→error and _widens_ them to nullable plus `exitCode: number | null`, forcing the dead `result.exitCode !== null` guard at `WolframTool.ts:86` and `result.output ?? ''` at :76. Deleting the mirror removes two null branches, not just a type.

ALREADY DONE / FILED / RULED: `git log --oneline -25 -- src/tools/wolfram/` shows #10801, #10286, #10118, #9942, #9909 etc. — none folded the wrapper; `executeWolframScriptFile`/`WOLFRAM_FILE_TIMEOUT_MS` are indeed already gone, so `docs/proposals/2026-08-07-prod-structural-leads-triage.md:260-262` is executed and scoped to those symbols only, not to `executeWolframCode`. `docs/proposals/2026-07-12-fallback-audit.md` has no wolfram entry; `docs/proposals/2026-08-01-directory-organization.md:644` rules only on `src/tools/wolfram/test/check.wl`. No AGENTS.md/CLAUDE.md/ratchet ruling protects the module. gh issue searches for wolfram / executeWolframCode / wolframScriptUtils-in-body return only unrelated issues (#10285, #9253, #9327, #8283). No settled surface is touched: not a ratchet, not `@agent/*`, not the PocketFlow engine, not a host/platform seam, not a browser-safe util, not AgentEvent/SessionFact, not the CLI result-JSON contract.

RATCHET SIDE-EFFECTS: `config/ratchets/knip-baseline.json` lists only `wolframApprovalCommand` and `wolframRunSummary` from WolframTool.ts (lines 2387-2396); no wolframScriptUtils entry, so deletion needs no baseline edit and cannot widen one.

ONE THING THE PROPOSAL MISSED (a smaller landing, not a refutation): `runToolWithCheck(toolName, args, options)` in `src/utils/system/toolUtils.ts` already _is_ `checkToolInstalled` + `executeCommand` returning `ExecResult | false`, and already honors `showError: false`. So the fold can be a single call — `runToolWithCheck('wolframscript', ['-code', input.code], { showError: false, truncate: false, timeout: effectiveTimeout, channel: 'WolframTool' })` — with `false` meaning not-installed, rather than re-inlining the two-step guard. Same deletion, slightly fewer added lines, and it reuses an existing owner (`src/latex/texcount.ts`, `texTools.ts`, `formatter/texfmt.ts`, `formatter/latexindentpt.ts` are its existing callers). The one deliberate detail to preserve either way: the wolfram-specific "Wolfram Engine, not Mathematica" message at wolframScriptUtils.ts:8-11 is richer than TOOL_CONFIGS' generic one, so keep it as the ToolError text.

Net effect is a real element reduction (one module, one exported interface, one factory, one dead catch, two null branches, one test describe block) with no relocation of complexity and no unrelated churn.

</details>

#### Make ToolCallContext.workPlanState required and delete the plan/todo no-session degraded branches

- **Area**: `tools-session` · **Kind**: defensive-machinery · **Risk**: low
- **Net**: -35 LoC, -2 elements

**Evidence**

`workPlanState?: WorkPlanState` is optional at src/agent/followUp/ToolFileInteractionContext.ts:38 ("Absent in contexts without work-plan support"), and two tools carry a whole degraded arm for that absence: src/tools/todo/TodoTool.ts:53-66 (warn + a hand-built `status:'executed'` literal with a `diagnostics.warning`) whose output is produced by `formatTodoList` (TodoTool.ts:83-101, the file's only use of `STATUS_DISPLAY`, `TODO_STATUS` and the `TodoItem` type imported at :16-21), and src/tools/plan/PlanTool.ts:135-147 (the same shape for `plan`).

No production context omits the field. `rg -n "withToolFileInteractionContext" src packages --glob '!*.vitest.ts'` → exactly one production caller, src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts:301-304, which always passes `workPlanState: options.workspace.workPlan`; that value is declared non-optional as `public readonly workPlan: WorkPlanState` (src/agent/core/state/AgentWorkspaceState.ts:337). Non-production callers: 1 (src/test-kernel/support/toolEnvironment.ts:24).

The tools are also unreachable from any other dispatch path. `rg -n "tool\.call\(" src packages --glob '!*.vitest.ts'` returns two sites: ToolUseDispatchNode.ts:323, and packages/extension/src/frontend/lm/registerLanguageModelTools.ts:83, whose registration set is `LM_TOOL_NAMES = { texra_arxiv_search, texra_web_fetch, texra_crossref_search }` (same file :27-31) — neither `todo_write` nor `plan`. So `context.workPlanState` is present whenever either tool runs, and the branches are dead in production while still rendering a full fake success result.

**Proposal**

Change `workPlanState?: WorkPlanState` to `workPlanState: WorkPlanState` in ToolCallContext (src/agent/followUp/ToolFileInteractionContext.ts:38 — outside my paths, one-line change; the sole production writer already satisfies it, and src/test-kernel/support/toolEnvironment.ts is the only other construction site). Then in TodoTool.ts replace :53-66 with a `throw new ToolError('todo_write must be called from within an agent tool-use turn.')` in the `!context` case, following the existing `requireInteractions` / `requireStreamId` convention in src/tools/contextHelpers.ts:26-49 (BaseTool.call catches ToolError centrally); delete `formatTodoList` (:83-101) and the now-unused `STATUS_DISPLAY`/`TODO_STATUS`/`TodoItem` imports and the module `logger`. Apply the same collapse to PlanTool.ts:135-147.

**What we give up**

A `todo_write` or `plan` call made with no active tool-call context now returns a tool error instead of a synthetic "Updated todo list (no active session)" success. That path has no production caller today, and the fake-success result was itself silent degradation (checklist §15 M1): it told the model the list was updated when nothing was persisted.

**Verifier corrections to the evidence above**

Two corrections. (1) "Non-production callers: 1" is wrong. `rg -n "withToolFileInteractionContext\("` over test code finds seven construction sites, none passing `workPlanState`: src/test-kernel/support/toolEnvironment.ts:24, src/test-kernel/tools/DelegationHeadless.vitest.ts:484 / :1238 / :1288 / :1318 (`{ tracker: {} as never, ... }`), src/test-kernel/tools/WorkflowScriptTool.vitest.ts:213, src/test-kernel/agent/followUp/HumanPromptProgressEvents.vitest.ts:67 (`{ tracker: {} as never }`), src/test-kernel/agent/followUp/AcceptRunFilesProgressEvents.vitest.ts:105 (`{ tracker }`). Requiring the field breaks typecheck in five files whose subject matter (delegation, workflow-script, human-prompt, accept-run-files) has nothing to do with work plans, and makes every context literal carry state it does not use. (2) The type change is not what deletes the branches: `getCurrentToolCallContext()` is `ToolCallContext | undefined` independently of the field, and registerLanguageModelTools.ts:83 really does call `tool.call` with no ALS frame at all, so a `!context` case remains reachable in the type system regardless. The correct, smaller change is to leave `workPlanState?: WorkPlanState` alone and replace the two degraded arms (TodoTool.ts:53-66, PlanTool.ts:135-147) with `throw new ToolError(...)`, deleting `formatTodoList` (TodoTool.ts:82-101), the module `logger`, and the now-unused `STATUS_DISPLAY` / `TODO_STATUS` / `TodoItem` imports. No dead-export cascade from that: `STATUS_DISPLAY` and `TODO_STATUS` keep consumers at src/tools/executionFormatters.ts:35,158-159 and packages/cli/src/chat/tui/panes/TodosPlanPanel.tsx / appLayout.ts:3. PlanTool's separate missing-streamId arm (PlanTool.ts:154-158) is a different question and stays.

<details><summary>Verifier reasoning</summary>

The core observation survives independent verification, but half the proposal (the type change) does not, and one evidence line is factually wrong.

Verified myself:

- `rg -n "\.call\(" src packages --glob '!*.vitest.ts'` gives exactly three hits, one of them unrelated (`src/common/errors/sdkError/errorInspection.ts:192` `maybeGet.call`). The two tool-dispatch sites are `src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts:323` and `packages/extension/src/frontend/lm/registerLanguageModelTools.ts:83`; the latter's `LM_TOOL_NAMES` set excludes `todo_write` and `plan`.
- The sole production context writer is `ToolUseDispatchNode.ts:301-310`, which always sets `workPlanState: options.workspace.workPlan`, and `AgentWorkspaceState` declares `public readonly workPlan: WorkPlanState` non-optionally (src/agent/core/state/AgentWorkspaceState.ts:330-349, plus `emptySnapshot`/`fromSnapshot` always parse a `workPlan`). No other dispatch surface exists: `registry.get(name)` outside dispatch is only `resolveToolDefinitions` (src/tools/registry.ts:258, definitions only) and the LM registration above.
- A repo-wide grep of `todo_write` finds only src/tools/registry.ts, agentCreatorFlow's tool list, agent YAMLs under prompts/ and packages/extension/resources/, and a progressView icon map — no alternate invoker, no wire/config/command surface.
- Nothing pins the degraded output: `no active session` / `formatTodoList` appear only at the two production sites (plus an unrelated line in docs/proposals/2026-08-23-single-owner-sessions.md:305).
- No dated ruling covers it: `rg -n "workPlanState" docs .claude config` → 0 hits; docs/proposals/2026-07-12-fallback-audit.md does not cover it; d066aa31f0's touch of ToolFileInteractionContext.ts only removed the `withToolEnvironment` test helper. `gh issue list --state all --search "todo_write OR workPlanState OR formatTodoList"` returns no open or closed duplicate (#3932 is plan/todo state consolidation, not this guard).
- It is not a load-bearing fallback under checklist §15: the arm returns a fabricated `status:'executed'` success with a `diagnostics.warning`, i.e. a masking site (defect to fix), and `ToolError` is already caught centrally at src/tools/core/base.ts:60-93, so the throw is the established convention (`requireInteractions`/`requireStreamId`, src/tools/contextHelpers.ts:26-49). No settled surface (ratchets, @agent SDK freeze, PocketFlow engine, hosts, browser-safe utils, AgentEvent/SessionFact) is touched.

What does not survive: making `workPlanState` required. `getCurrentToolCallContext()` returns `ToolCallContext | undefined` from the ALS store no matter what the field's optionality is, and the guard is `!context?.workPlanState` — so the type change deletes neither branch on its own; the deletion comes entirely from replacing the degraded return with a throw. Meanwhile it forces edits to five unrelated test files that construct contexts without a work plan. Record the branch deletion only, keep `workPlanState?:` optional.

</details>

#### Drop the never-written `toolchain` and never-read `pid` fields from the Lean server registry

- **Area**: `tools-document` · **Kind**: dead-export · **Risk**: low
- **Net**: -22 LoC, -6 elements

**Evidence**

`src/tools/lean/leanServerRegistry.ts` carries two fields that no production code round-trips.

`toolchain` is declared three times (`:31` on `LeanServerInfo`, `:53` on `RegisterLeanServerInit`, `:71` on `UpdateLeanServerPatch`), copied twice (`:64`, `:85`), and rendered at `:118-119`. Production writers: **0**. The only two producers in the repo are `src/tools/lean/direct/leanSession.ts:186-191` (`registerLeanServer({id, workspaceRoot, mode, status})` — no toolchain) and `packages/extension/src/frontend/lean/VscodeIntegration.ts:76,80,100`; neither ever passes it, and `updateLeanServer` is called at `leanSession.ts:202,219,267,296,298` with only `status`/`errorMessage`/`pid`. So `summarizeLeanServers` line 118 always computes an empty suffix. The single non-production consumer is the fixture at `src/test-kernel/tools/lean/LeanServerRegistry.vitest.ts:96-98` ("renders a running server with uptime and toolchain"), which manufactures a value no adapter can produce.

`pid` is declared three times (`:32`, `:54`, `:72`), copied twice (`:65`, `:86`), written once (`leanSession.ts:267`), and read **0** times in production — `summarizeLeanServers` (`:112-124`) never renders it, and the only registry readers, `src/tools/externalToolDefs.ts:453` (`listLeanServers().filter(isLeanServerActive).length`) and `:472` (`summarizeLeanServers()`), never touch it. The one non-production reader is `LeanServerRegistry.vitest.ts:43,46`, which asserts the setter stores what it was handed — trivial data plumbing per AGENTS.md "Testing discipline".

Note `src/test-kernel/tools/lean/DirectLspAdapter.vitest.ts:911,996` also declares a local `pid` on its own fixture type; that goes with the field.

**Proposal**

Delete `toolchain` and `pid` from `LeanServerInfo`, `RegisterLeanServerInit`, and `UpdateLeanServerPatch`; drop the two copy lines in `registerLeanServer` and the two `?? existing.*` merges in `updateLeanServer`; simplify `summarizeLeanServers`'s line to `• ${info.workspaceRoot} (${modeLabel})${statusTail(info, now)}`; delete `updateLeanServer(this.id, { pid: child.pid })` at `leanSession.ts:267`. Delete the `toolchain` fixture case and the `pid` assertion in `LeanServerRegistry.vitest.ts` and the fixture field in `DirectLspAdapter.vitest.ts`. If the Tools dashboard ever wants a PID or toolchain column, it comes back with a producer in the same PR.

**What we give up**

Nothing observable — neither field ever reaches a user surface today. A future "show the PID / toolchain in the Tools dashboard" feature would re-add the field alongside its renderer instead of inheriting a half-wired one.

**Verifier corrections to the evidence above**

One material correction: the claim's note that `src/test-kernel/tools/lean/DirectLspAdapter.vitest.ts:911,996` "declares a local `pid` on its own fixture type; that goes with the field" is WRONG. Those lines belong to `interface FakeLeanChild extends EventEmitter { ... pid: number | undefined; ... }` and `createFakeLeanChild`'s `Object.assign(events, {stdin, stdout, stderr, pid: 4242, killed, exitCode, signalCode, ...})` — a fake `ChildProcessWithoutNullStreams` used to mock `spawn`, unrelated to `LeanServerInfo`. It must be KEPT; deleting it would break the structural typing of the spawn mock. The proposal should touch only `src/tools/lean/leanServerRegistry.ts`, `src/tools/lean/direct/leanSession.ts:267`, and `src/test-kernel/tools/lean/LeanServerRegistry.vitest.ts` (drop `pid: 4242` from the update at :43, the `expect(after.pid)` assertion at :46, and the "renders a running server with uptime and toolchain" case at :96-103, whose expected string must lose the `, leanprover/lean4:v4.12.0` suffix — the neighboring cases at :105+ already cover mode label and status tails, so coverage is unchanged).

Second correction: line 119 is edited, not deleted, so the registry loses 11 lines (5 for `toolchain` decls/copies + 1 render line + 5 for `pid`), not 12.

Also worth recording in the issue body as the reason `pid` is safe to drop: run-end Lean teardown goes through `LeanLanguageServices.stopSessionsForRun` (`src/tools/lean/leanLanguageServices.ts:96-105`), which holds the session objects, so no current or deferred teardown work needs a registry pid.

<details><summary>Verifier reasoning</summary>

Survives. I re-ran the greps independently (excluding built bundles under `packages/extension/dist`, `packages/cli/.texra-validate-run`, and `docs/.vitepress/dist`, which the original grep noise came from).

`toolchain`: the only two writers of the registry are `src/tools/lean/direct/leanSession.ts:186-190` (`registerLeanServer({id, workspaceRoot, mode: 'direct-lsp', status: 'starting'})`) and `packages/extension/src/frontend/lean/VscodeIntegration.ts:76-85` (`updateLeanServer(id, {status:'running'})` / `registerLeanServer({id, workspaceRoot, mode:'vscode-extension', status:'running'})`). Neither passes `toolchain`. The five `updateLeanServer` call sites (`leanSession.ts:202,219,267,296,298`) pass only `status`/`errorMessage`/`pid`. So `src/tools/lean/leanServerRegistry.ts:118` always yields `''`. A repo-wide grep for `toolchain` outside build output shows every other hit is the unrelated `toolchain_unavailable` error kind (`leanTypes.ts:183`, `directLspAdapter.ts:516-537`, `LspTools.ts:164`), the `select_toolchain` lean_project command (`leanTypes.ts:95`, `VscodeIntegration.ts:53`), or LaTeX-toolchain prose. No package.json contribution, no coreSettings/stateSettings key, no agent YAML, no prompt, no supabase function references it.

`pid`: written once (`leanSession.ts:267`), read zero times in production. The only two registry readers are `src/tools/externalToolDefs.ts:453` (`.filter(isLeanServerActive).length`) and `:472` (`summarizeLeanServers()`); `summarizeLeanServers` (`leanServerRegistry.ts:111-124`) and `statusTail` never touch it. `grep -rn "\.pid\b"` across `src/tools`, and all three host packages returns only the write site, `process.pid` uses, and the registry's own copy lines.

Not already done: `git log -15 -- src/tools/lean/leanServerRegistry.ts` — last functional change is #9694 (observers), and `git log --all --grep leanServerRegistry|LeanServerInfo` is empty. Not already filed: no tech-debt issue matches; the Lean-server issues that exist (#10283/#10422/#10423/#10424/#10425, all CLOSED) are run-end teardown attribution, not registry fields. No ruling protects it: `docs/proposals/2026-08-15-lifecycle-ownership.md` mentions Lean disposal only in the teardown-idiom sense, and `docs/guide/lean.md:55` promises only that the Tools panel "lists any active language servers" — no pid or toolchain column is documented.

I specifically checked whether `pid` is latently load-bearing for the teardown work: it is not. `stopLeanServersForEndedRun` (`src/tools/lean/leanLanguageServices.ts:101`, called from `src/agent/runtime/executeAgent.ts:228`) delegates to `LeanLanguageServices.stopSessionsForRun`, which owns live session objects and kills the child directly — it never consults the registry, let alone `pid`. No catch/fallback is touched, no ratchet or frozen surface is involved (this is `src/tools/`, not `@agent/*`, not the PocketFlow engine, not a browser-safe util, not AgentEvent/SessionFact), and nothing here feeds the CLI result-JSON contract. Bounded, single-directory, no unrelated churn.

</details>

### L6-shared — Shared, controllers, platform, utils

**Paths**: `src/shared/**` (not `stateSettings.ts`), `src/controllers/`, `src/platform/`, `src/utils/`, `src/auth/`, `src/latex/`, `src/model/`, `src/replacement/`, `src/transcript/`, `src/common/`, `src/housekeeping/`, `src/test-kernel/`

#### Delete the FakeDiffViewHost test double and the suite that only tests it

- **Area**: `platform-ports` · **Kind**: test-only-consumer · **Risk**: low
- **Net**: -155 LoC, -6 elements

**Evidence**

src/test-kernel/support/FakeHosts.ts:124-169 defines `FakeDiffViewHost` (plus `DiffOpenEvent` :30, `DiffRevealEvent` :36, `FakeUIHostsOptions.proposedDiffContent` :45, the `diff` member on `UIHosts` :179 and `FakeUIHosts` :185, and `setProposedContent` :166 which has zero references repo-wide). Consumers of `hosts.diff`: `rg "hosts\.diff" src packages` returns 6 hits, all inside src/test-kernel/hosts/FakeHosts.vitest.ts:55-84 — a suite whose entire subject is the fake's own recording behavior. The three real suites that use `createFakeUIHosts` touch only `prompt` and `externalOpener`: src/test-kernel/controllers/SettingsProfileKeyController.vitest.ts:50-51,84-198, src/test-kernel/controllers/SettingsMemoryController.vitest.ts:52,189-197, src/test-kernel/progressView/ProgressViewOnboardingRefresh.vitest.ts:324,406. Production DiffViewHost implementors (packages/extension/src/frontend/approval/VscodeDiffViewHost.ts:26, packages/desktop/src/main/desktopDiffHost.ts:45) are exercised by their own suites (DesktopDiffHost.vitest.ts, DesktopToolEditApproval.vitest.ts) and never through this fake. Production consumers of the deleted code: 0. Note: the fix lands entirely in src/test-kernel/, outside the platform-ports paths, but the surface is the fake for `@hosts/uiHosts`'s `DiffViewHost`, which is in-area.

**Proposal**

Delete src/test-kernel/hosts/FakeHosts.vitest.ts outright (89 L; a suite testing a test double is not a product contract — AGENTS.md 'Testing discipline'). In src/test-kernel/support/FakeHosts.ts delete `FakeDiffViewHost`, `DiffOpenEvent`, `DiffRevealEvent`, the `proposedDiffContent` option, the `diff` members of `UIHosts`/`FakeUIHosts`, the `diff:` line in `createFakeUIHosts`, and the now-unused `DiffSession`/`DiffSource`/`DiffViewHost` type imports. `UIHosts` then has two members and can fold into `FakeUIHosts` directly.

**What we give up**

A shared in-memory DiffViewHost double. If a future host-neutral controller needs one, it is ~20 lines to re-add at the point of use — which is what the two host suites already do today (DesktopToolEditApproval.vitest.ts:444 defines its own inline openDiff).

**Verifier corrections to the evidence above**

Two errors in the original evidence, neither fatal. (1) src/test-kernel/progressView/ProgressViewOnboardingRefresh.vitest.ts does NOT use createFakeUIHosts — no FakeUIHosts or FakePromptHost hit exists anywhere under src/test-kernel/progressView/. There are exactly two real consumer suites, not three: SettingsProfileKeyController.vitest.ts:7,20,26 and SettingsMemoryController.vitest.ts:5,42,45. (2) src/test-kernel/hosts/FakeHosts.vitest.ts is not a suite whose subject is only FakeDiffViewHost: two of its four tests ("records prompt effects and returns queued responses", "defaults unqueued confirmations to cancel", lines 9-45) exercise FakePromptHost. Both halves are still a test double testing itself, so deleting the whole 88-line file is defensible, but the file's scope is wider than the title implies and reviewers should be told that the prompt-fake self-tests go too. Also worth recording: the desktop side implements only Pick<DiffViewHost,'openDiff'> (packages/desktop/src/main/desktopDiffHost.ts:45), which is the concrete reason the PRD's "FakeHosts invariant suite" idea never bound real adapters. Line counts verified: FakeHosts.vitest.ts is 88 lines (not 89), FakeHosts.ts is 196.

<details><summary>Verifier reasoning</summary>

Survives. I independently confirmed zero production consumers: `DiffViewHost` in source (excluding dist bundles) resolves to the port at src/hosts/uiHosts.ts:11, real implementors at packages/extension/src/frontend/approval/VscodeDiffViewHost.ts:26 and packages/desktop/src/main/desktopDiffHost.ts:45 (only Pick<DiffViewHost,'openDiff'>), and the fake at src/test-kernel/support/FakeHosts.ts:5,124,179,185,194. No production path constructs or receives FakeDiffViewHost. `hosts.diff` has 9 hits, every one inside src/test-kernel/hosts/FakeHosts.vitest.ts:55-84. `setProposedContent` (FakeHosts.ts:166) has exactly one hit repo-wide, its own definition. The two real consumers of createFakeUIHosts (src/test-kernel/controllers/SettingsProfileKeyController.vitest.ts:52-53 and SettingsMemoryController.vitest.ts:53) pass hosts.prompt / hosts.externalOpener field-by-field into the controller and never touch the aggregate or the diff member, so deleting `diff` and folding UIHosts into FakeUIHosts forces no churn in them. Nothing in packages/extension/package.json, packages/extension/src/commands.ts, src/shared/schemas/coreSettings.ts or stateSettings.ts, packages/extension/resources/, prompts/, or supabase/functions/ references any of the deleted symbols. Not already done: git log on both paths shows b0a64d0c70 (#11188) and 57ab66b1f7 (#10865) trimmed neighboring members and deliberately left the diff fake and its self-test standing. Not already filed: gh issue search returns only closed #6533/#3302/#3374/#3293, all about building the harness. No deliberate ruling defends it — the only mention, docs/prds/2026-05-02-prd-electron-app.md:905, hoped FakeHosts would become a shared invariant suite the Electron adapters run against, but the shipped desktop host implements only openDiff and is covered by its own src/test-kernel/desktop/DesktopDiffHost.vitest.ts and DesktopToolEditApproval.vitest.ts, so that aspiration never materialized and does not beat the claim. Section 15 check clears: the one production behavior that could have been pinned here, 4ee430295d "block approval when diff content is unreadable", lives at src/controllers/approval/ToolEditApprovalController.ts:354 and is covered by src/test-kernel/controllers/ToolEditApprovalController.vitest.ts:42,120 using its own vi.fn preview, not the fake — so no load-bearing fallback is being deleted. Section 14 R5/R6: this removes elements outright (one class, two interfaces, one options field, one whole file) with no relocation and no net-positive LoC. Settled-surfaces check clears: the DiffViewHost port itself is retained; nothing touches the five ratchets, the @agent/* surface, src/agent/node/index.ts, the platform composition root, the six browser-safe utils, or the AgentEvent/SessionFact split. Nothing in the CLI result-JSON contract. Bounded, test-only, low risk — record as an issue, not a proposal.

</details>

#### Delete executeCommand's redundant `mode` option — it is always derivable from the command form

- **Area**: `utils` · **Kind**: dual-representation · **Risk**: low
- **Net**: -50 LoC, -5 elements

**Evidence**

src/utils/system/execUtils.ts:299-307 computes `const mode = options.mode ?? (Array.isArray(command) ? 'process' : 'shell')` and then throws whenever the two disagree: `if ((mode === 'shell') === Array.isArray(command)) throw`. That guard is a proof that `mode` can never legally carry information the command form does not already carry. Production callers that pass it: exactly 2, both `mode: 'shell'` on a string command, i.e. both restate the default — src/tools/bash.ts:313 and src/tools/bash.ts:449 (grep `mode: 'shell'|mode: 'process'` over src + packages returns only those two plus execUtils itself). 49 other production call sites of `executeCommand(` (rg -c over src + packages, test-kernel excluded) pass nothing. Non-production consumers of the symbol: 0 (`ExecuteCommandMode` is not exported). The machinery around it was added 4 days ago by bcdf3cd33f (2026-08-21, "Simplify data structures flagged by the complexity audit"), whose own commit body says it added overloads "narrowing `mode` to the command's array/string form at compile time, on top of the existing runtime check" — §13's abstraction-cost pattern: a reduction PR growing scaffolding around a redundant field instead of deleting it. Downstream, `mode` is read only at execUtils.ts:387 and :437 (`if (mode === 'process')`), and execUtils.ts:426-429 carries a `command as string` cast plus a 3-line comment existing solely because TypeScript cannot correlate `mode` with the array check.

**Proposal**

Delete `type ExecuteCommandMode` (execUtils.ts:232) with its 14-line doc block (218-231, folding the process/shell teardown prose onto the implementation), delete `interface ExecuteCommandOptions extends ExecuteCommandBaseOptions { mode?: ... }` (260-267) and use the already-exported `ExecuteCommandBaseOptions` directly, delete all three overload declarations (279-290) leaving one signature, and delete the mismatch guard (296-307). Replace the two `mode === 'process'` reads at :387 and :437 with `Array.isArray(command)`, which narrows `command` naturally and lets the `command as string` assertion and its comment at :426-429 go too. Outside the area: drop `mode: 'shell'` and its 3-line comment at src/tools/bash.ts:313 and :449 (behavior identical — the default already yields 'shell' for a string command, which the current guard enforces).

**What we give up**

The self-documenting `mode: 'shell'` marker at the two bash.ts call sites, which currently reads as a comment about process-group teardown. Replace it with a one-line comment if the intent is worth keeping. Nothing else: a caller cannot express a mode that differs from the command form today without throwing.

**Verifier corrections to the evidence above**

Two corrections, neither material. (a) "49 other production call sites of executeCommand(" is inflated: most `executeCommand(` hits under packages/extension are `vscode.commands.executeCommand`, a different symbol. The real figure is 18 production files importing from src/utils/system/execUtils.ts (latexdiff.ts, diffCommandExecutor.ts, githubSubscriptionTool.ts, wolframScriptUtils.ts, codexImport.ts, grep.ts, bash.ts, toolUtils.ts, workspaceInfo.ts, img.ts, externalBinaryUtils.ts, isGitRepository.ts, repositoryOverview.ts, worktreeInfo.ts, packages/cli gitOps.ts, clone.ts, updateChecker.ts, packages/extension gitCommands.ts) — of which only bash.ts passes `mode`. The conclusion is unchanged and in fact tighter. (b) The claim under-credits its strongest evidence: `mode` did not exist before #9990 (8b71e6149d, 2026-08-12); that commit replaced two plain `if (Array.isArray(command))` checks with `mode === 'process'` and introduced the `command as string` cast the proposal removes. bcdf3cd33f then added the overloads on top. So this is a revert of a 13-day-old added-then-scaffolded redundancy, which is stronger than "a reduction PR growing scaffolding".

<details><summary>Verifier reasoning</summary>

I tried to refute this and could not. Verified independently:

1. `mode` carries zero information. src/utils/system/execUtils.ts:299-307: `const mode = options.mode ?? (Array.isArray(command) ? 'process' : 'shell')` followed by `if ((mode === 'shell') === Array.isArray(command)) throw`. Enumerating: string+'process' → false===false → throws; array+'shell' → true===true → throws. So the only non-throwing combinations are exactly the two the default already produces. The field is a strict duplicate of the command form.

2. Sole passers are the two claimed sites. `rg "mode: 'shell'|mode: 'process'"` over the whole repo (excluding node_modules) returns only src/tools/bash.ts:313, src/tools/bash.ts:449, and execUtils itself. Both bash sites take `command: string` (bash.ts:429 and the background-session field at :248), so both restate the default. No test passes `mode` (src/test-kernel/utils/system/SystemUtils.vitest.ts's only "mode" hit is an unrelated encoding/output-mode test). `ExecuteCommandMode` is not exported and appears in no other file, no docs/, no ratchet, no knip baseline, no packages/agent surface, no YAML/prompt/supabase/schema/command-registration file (checked coreSettings.ts/stateSettings.ts/package.json contributions/commands.ts — executeCommand there is `vscode.commands.executeCommand`, a different symbol).

3. Smoking gun in history: `git show 8b71e6149d -- src/utils/system/execUtils.ts` shows that before #9990 (2026-08-12) the code was literally `if (Array.isArray(command))` at both branch points, with `execa(command, {...})` and no cast. That sweep added the type, the option, the guard, the `as string` cast and its 3-line apology comment; bcdf3cd33f (2026-08-21) then piled three overloads on top to compile-time-check a field that the runtime guard already proved redundant. The proposal is a revert to the pre-#9990 shape, not a new design — which also removes the cast, since `Array.isArray(command)` narrows `string | string[]` naturally at both :387 and :437 (the second read sits outside the if/else where `command` is still the union, so it narrows fine there too).

4. Not already done, not filed, not ruled on. `git log -12 -- src/utils/system/execUtils.ts` ends at bcdf3cd33f, which added rather than removed; `git log --all -S "options.mode"` finds only #9990 and its duplicate-message anchors on side branches, none removing it. `gh issue list --state all --search "execUtils"` returns #8183, #8217, #10767, #10013, #9780, #8149, #4202 — the two teardown-adjacent ones (#8183 execa natives, #8217 array-form abort backstop) are about the teardown mechanism itself, not the redundant selector, and both are closed. Searches for "executeCommand mode shell teardown" and "redundant mode option derivable" return nothing. No proposal/architecture/audit doc mentions `ExecuteCommandMode`; docs/proposals/2026-08-15-lifecycle-ownership.md touches execUtils only for unthreaded `signal` on LaTeX compiles, unrelated.

5. Settled surfaces: execUtils is not one of the six browser-reachable @utils modules, not in the frozen @agent/* surface, not in src/agent/node/index.ts, not a ratchet entry, not the AgentEvent/SessionFact split, not the CLI result-JSON contract. `ExecuteCommandBaseOptions` stays exported and keeps its consumer (src/utils/system/toolUtils.ts:35,336), so the dead-export ratchet is unaffected.

6. §15 check: the guard is not a masking fallback — it throws loudly, and it can only fire on an input combination that becomes unrepresentable once the field is gone. No behavior change for any existing caller. §13/§14: this deletes elements (a type, an interface, three overloads, a guard, a cast, two call-site options and their comments) rather than relocating them; the only relocation is ~11 lines of genuinely useful process/shell teardown prose, which moves onto the branch it describes.

Bounded, single-area, no unrelated churn. recordAs "issue".

</details>

#### Delete src/shared/utils/dom.ts: the vscode-elements scrollPos/scrollMax branch is unreachable

- **Area**: `shared-rest` · **Kind**: expired-compat · **Risk**: low
- **Net**: -41 LoC, -3 elements

**Evidence**

`src/shared/utils/dom.ts` is 38 lines with 2 exports (`vsCodeScrollExtent` at :6, `scrollToBottom` at :26). Production consumers: **1 file** — `packages/extension/src/progressView/frontend/components/TaskGroupList.ts:39` imports both. Non-production consumers: **0** (`rg -n "shared/utils/dom" --hidden -g '!node_modules' .` returns only that import plus three January-2026 PRD docs: `docs/prds/2026-01-24-prd-progressview-phase3.md:67,196,280`, `docs/prds/2026-01-26-prd-progressview-phase6.md:77`, `docs/prds/2026-01-26-prd-lit-native-phase9.md:654`). Ambiguous (scripts/): **0**.

The compat branch is provably dead. `vsCodeScrollExtent` only returns a value when the element carries `scrollPos`/`scrollMax` — the API of the retired `<vscode-scrollable>` custom element. Its sole call site is `TaskGroupList.isNearBottom` (`:372-379`), which reads `this.scrollContainer`, declared `@query('#logContent') private scrollContainer?: HTMLElement` (`:155-156`) and rendered at `:542-546` as a plain `<div id=${ELEMENT_IDS.LOG_CONTENT} class="log-container" @scroll=...>`. A plain div never has `scrollPos`/`scrollMax`, so `vs` is always `undefined` and both the `if (vs)` arm in `isNearBottom` (`:374`) and the `if (vs)` arm inside `scrollToBottom` (`src/shared/utils/dom.ts:31-34`) are unreachable.

The vscode-elements era ended in `b62fd3d491` "feat(webview,progress): retire last vscode-elements and codicon chevrons (#3679)", dated **2026-05-08** — 3.5 months ago, past the compat window. `rg -n "vscode-scrollable|scrollPos|scrollMax"` over `src packages` finds no other producer of those properties anywhere in the repo; the only other hit is a stale comment at `packages/extension/src/progressView/frontend/components/LogList.ts:191`.

**Proposal**

Delete `src/shared/utils/dom.ts` entirely. In `TaskGroupList.ts`: drop the import at `:39`; in `isNearBottom` delete `:373-374` so it falls straight through to the standard `scrollHeight - scrollTop - clientHeight` computation already at `:375-379`; replace `scrollToBottom(this.scrollContainer)` at `:190` with `this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;`. Also fix the stale `scrollMax` comment at `LogList.ts:191`. Nothing else in the repo imports the module. This also removes a VS Code-webview-specific helper that had no business sitting in host-agnostic `src/shared/` with exactly one host consumer.

**What we give up**

Auto-scroll/sticky-scroll support for `<vscode-scrollable>` scroll containers, which the progress view stopped rendering when vscode-elements was retired in #3679 (2026-05-08). If a future component reintroduced a custom scroll element exposing `scrollPos`/`scrollMax`, it would need its own handling — but no such element exists in the tree today.

**Verifier corrections to the evidence above**

Corrections are minor and do not change the verdict.

1. Net LoC undercounted. `wc -l src/shared/utils/dom.ts` = 38 (not 37). Full accounting: -38 (whole file) -1 (import at `packages/extension/src/progressView/frontend/components/TaskGroupList.ts:39`) -2 (`isNearBottom` lines 373-374) +0 (`scrollToBottom(this.scrollContainer)` at :190 becomes a one-line assignment) = **-41**, plus 1 stale-comment word fix at `LogList.ts:191`.

2. The claimed "1 production consumer" is right but my grep of `scrollToBottom` alone returns extra hits that are NOT this module and should not be confused with it: `TerminalOutput.ts:218` defines its own `scrollToBottom()` method (delegates to xterm), and `LogList.ts:196/201` call `activeEl?.scrollToBottom()` / `scrollToBottomIfSticky()`, which are methods on `TaskGroupList`, not the shared helper. The only import of the module anywhere is `TaskGroupList.ts:39`.

3. There is no barrel: `src/shared/utils/` has no `index.ts` (files are clipboard, clipboardImages, devAssertionMode, dispatcher, dom, events, icons, liveLinkUrl, selectTemplates, textarea, uiConstants, xmlEscape) and `rg "from '@shared/utils'"` returns zero hits, so no indirect consumer exists.

4. The `LogList.ts:191` hit is a comment reading "has an accurate scrollMax before we scroll" inside a `requestAnimationFrame` block — it is describing layout settling, so the fix is wording only (`scrollHeight`), with no behavioral coupling to the deleted module.

<details><summary>Verifier reasoning</summary>

It survives. I re-derived the dead-branch argument from the source rather than trusting it.

Unreachability is provable end to end. `vsCodeScrollExtent` (`src/shared/utils/dom.ts:6-20`) returns a value only when the element itself carries numeric `scrollPos` and `scrollMax`. Its single call site is `TaskGroupList.isNearBottom` (`TaskGroupList.ts:372-379`), reading `this.scrollContainer`, declared `@query(`#${ELEMENT_IDS.LOG_CONTENT}`) private scrollContainer?: HTMLElement` (`:155-156`). `ELEMENT_IDS.LOG_CONTENT` is `'logContent'` (`packages/extension/src/progressView/frontend/constants.ts:36`), and the only element bearing that id is the plain `<div id=${ELEMENT_IDS.LOG_CONTENT} class="log-container" @scroll=${this.handleScroll}>`rendered at`:542-548`. The helper is handed that div itself, not an ancestor, so no wrapping custom element could supply the properties. A plain `HTMLDivElement`never exposes`scrollPos`/`scrollMax`, so `vs`is always`undefined`and both`if (vs)`arms —`TaskGroupList.ts:374`and`dom.ts:31-34` — are unreachable.

No other producer exists. `rg -n "scrollPos|scrollMax|vscode-scrollable|vscode-elements" src packages` returns only `dom.ts` itself (7 hits) plus the one stale comment at `LogList.ts:191`. Nothing in the repo ever sets those properties.

Not already done, not already filed, not deliberately ruled. `git log -15 -- src/shared/utils/dom.ts` shows last touch `86b37e6d0c` "refactor: dedup wave 2 (#9902)", which consolidated helpers into the file rather than pruning the branch; `git log --all --grep vsCodeScrollExtent` is empty. `gh issue list --state all --search "vsCodeScrollExtent OR shared/utils/dom"` returns only #10674 (closed contracts/retirement tracking) and #3543 (the vscode-elements→Web Awesome migration itself, closed 2026-05-08) — neither covers this module. A tech-debt search on "scroll" surfaces nothing overlapping. `rg` over `config/`, `docs/proposals`, `docs/architecture`, `docs/dev`, `AGENTS.md`, `CLAUDE.md` for the module or symbol returns zero, so there is no dated ruling to beat. The only doc hits are January-2026 PRDs recording the original migration into this file, which are historical records, not a design commitment.

Settled surfaces are untouched: this is not one of the five ratchets, not the frozen `@agent/*` SDK surface, not `src/agent/node/index.ts`, not a host or the platform composition root, not one of the six browser-reachable `@utils` modules (this is `src/shared/utils/`, a different tree with no browser-safe count to disturb), and not the AgentEvent/SessionFact split. Deleting a `src/shared` → `packages/extension` consumer edge only removes an architecture edge, never widens a baseline.

Checklist section 15 does not save it. This is not a masking fallback: the compat branch is the arm that never runs, and the standard-DOM path at `dom.ts:37` and `TaskGroupList.ts:375-379` is what actually executes today. Nothing is silently swallowed, no error is being hidden, and behavior after deletion is byte-identical. M1-M6 do not apply.

Sections 13 and 14 R5/R6 favor the deletion rather than refuting it. It removes one whole module and two exports without relocating any logic: the replacement for `scrollToBottom(el)` is the single line `el.scrollTop = el.scrollHeight` that the helper's own fallback already runs, and `isNearBottom` falls straight through to the standard computation already sitting below the deleted lines. No new helper, no new indirection, no forced churn beyond one import line and one stale comment. It also corrects a genuine layering smell — a VS Code-webview-specific DOM helper living in host-agnostic `src/shared/` with exactly one host consumer.

Scope is bounded (one file deleted, three small edits in one component, one comment), so this is an issue, not a proposal. It does not touch the CLI result-JSON contract consumed by texra-ai/texra-action, so risk stays low.

</details>

#### Fold the internal-only Kimi Code route resolver, wire-id helper, and config synthesizer into their two live entry points

- **Area**: `latex-replacement-model` · **Kind**: speculative-generality · **Risk**: low
- **Net**: -40 LoC, -4 elements

**Evidence**

src/model/kimiCodeSubscriptionRouting.ts exports 7 symbols; only 3 have production consumers outside the file. `isKimiCodeRoute` (:99) → src/model/codingPlanSubscriptions.ts:60. `kimiCodeEffectiveConfig` (:170) → src/model/computeModelOptions.ts:282, src/agent/runtime/ModelFactory.ts:571. `resolveKimiCodeRoutingFacts` (:120) → codingPlanSubscriptions.ts:62, ModelFactory.ts:573. The other four have production consumers = 0 outside their own file: `resolveKimiCodeRoute` (:61) — sole use is :104 inside `isKimiCodeRoute`, compared `=== 'kimiCode'`, so a `'kimiCode' | null` return type carries no information a boolean does not; `kimiCodeWireModelId` (:44) — sole use is :149; `kimiCodeRuntimeConfig` (:148) — sole use is :177; `KimiCodeRoutingFacts` (:84) — zero consumers anywhere (both external callers pass an object literal or the resolver's return value). The first three are already carried as `production-dead` rows in config/ratchets/knip-baseline.json (lines 1961-1978). Test consumers: src/test-kernel/model/KimiSubscriptionRouting.vitest.ts:52-59 (wire id), :61-90 (route resolver), :92-108 (runtime config); src/test-kernel/model/KimiCodeModels.vitest.ts:6,37,49 (wire id). This is leftover from #9982/#10573, which added the fact-gatherer 'beside `resolveKimiCodeRoute`' and never deleted the path it replaced — the build-implies-delete rule in review-checklist §13.

**Proposal**

Move the four-branch body of `resolveKimiCodeRoute` into `isKimiCodeRoute(config, facts): boolean` and delete `resolveKimiCodeRoute`; inline `kimiCodeWireModelId`'s one-entry `KIMI_CODE_WIRE_MODEL_IDS` lookup into `kimiCodeRuntimeConfig`, and inline `kimiCodeRuntimeConfig` into `kimiCodeEffectiveConfig` (:170-178) since it is the only caller; drop the `export` on `KimiCodeRoutingFacts`. Module keeps exactly three exported functions. Reroute the three vitest describes through `isKimiCodeRoute(config, {useOpenRouter, keySet, preferKimiCode})` and `kimiCodeEffectiveConfig(config, facts)` — the four positional args map 1:1 onto the facts literal, so every existing case survives. Regenerate the knip baseline: 3 rows leave, none is added.

**What we give up**

The ability to read out _which_ route was chosen as a string. Today that vocabulary has exactly two states ('kimiCode' or null), so nothing observes it; if a third managed endpoint ever appears, the discriminated return would have to come back. Also loses direct unit access to the wire-id table and to the pre-route config synthesizer; both stay covered indirectly through `kimiCodeEffectiveConfig`.

**Verifier corrections to the evidence above**

Three corrections. (1) "KimiCodeRoutingFacts (:84) - zero consumers anywhere" is false: it is the parameter type of isKimiCodeRoute (src/model/kimiCodeSubscriptionRouting.ts:101), the return type of resolveKimiCodeRoutingFacts (:122), and a parameter of kimiCodeEffectiveConfig (:172) - two of those are exported functions whose external callers (src/model/computeModelOptions.ts:282, src/agent/runtime/ModelFactory.ts:571) build the literal, so un-exporting it removes zero elements and makes the shape unnameable. Drop that leg. (2) The "leftover from #9982/#10573" framing fits only resolveKimiCodeRoute; kimiCodeWireModelId and kimiCodeRuntimeConfig were added by #8709 (17e9129d3b), predate the fact-gatherer, and have never had an outside-file production consumer - they are ordinary single-caller steps, not build-implies-delete residue. (3) The proposal misses a second test file: src/test-kernel/model/KimiCodeModels.vitest.ts:37 asserts kimiCodeWireModelId leaves exclusive plan aliases unchanged, and that cannot be rerouted through kimiCodeEffectiveConfig, which returns exclusive configs untouched regardless of the KIMI_CODE_WIRE_MODEL_IDS map - the guard is lost, not moved. LoC: the module is 178 lines and the three folds save roughly 40 source lines; converting the eight positional resolveKimiCodeRoute calls in KimiSubscriptionRouting.vitest.ts:61-90 to facts-object literals is neutral-to-longer under prettier, so -70 is inflated.

<details><summary>Verifier reasoning</summary>

Survives, narrowed. I re-ran the greps myself with --no-ignore across the repo: `resolveKimiCodeRoute`, `kimiCodeWireModelId`, `kimiCodeRuntimeConfig` appear only in src/model/kimiCodeSubscriptionRouting.ts, the two vitest files, and config/ratchets/knip-baseline.json:1961-1978. No hits in packages/extension/package.json, packages/extension/src/commands.ts, src/shared/schemas/coreSettings.ts or stateSettings.ts, packages/extension/resources/, prompts/, or supabase/functions/. packages/agent/src/{index,node,schemas}.ts do not re-export the module, so the packages/agent/dist/types/.../kimiCodeSubscriptionRouting.d.ts hit is build output, not the fenced SDK surface. git log -- src/model/kimiCodeSubscriptionRouting.ts (last touch 2d82c8138e, relay removal) shows no commit un-exported these; `gh issue list --label tech-debt --state all --search "Kimi"` returns nine issues (#10566, #10523, #10567, #10607, #10869, …), none covering this residue; #9982's body confirms it scoped a gatherer "beside resolveKimiCodeRoute" and left it standing. The only docs reference is docs/proposals/2026-08-04-ssot-consolidation-part-2.md:50, which cites the file as evidence for the CLI status-bar bug G1 and rules nothing about these exports. No settled surface, no catch/fallback (§15 N/A), no CLI result-JSON contract. The §13/§14-R5 core holds for resolveKimiCodeRoute: it is a true pass-through whose only caller (isKimiCodeRoute:104) collapses its 'kimiCode' | null to a boolean; kimiCodeWireModelId and kimiCodeRuntimeConfig are single-caller extractions the abstraction-discipline rule bans. Element delta is negative (3 exports out, 0 in; 3 knip-baseline rows removed, none added), so R6 is satisfied. Bounded deletion, low risk.

</details>

#### Inline the two Codex-only helpers that sit in the shared oauth/ layer as single-caller extractions

- **Area**: `auth` · **Kind**: single-caller-wrapper · **Risk**: medium
- **Net**: -30 LoC, -3 elements

**Evidence**

`src/auth/oauth/sessionAccess.ts:94-140` `isSubscriptionSessionRoutable` is parameterized over `ErrorType: ProviderAuthErrorCtor` and `displayName: string` for a second provider. `rg -n "isSubscriptionSessionRoutable" src packages docs` returns exactly four hits: the definition (:94), the import and the sole call in `src/auth/codex/codexAuthAccess.ts:8,46`, and one line of prose in `docs/proposals/2026-08-04-xai-grok-oauth-subscription.md:119`. **Zero test consumers** — `src/test-kernel/auth/SessionAccess.vitest.ts` (63 lines) has two `it()` cases and both exercise `getSubscriptionSessionStatus` only. The second provider arrived and declined to use it: `src/auth/xai/xaiAuthAccess.ts:6-7` imports `createSecretBackedCoordinator` and `getSubscriptionSessionStatus` and nothing else. The generalization was validated by a real second provider and failed. Its own doc comment (:91-92) points back at the caller — "See Codex's `isCodexSessionRoutable` for the re-auth / superseded-session rules" — a circular reference confirming the policy lives in the caller, not here. Sole downstream consumer of the caller: `src/agent/runtime/ModelFactory.ts:515`.

`src/auth/oauth/jwtDecode.ts:53-66` `claimsPreferringIdToken` has exactly one caller: `src/auth/codex/codexJwt.ts:25,68`. xAI deliberately does not use it — `src/auth/xai/XaiSessionCoordinator.ts:84-86` carries the comment "Decode each token once; do not use extractXaiClaims (email-only and would re-decode)". No direct test; it is covered transitively through `extractCodexClaims` in `src/test-kernel/auth/CodexJwt.vitest.ts`.

Both are §13 / R5 "no single-caller extractions" violations living in the shared layer, where they read as available machinery for a third provider that no one has asked for.

**Proposal**

Move `isSubscriptionSessionRoutable`'s body into `isCodexSessionRoutable` at `src/auth/codex/codexAuthAccess.ts:45-51`, concrete on `CodexAuthError`, dropping the `ErrorType`/`displayName` parameters, the `error instanceof ErrorType || error instanceof SubscriptionOAuthError` double-check (`wrapProviderOAuthClient` at `CodexSessionCoordinator.ts:99` already maps every client error to CodexAuthError), and the `void platform()` post-init guard (`codexCoordinator()` calls `platform()` on the next line). Delete the export from sessionAccess.ts and shrink `SessionAccessCoordinator` (:63-67) to the single `getStatus()` member `getSubscriptionSessionStatus` actually needs — dropping `getFreshAccessToken` and `loadSession`. Separately, inline `claimsPreferringIdToken` into `extractCodexClaims` (`codexJwt.ts:64-75`) as a two-field `??` coalesce and delete it from jwtDecode.ts. `sessionAccess.ts` keeps `secretBackedSessionStorage`, `createSecretBackedCoordinator` and `getSubscriptionSessionStatus`, all of which have two real callers.

**What we give up**

A third subscription provider that wants the same re-auth/superseded-session routability rules would re-extract them. Given that the second provider (xAI) shipped without them, that cost is speculative; the rules themselves stay intact and unchanged in the Codex path.

**Verifier corrections to the evidence above**

Four corrections/additions to the original evidence:

1. The redundancy of `error instanceof ErrorType || error instanceof SubscriptionOAuthError` is guaranteed by `errorType: CodexAuthError` passed to the base coordinator (`src/auth/codex/CodexSessionCoordinator.ts:104`) combined with `SubscriptionOAuthCoordinator.mapErrors` (`src/auth/oauth/SubscriptionOAuthCoordinator.ts:134-142`) calling `rethrowAsProviderAuthError` — NOT by `wrapProviderOAuthClient` at `:102`, which only wraps the HTTP client. Note `getFreshSession` throws a bare `SubscriptionOAuthError` at `:284` and relies on `mapErrors` to convert it. The inline should therefore keep `error instanceof SubscriptionOAuthError` (the base class, which `CodexAuthError` extends) rather than narrowing to `CodexAuthError`: same line count, and it does not depend on the distant `errorType` wiring staying in place.
2. `loadSession()` is NOT wrapped by `mapErrors` (`SubscriptionOAuthCoordinator.ts:144`), so the inner try/catch around the `loadSession` call is load-bearing and must be preserved verbatim.
3. Both helpers were introduced by the xAI PR #9709 itself (`git log -S ... --all`), not by an earlier Codex-only change later hoisted — the shared-layer bullet at `docs/proposals/2026-08-04-xai-grok-oauth-subscription.md:119` is design intent authored alongside the code, not a ruling that survived contact.
4. Shrinking `SessionAccessCoordinator` also requires trimming two lines from the fixture at `src/test-kernel/auth/SessionAccess.vitest.ts:12-16` (`getFreshAccessToken`, `loadSession`). That is the module's own test, in scope, and it reduces LoC further rather than being unrelated churn.

<details><summary>Verifier reasoning</summary>

I re-ran every grep myself and the core factual claims hold. `rg -n "isSubscriptionSessionRoutable|claimsPreferringIdToken"` over the whole tree (excluding node_modules and `packages/agent/dist`, which is bundler output, not a source consumer) returns exactly: the definitions (`src/auth/oauth/sessionAccess.ts:94`, `src/auth/oauth/jwtDecode.ts:53`), one importer + one call site each (`src/auth/codex/codexAuthAccess.ts:8,46`; `src/auth/codex/codexJwt.ts:25,68`), and one prose bullet in `docs/proposals/2026-08-04-xai-grok-oauth-subscription.md:119`. No host, command registration, schema, YAML, prompt, or supabase function references either symbol; `rg -n "Routable" src packages` confirms the only routability chain is `ModelFactory.ts:13,513-525` -> `codexAuthAccess.ts:45` -> the shared helper, and `src/auth/codex/index.ts:39` re-exports only the Codex wrapper (unchanged by the proposal). xAI genuinely has no routability concept: `src/agent/modelHandlers/openai/modelHandlerXAI.ts:176` resolves a token lazily via `xaiCoordinator().getFreshAccessToken()`, and the newer provider catalog `src/controllers/modelAccess/subscriptionProviders.ts:233-273` (the "adding a third provider is one row here" surface) has no routability member at all, so nothing in the shared layer depends on the probe.

Not already done, not filed, not protected. `git log --oneline -25 -- src/auth/oauth src/auth/codex src/auth/xai` shows no removal or defense; `git log --all --grep` for both symbols is empty; `git log -S` shows BOTH helpers were introduced by the xAI PR itself (#9709, `39c39cd473`) — i.e. the generality was authored in the same change as the second provider and then not taken up by it, which strengthens rather than weakens the §13/R5 case. `gh issue list --state all --search` for both symbols returns zero rows; the nearest neighbour, #8879 (fold Codex auth surfaces into `codexAuthAccess`), is CLOSED and is precedent _for_ this direction. No `docs/dev/audits/`, `docs/architecture/`, AGENTS.md, CLAUDE.md, or `config/ratchets/` entry mentions `sessionAccess`/`jwtDecode`; `config/ratchets/knip-baseline.json` has no entry for either symbol. Neither symbol is on the frozen `@agent/*` SDK surface (`packages/agent/src` contains only `index.ts`, `node.ts`, `schemas.ts`, none of which touch auth), and none of the five ratchets, the PocketFlow engine, the platform composition root, the six browser-safe utils, or the AgentEvent/SessionFact split is involved.

Mechanics check out. `CodexAuthError extends SubscriptionOAuthError` (`codexSessionTypes.ts:82`), so post-inline the `instanceof` double-check is genuinely redundant. Dropping `void platform()` is safe because the inlined body's first statement is `codexCoordinator()` -> `coordinatorAccess.get()`, which calls `platform()` on the uncached path (`sessionAccess.ts:46`) and can only skip it once platform init has already happened. Shrinking `SessionAccessCoordinator` is safe: the only other consumer is its own test fixture. Nothing here is a §15 masking fallback — the error branches rethrow or return a signed-out verdict, and the proposal preserves both.

Residual risk, not a refutation: `isCodexSessionRoutable` has zero direct test coverage and gates ChatGPT subscription dispatch in `ModelFactory.tryCodexSubscriptionRoute`, so a sloppy inline breaks routing silently. That argues for medium risk and a careful diff, not for dropping the candidate. Record as a bounded deletion issue.

</details>

#### Carry the parsed Theme through themeContext and delete the dead body-class re-sniff in onThemeChange

- **Area**: `shared-rest` · **Kind**: dual-representation · **Risk**: low
- **Net**: -22 LoC, -1 elements

**Evidence**

`src/shared/schemas/commonViewMessages.ts:10` defines `ThemeSchema = z.enum(['dark','light','high-contrast'])` and `:22-25` parses the wire message with it, so `COMMON_COMMANDS.THEME_SET` arrives already narrowed to `Theme` at `src/shared/BaseWebviewApp.ts:41` (`context.setTheme(result.data.theme)`). The fact is then immediately widened back to `string` at three places and re-derived downstream:

1. `src/shared/BaseWebviewApp.ts:20` `setTheme: (theme: string) => void` and `:151` `protected onThemeChange(theme: string)`.
2. `src/shared/BaseWebviewApp.ts:160-166` re-narrows it by hand (`isTypedDark`) and then ORs in **two provably dead arms**: line `:153` runs `document.body.className = theme;`, which replaces the whole class attribute with the single class `'dark' | 'light' | 'high-contrast'`, so `document.body.classList.contains('vscode-dark')` (`:165`) and `.contains('vscode-high-contrast')` (`:166`) can never be true. The whole expression collapses to `themeIsDark(theme)` — exactly what the desktop path already does at `src/shared/wa/hostTheme.ts:32` (`setWaColorScheme(themeIsDark(theme))`).
3. `src/shared/BaseWebviewApp.ts:58` `createContext<string>('shared-theme')` forces the one consumer to re-narrow: `packages/desktop/src/renderer/TexraDiffView.ts:89-92` carries the comment "Kept `string` because themeContext carries a plain string" and `:211-214` casts it back (`monacoThemeForHostTheme(this.hostTheme as Theme)`) under "themeContext is typed `string` but only ever carries DESKTOP_THEME_KIND values".

The two vocabularies are also literally the same type: `src/shared/schemas/commonViewMessages.ts:14-20` declares `DESKTOP_THEME_KIND` `satisfies Record<string, Theme>` and `:20` `export type DesktopThemeKind = Theme;` — a pure alias.

Consumers grepped (`rg -n "themeContext|this\.theme\b|setTheme"` over `src packages`, excluding test-kernel): `themeContext` production consumers = **1** (`TexraDiffView.ts:7,87`); `onThemeChange` production overriders/callers = **0** outside `BaseWebviewApp.ts:78,151`. `DesktopThemeKind` production consumers = 3 (`packages/desktop/src/main/desktopViewStateIpc.ts:4`, `packages/desktop/src/renderer/reviewPane.ts:7`, `packages/desktop/src/renderer/editorPane.ts:74`).

**Proposal**

Type the theme as the already-parsed `Theme` end-to-end: `CommonMessageContext.setTheme: (theme: Theme) => void` (`BaseWebviewApp.ts:20`), `onThemeChange(theme: Theme)` (`:151`), `themeContext = createContext<Theme>('shared-theme')` (`:58`), and `@state() theme: Theme`. Then delete `:160-166` in favour of `setWaColorScheme(themeIsDark(theme));`, and in `TexraDiffView.ts` drop the `:89-92` explanatory comment, type `hostTheme: Theme`, and delete the `as Theme` cast and comment at `:211-214`. Optionally retire the `DesktopThemeKind = Theme` alias (`commonViewMessages.ts:20`) in favour of `Theme` at its 3 desktop consumers — that half lands in `src/shared/schemas/`, outside this area.

**What we give up**

Nothing observable. The two deleted `classList.contains` arms cannot fire (line :153 clears the class attribute first), and `themeIsDark` already maps `high-contrast` to dark, which is what those arms were reaching for. The only real loss is the ability to feed `onThemeChange` an out-of-vocabulary string, which the Zod boundary already rejects.

**Verifier corrections to the evidence above**

Three corrections. (1) The claim's framing of themeContext as a live seam to retype is wrong in effect: its single @consume site, packages/desktop/src/renderer/TexraDiffView.ts:87-92, is NOT a descendant of the @provide provider. `<main-app>` is created at packages/desktop/src/renderer/main.ts:287 while reviewPane.element is a sibling workbench surface (main.ts:385, mounted at main.ts:558), and the diff element itself is created detached at packages/desktop/src/renderer/reviewPane.ts:33 (`document.createElement('texra-diff-view')`). Theme actually reaches it imperatively: main.ts:1394 `reviewPane.setTheme(theme)` -> reviewPane.ts:210 `diffView.hostTheme = nextTheme` (initial value reviewPane.ts:195). So the @lit/context channel never delivers a value; themeContext (BaseWebviewApp.ts:58), the `@provide @state protected theme = ''` (:70-72), `this.theme = theme` (:152), and the `@consume` decorator on TexraDiffView are all deletable, which is a bigger and cleaner win than retyping them to Theme. An implementer should confirm this with one runtime check before deleting the context rather than retyping it. (2) The claim missed a third string-widening site: packages/desktop/src/renderer/reviewPane.ts:17 `hostTheme: string` in the DiffViewElement interface — it must move to `Theme` (or be dropped) alongside TexraDiffView.ts:92. (3) `DESKTOP_THEME_KIND` the const object has four real value consumers (src/shared/monaco/monacoLoader.ts:14,223-224; reviewPane.ts:7; packages/desktop/src/renderer/editorPane.ts:100; desktopViewStateIpc.ts:4) and must stay; only the `DesktopThemeKind = Theme` type alias (commonViewMessages.ts:20) is retirable, at its 3 type consumers plus packages/desktop/src/renderer/messageRoutes.ts:7,69 which the claim did not list. Minor note: retyping `theme = ''` to `Theme` needs a concrete initial, which is behavior-neutral because monacoLoader.ts:220-226 falls through to 'vs-dark' for both '' and 'dark'.

<details><summary>Verifier reasoning</summary>

Survives. The core deletion is provably correct: src/shared/BaseWebviewApp.ts:153 (`document.body.className = theme`) unconditionally precedes the `classList.contains('vscode-dark')` / `('vscode-high-contrast')` reads at :165-166, and `theme` is already enum-narrowed by ThemeSchema (src/shared/schemas/commonViewMessages.ts:10) at the parse site (BaseWebviewApp.ts:30,41), so both arms are unreachable and lines :154-167 collapse to `setWaColorScheme(themeIsDark(theme))` — exactly the desktop path at src/shared/wa/hostTheme.ts:32. All producers send enum values (packages/extension/src/webview/MainViewMessageHandler.ts:130, src/controllers/progressView/backend/LitSessionRenderer.ts:544, packages/desktop/src/main/desktopViewStateIpc.ts:16-30), so no non-enum string can reach onThemeChange. Not a §15 masking fallback (no catch, no persisted data, no silent default; the arms are unreachable, not load-bearing). Not filed (no open issue; closed #3535 covered desktop-renderer narrowing, already done at packages/desktop/src/renderer/messageRoutes.ts:7), not done (git log on src/shared/BaseWebviewApp.ts: last touches 033c0248b9 #9994 and 0310f6cbe7 #10609, neither touched the theme decision), not defended by any dated ruling (docs/proposals/2026-08-07-prod-structural-leads-triage.md:386 concerns a different alias, `DesktopTheme` in desktopViewStateIpc.ts, since removed). No settled surface is touched: not a ratchet edge (grep -rn DesktopThemeKind config/ → 0 hits), not @agent, not PocketFlow, not the browser-safe utils set. The one substantive correction (below) makes the deletion larger, not smaller.

</details>

#### Delete isSupabaseConfigured and the statically unreachable placeholder-credentials branch it guards

- **Area**: `auth` · **Kind**: defensive-machinery · **Risk**: low
- **Net**: -18 LoC, -1 elements

**Evidence**

`src/auth/config.ts:88-93` returns `!SUPABASE_CONFIG.url.includes('placeholder') && SUPABASE_CONFIG.publicKey !== 'placeholder-public-key'`. Both operands are module-level literals in the same file: `url` is `https://${SUPABASE_CUSTOM_DOMAIN}` = `https://remote.texra.ai` (:31, :26) and `publicKey` is `'sb_publishable_DUIDjtxk12ZYYncrVUfwOw_xWQYsSvw'` (:34). Neither is configurable at runtime — the docstring at :3-5 says these are TeXRA's official backend credentials. The function is therefore a compile-time constant `true`, and the branch it guards is dead code. `rg -n "isSupabaseConfigured" src packages` gives exactly one production consumer: `packages/extension/src/extension.ts:23,470`, whose false-branch logs "Please configure credentials in src/auth/config.ts before building" (:471-473) — a build-time placeholder warning from before the credentials were hardcoded. Two of the three hosts never check it: `packages/desktop/src/main/desktopSupabaseAuth.ts` and `packages/cli/src/runtime/supabaseAuth.ts` both call `createHostAuthCoordinator` unguarded. The genuinely empty-credential case is already handled loudly and in the right place: `SupabaseClient.initialize` throws on `!url || !publicKey` (`src/auth/SupabaseClient.ts:169-173`), `createHostAuthCoordinator` re-throws it as "Supabase authentication is not configured" (`src/auth/SupabaseAuthCoordinator.ts:41-45`), and `extension.ts:512-518` catches that into `SupabaseClient.setInitError` + `log.error`. This is an M6 defensive wrapper around code that cannot report failure. Zero test consumers.

**Proposal**

Delete `isSupabaseConfigured` from `src/auth/config.ts:84-93` and its import at `packages/extension/src/extension.ts:23`. At `extension.ts:470-473` drop the `if (!isSupabaseConfigured())` warn branch and un-nest the `else` body (the `SupabaseAuthProvider` construction and `registerAuthenticationProvider`/`registerUriHandler` calls) into the surrounding `try`, which already catches the real not-configured error. Behavior for a hypothetical blank-credential build is unchanged and strictly louder: an error log plus a retrievable init error instead of a warn that names a source file.

**What we give up**

A fork that blanks the credentials to placeholder strings loses a warn that names `src/auth/config.ts`; it still gets the `SupabaseClient.initialize` throw surfaced through `setInitError` and shown by `authCommands.ts:55`. Nothing else changes.

**Verifier corrections to the evidence above**

Two corrections. (a) "git log --oneline -30 -- src/auth confirms no commit has touched this guard" is wrong: `git log --all --oneline --grep=isSupabaseConfigured` returns commits that introduced and edited it, including a series titled "refactor: Remove user-configurable Supabase credentials" — which actually strengthens the case, since it dates the guard to the era when users supplied their own Supabase project, and `src/auth/config.ts` itself has been touched repeatedly since (fe8d59ff60 "consolidate auth configuration" #8894, 2d82c8138e relay removal, 5b02ff6293) without anyone revisiting it. (b) The claim says "zero test consumers" of the symbol, which is true, but note two tests do mock the neighboring `createHostAuthCoordinator` (src/test-kernel/auth/SupabaseAuthProvider.vitest.ts:88, src/test-kernel/cli/CliSupabaseAuth.vitest.ts:10); neither exercises the extension.ts branch, so neither is affected. Also worth naming in the issue: the construction the else-branch guards lives at packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:91, which is where the real not-configured throw originates.

<details><summary>Verifier reasoning</summary>

Survives. Independently confirmed: (1) `src/auth/config.ts:88-93` compares two same-file module-level literals — `url` from `SUPABASE_CUSTOM_DOMAIN = 'remote.texra.ai'` (:26,:31) and `publicKey = 'sb_publishable_DUIDjtxk12ZYYncrVUfwOw_xWQYsSvw'` (:34) — so it is a compile-time `true`; no script, CI workflow, or packaging step anywhere writes placeholder credentials (`rg "placeholder"` across scripts/, .github/, packages/_/src, src/auth turns up only the guard's own docstring). (2) Repo-wide grep gives exactly three hits: the definition plus `packages/extension/src/extension.ts:23,470`. Nothing in packages/extension/package.json, commands.ts, coreSettings.ts/stateSettings.ts, resources/ YAML, prompts/, supabase/functions/, tests, or config/ratchets/knip-baseline.json. (3) The empty-credential case really is handled elsewhere and louder: `SupabaseAuthProvider` (packages/extension/src/frontend/auth/SupabaseAuthProvider.ts:91) calls `createHostAuthCoordinator`, which wraps `SupabaseClient.initialize` (src/auth/SupabaseAuthCoordinator.ts:31-45) and rethrows the `!url || !publicKey` throw (src/auth/SupabaseClient.ts:169+) as "Supabase authentication is not configured", caught at extension.ts:512-518 into `SupabaseClient.setInitError` + `log.error`. This is a §15 M6 defensive wrapper, not a load-bearing M1-M5 fallback — deleting it makes a hypothetical blank build fail louder, not quieter. (4) No ruling protects it: `docs/proposals/2026-07-24-open-source-release.md:126-138` mandates a capability boundary with "no scattered OPEN_SOURCE conditionals" and a community build "free of Supabase initialization", so no planned fork ships placeholder credentials in this file. Nothing in AGENTS.md, CLAUDE.md, config/ratchets/, docs/dev/audits/. (5) Not a settled surface (no ratchet, not @agent/_, not src/agent/node, not the six browser-safe utils, not AgentEvent/SessionFact, not the CLI result-JSON contract consumed by texra-action). (6) Not filed: `gh issue list --search "isSupabaseConfigured"` and the tech-debt search return nothing. §14 R6 test passes: it removes one exported function, one import, and one dead branch — real element reduction, no relocation of complexity and no unrelated churn beyond the mechanical re-indent of the ~40-line else body, which the PR body should flag as R6-not-R5.

</details>

#### Delete StreamSnapshot.description — the retired sidecar mirror has no writer and no reader

- **Area**: `transcript` · **Kind**: expired-compat · **Risk**: low
- **Net**: -15 LoC, -1 elements

**Evidence**

src/shared/schemas/streamSnapshot.ts:132-138 declares `description: z.string().optional()` with the comment 'Legacy sidecar mirror only (#9590 Stage 6) ... Populated here only from a legacy sidecar that still holds the retired mirror field.' The retirement is complete on both ends, so the field is unreachable:

Writers: 0. The only production producer of a StreamSnapshot is assembleSnapshot (src/transcript/streamSnapshotRead.ts:244-270), and its StreamSnapshotSchema.parse call at :249 passes streamId, todos, plan, planSummary, outputFilesByRound, missingOutputsByRound, compileFailuresByRound, runUsage, executionId, parentStreamId — no description. Its input is StreamData, whose meta is StreamTabMeta, and StreamTabMetaSchema (src/shared/schemas/streamData.ts:37-44) has only schemaVersion, parentStreamId and executionId — the legacy sidecar description field is already gone from the read path. The only other parse site is the empty-fallback at streamSnapshotRead.ts:269.

Readers: 0 production. Repo-wide grep for `snapshot.description` / `snapshot?.description` (excluding node_modules) hits exactly two test assertions, both asserting it is undefined: src/test-kernel/transcript/StreamSnapshotStore.vitest.ts:1151 and src/test-kernel/cli/RunExecution.vitest.ts:620. The trace viewer, the one consumer that displays a run description, reads trace.meta?.description (packages/trace-viewer/src/replayTrace.ts:205), not the snapshot; its other snapshot reads are status, conversationProgress, runUsage, outputFilesByRound, missingOutputsByRound, compileFailuresByRound, todos, plan (replayTrace.ts:136, 219, 252-260).

The corresponding store-side retirement is documented at src/transcript/StreamSnapshotStore.ts:412-421 and :1386-1389 ('the legacy sidecar mirror was deliberately retired early'). The schema field is the leftover. Retired 2026-08-03 by #9667 (commit 3bf3658a56, 'refactor(transcript): stop duplicate description projection for current records').

**Proposal**

Delete the `description` field and its seven-line comment from src/shared/schemas/streamSnapshot.ts:132-138, and delete the two `expect(snapshot.description).toBeUndefined()` assertions (src/test-kernel/transcript/StreamSnapshotStore.vitest.ts:1151, src/test-kernel/cli/RunExecution.vitest.ts:620) — they pin retired behavior and go with it. StreamSnapshotSchema is a plain z.object (strip mode), so a legacy exported trace or sidecar that still carries the key parses fine and the key is dropped, exactly as today except the parsed value is no longer retained in memory. The fix lands in src/shared/schemas/, outside src/transcript/, but the field exists only to serve this area's assembly path.

**What we give up**

A legacy exported trace HTML written before 2026-08-03 that still carries snapshot.description would no longer round-trip that string into the parsed document. Nothing reads it today, and the viewer already takes its description from trace.meta.description, so there is no observable loss.

**Verifier corrections to the evidence above**

Two corrections. (1) The reader grep was under-specified: there are FOUR assertion sites, not two — the pattern `snapshot.description` missed the `snap.description` spelling. Full set: src/test-kernel/transcript/StreamSnapshotStore.vitest.ts:422, :1151, :2853, and src/test-kernel/cli/RunExecution.vitest.ts:620, each with a one-to-three-line explanatory comment above it (StreamSnapshotStore.vitest.ts:410-412 and RunExecution.vitest.ts:618-619) that goes stale with the assertion. (2) The schema comment at src/shared/schemas/streamSnapshot.ts:132-138 ('Populated here only from a legacy sidecar that still holds the retired mirror field') is stale, not merely dormant: StreamTabMetaSchema strips the key, so the sidecar read path can never populate it — the only remaining inbound path is TraceDocumentSchema parsing a legacy exported trace file. Also: the dedupe check missed the live-looking gate. docs/proposals/2026-08-03-ssot-consolidation-plan.md:109 and #9590's body schedule exactly this deletion as Stage 7 bullet 2, gated >=2026-11-01. That gate was waived by owner decision 2026-08-05 and executed early by PR #9755, so it does not block — but the issue body must cite #9755 and note that its completion grep reported 'none' while this field remained, or a reviewer will read the proposal as jumping a dated retirement queue.

<details><summary>Verifier reasoning</summary>

Survives. Writers = 0: assembleSnapshot (src/transcript/streamSnapshotRead.ts:244-270) is the only production producer of a StreamSnapshot (both store paths funnel through it — StreamSnapshotStore.ts:1821 and :1849) and never passes `description`; StreamTabMetaSchema (src/shared/schemas/streamData.ts:37-44) has no description key, so the disk read path cannot populate it — pinned today by src/test-kernel/transcript/StreamSnapshotStore.vitest.ts:2846-2853, which writes a legacy sidecar with `description: 'Prior session'` and asserts the assembled snapshot has none. Readers = 0 in production: the trace viewer reads trace.meta?.description (packages/trace-viewer/src/replayTrace.ts:205) with NO snapshot fallback, and its other snapshot reads are status/conversationProgress/runUsage/outputFilesByRound/missingOutputsByRound/compileFailuresByRound/todos/plan (replayTrace.ts:136, 219, 252-260); every other `description` hit in src/transcript/StreamSnapshotStore.ts is `record.description` on the in-memory StreamRecord projected into StreamSummaryMeta (:569-570, :1509, :2052, :2164), a different schema that is untouched. The one inbound path that could still set the field is TraceDocumentSchema (src/transcript/traceDocumentSchema.ts:27) parsing a legacy exported trace, and nothing reads it there either. Dated-ruling check nearly refuted this and then did not: docs/proposals/2026-08-03-ssot-consolidation-plan.md:109 gates #9590 Stage 7 at >=2026-11-01 and #9590's body lists 'remove the read-only sidecar description mirror and fallback' as Stage 7 bullet 2 plus a completion-condition grep for 'the snapshot description mirror or fallback' — but the gate was explicitly waived by owner decision on 2026-08-05 and Stage 7 executed early in PR #9755 ('refactor(storage): execute #9590 Stage 7 early'), after which #9590 was closed COMPLETED and #9627's ledger records '#9755 executed #9590 Stage 7 ... #9590 is now fully resolved'. #9755's acceptance section asserts 'snapshot description mirror or fallback -> none'; this schema field is precisely the residue that grep missed, so the item is neither gated nor filed (#9590 and #9627 are both CLOSED, no open row anywhere covers it; no docs/proposals or config/ratchets entry defends the field). Not a settled surface: it is not one of the five ratchets, not a PocketFlow/engine or platform-composition edge, not a browser-safe @utils module, not the AgentEvent/SessionFact split, and not the CLI result-JSON contract consumed by texra-action. Not a masking fallback under checklist §15 — the load-bearing degradation here is assembleSnapshot's catch, which is untouched. Real element reduction (one schema field + one stale comment block + four now-unrepresentable test assertions), no relocation, no forced unrelated churn. One caution: #9755 deliberately kept the description-absence assertions as current-behavior pins; deleting the field removes those pins but makes the invariant unrepresentable in the type, which is strictly stronger — the issue should say so rather than presenting the test deletions as incidental.

</details>

#### Fold the one-root discoverSkills loader into discoverSkillSources and delete its duplicate dedup pass

- **Area**: `common-housekeeping` · **Kind**: dead-export · **Risk**: medium
- **Net**: -12 LoC, -3 elements

**Evidence**

`src/skills/loadSkills.ts:81` `discoverSkills` and `src/skills/loadSkills.ts:26` `DiscoverSkillsResult` are both already listed in `config/ratchets/knip-baseline.json` as `{file: src/skills/loadSkills.ts, category: production-dead, kind: exports/types}` — i.e. the ratchet already knows only tests consume them. Grepped consumers (`rg -n 'discoverSkills|DiscoverSkillsResult' src packages docs`): production = 1, and it is in the same file (`src/skills/loadSkills.ts:198`, inside `discoverSkillSources`); non-production = 7 (`src/test-kernel/skills/LoadSkills.vitest.ts:7,47,65,81,104,125,145`) plus one docs mention (`docs/prds/2026-05-14-skills.md:100`). Zero hits in `packages/cli`, `packages/extension`, `packages/desktop`, `packages/agent`. The function's own docstring at `src/skills/loadSkills.ts:175-179` states the speculative-generality case out loud: "The one-root loader remains useful for tests and direct imports." Second half of the finding: the two functions keep two copies of the same dedup fact. `discoverSkills` owns `seenNames`/`seenRealPaths` at `:86-87` and applies them at `:124-128` and `:134-139`; `discoverSkillSources` owns its own pair at `:186-187` and applies them at `:211-222`. Because the outer sets accumulate across every source (including within a single root), the inner pair is redundant — and the outer issues are strictly richer, since `dupRealpathIssue` is called with the skill `name` at `:212` but without it at `:125`.

**Proposal**

Replace `export async function discoverSkills` with a file-local `scanSkillRoot(root)` that returns `{ entries: {skill, realPath}[], errors }` and carries no `seenNames`/`seenRealPaths` sets, letting `discoverSkillSources` remain the single dedup owner. Delete the `DiscoverSkillsResult` export and the `DiscoveredSkill` wrapper if the tuple suffices, and drop the two `src/skills/loadSkills.ts` rows from `config/ratchets/knip-baseline.json`. Retarget the six `discoverSkills(root)` cases in `src/test-kernel/skills/LoadSkills.vitest.ts` onto `discoverSkillSources([{ scope: 'project', path: root }])` — same assertions, one extra literal per call.

**What we give up**

The ability to import a single-root skill loader from outside the module (no production caller exists today). One real behavior change: a skill directory that symlinks to an already-seen `SKILL.md` inside the _same_ root would now be read by `loadSkillDirectory` before being dropped by the outer realpath check, instead of being skipped before the read. That is one extra small file read in a rare case, and the emitted issue gains a `name` field.

**Verifier corrections to the evidence above**

Consumer count and baseline rows confirmed as claimed. Corrections: (1) the inner/outer dedup passes are not duplicates — src/skills/loadSkills.ts:124-128 runs pre-load, :211-222 runs post-load, so removing the inner realPath set surfaces extra `name_mismatch` warnings (src/skills/skillLoader.ts:83-91) to users via packages/cli/src/runtime/skills.ts:51 and doubles the SKILL.md read; only the inner `seenNames` block at :134-139 is truly redundant. (2) `dupRealpathIssue`'s optional `name` is structural (no name exists pre-load), not a poorer variant. (3) `git log --all --grep=discoverSkills` is empty and `gh issue list --search "discoverSkills"` returns only unrelated closed #7777 — dedupe check holds. (4) packages/agent/dist/types/src/skills/loadSkills.d.ts:28 exposes `discoverSkills` in built declaration output, but packages/agent/src never references it, so it is not part of the fenced SDK surface.

<details><summary>Verifier reasoning</summary>

The dead-export half survives independent verification; the "duplicate dedup pass" half is materially wrong and the LoC is inflated.

VERIFIED (my own greps, `rg -uu` including gitignored files, plus dist bundles):

- `discoverSkills` (src/skills/loadSkills.ts:81) and `DiscoverSkillsResult` (:26) have exactly one production consumer, in the same file at src/skills/loadSkills.ts:198 inside `discoverSkillSources`. All other source hits are src/test-kernel/skills/LoadSkills.vitest.ts:7,33,47,65,81,104,125,145 and docs/prds/2026-05-14-skills.md:100. Zero hits in packages/cli/src, packages/extension/src, packages/desktop/src, packages/agent/src, prompts/, supabase/functions/, packages/extension/resources/, packages/extension/package.json, packages/extension/src/commands.ts, src/shared/schemas/coreSettings.ts, stateSettings.ts. The real host consumers (packages/cli/src/runtime/skills.ts:8, packages/cli/src/chat/tui/forms/SkillsListForm.tsx:14, src/test-kernel/cli/SkillsListForm.vitest.ts:7) import only `discoverSkillSources`/`SkillSource`/`SourcedSkill`.
- Not a settled surface: packages/agent/src contains no reference to loadSkills at all; the `discoverSkills` line in packages/agent/dist/types/src/skills/loadSkills.d.ts is emitted transitive declaration output, not a fenced SDK export. Nothing here touches the five ratchets, the PocketFlow engine, the browser-safe @utils set, the AgentEvent/SessionFact split, or the CLI result-JSON contract.
- Not already done: `git log --oneline -12 -- src/skills/loadSkills.ts` shows only broad sweeps (#9990, #9519, #9472, #7616); `git log --all --grep=discoverSkills` is empty; both knip-baseline rows are live at config/ratchets/knip-baseline.json:2183-2194.
- Not already filed: `gh issue list --label tech-debt --state all --search "skills loader"` empty; `--search "discoverSkills"` returns only the unrelated closed #7777; `--search "skills dedup loader"` empty. No ruling in docs/proposals, docs/architecture, docs/dev/audits, AGENTS.md, or CLAUDE.md defends the one-root export; the PRD line at docs/prds/2026-05-14-skills.md:100 merely records the original spec, and the ratchet already classifies the export as production-dead.

CORRECTION THAT MATTERS: the two dedup passes are not the same fact. `discoverSkills` checks `seenRealPaths` BEFORE calling `loadSkillDirectory` (src/skills/loadSkills.ts:124-128, load at :131), whereas `discoverSkillSources` dedups AFTER the load (:211-222). Deleting the inner realPath set as proposed makes a within-root symlink duplicate get parsed: its own load issues are pushed into `errors` at :196 before the outer dedup ever sees it — most notably the `name_mismatch` warning at src/skills/skillLoader.ts:83-91, which fires whenever a symlink directory's name differs from the target's frontmatter name (the normal case). Those issues are user-visible (packages/cli/src/runtime/skills.ts:51 `formatCliSkillIssue`, src/skills/runtimeSkills.ts:77). So the proposal's "same assertions, one extra literal per call" is false for the symlink test at LoadSkills.vitest.ts:104-127, and the optional `name` param on `dupRealpathIssue` is not an oversight — the pre-load call site has no name yet, by construction. Only the inner NAME dedup (:134-139) is genuinely redundant. The scoped, correct version is: unexport `discoverSkills` into a file-local `scanSkillRoot`, drop `DiscoverSkillsResult`, drop only the inner `seenNames` pair, and KEEP the pre-load realpath guard.

</details>

#### Delete four zero-consumer surfaces left behind in src/controllers/settingsView

- **Area**: `controllers-rest` · **Kind**: dead-export · **Risk**: low
- **Net**: -8 LoC, -4 elements

**Evidence**

(a) `SettingsModelSelectionController.setHelperModel` — src/controllers/settingsView/SettingsModelSelectionController.ts:132-134. Public async method, **zero references repo-wide**: `rg --no-ignore-vcs -g '!dist' -g '!*.js' -n "setHelperModel" src packages docs scripts config` returns exactly one hit, its own declaration (the `--no-ignore-vcs` form matters here: docs/proposals/2026-08-19-dead-code-gate-blind-spots.md records that the machine's global gitignore hides `*gpt*`/`*sonnet*` source files from plain rg). Production consumers 0, test consumers 0. It was orphaned by b741de9876 (2026-08-18, "route scalar settings writes through the catalog"), which deleted the `SettingsViewHost.setHelperModel` wrapper and the SettingsViewMessageHandler call and left the controller method standing — `git show b741de9876 -- packages/extension/src/settingsView/SettingsViewMessageHandler.ts | grep setHelperModel` shows the removed `this.settingsHost.setHelperModel(message.modelName, {…})` call. The live writer for the same fact is the settings catalog path: packages/extension/src/settingsView/frontend/components/profile/ModelSelectionList.ts:112 `postStateSetting(GlobalStateKey.HELPER_MODEL, readSelectValue(e))`, against the catalog row at src/shared/schemas/stateSettings.ts:1350-1351. So this is a second, dead writer to a persisted setting that already has one owner.
(b) `SettingsViewHostMutationOptions.afterUpdate` — src/controllers/settingsView/SettingsViewHost.ts:41, awaited at :162. Zero passers: `rg --no-ignore-vcs -n "afterUpdate"` over src+packages returns only the declaration and the call site; both hosts pass only `afterPost` (packages/desktop/src/main/desktopSettingsIpc.ts:218, packages/extension/src/settingsView/SettingsViewMessageHandler.ts:779). Production 0, test 0.
(c) `SettingsViewHostOptions.controllers.memory` — src/controllers/settingsView/SettingsViewHost.ts:35, consumed at :51 (`options.controllers?.memory ?? new SettingsMemoryController({…})`). Zero passers anywhere: desktop passes only `modelSelection` (desktopSettingsIpc.ts:128-132), the extension passes no `controllers` block at all (SettingsViewMessageHandler.ts:137-143), and src/test-kernel/controllers/SettingsViewHost.vitest.ts:50-52 passes only `modelSelection`. Production 0, test 0. Same species as the already-landed #11013 ("Delete six injection seams with zero production passers", merged in d56d39c7c2) — this one was simply missed.
(d) `export interface SettingsTeamRosterPresentation` — src/controllers/settingsView/SettingsTeamRosterController.ts:22, referenced only at :35 in the same file. `rg --no-ignore-vcs -n "SettingsTeamRosterPresentation" src packages` returns its declaration, its one self-reference, and config/ratchets/knip-baseline.json:1880. It is a baselined `unused/types` row that can leave the baseline.

**Proposal**

One PR: delete `setHelperModel` (SettingsModelSelectionController.ts:132-134); delete the `afterUpdate` field (SettingsViewHost.ts:41) and its `await options?.afterUpdate?.();` line (:162); delete the `memory?` slot (SettingsViewHost.ts:35) and collapse :50-51 to an unconditional `new SettingsMemoryController({…})`; drop the `export` keyword on `SettingsTeamRosterPresentation` (SettingsTeamRosterController.ts:22) and remove its row from config/ratchets/knip-baseline.json (baseline shrinks, never widens). Nothing replaces any of them: the helper-model write already goes through `postStateSetting` → the stateSettings catalog, and `afterPost` covers the one post-write hook the hosts actually use.

**What we give up**

A host that later wants to run a callback _between_ the model-selection write and the re-post would have to re-add `afterUpdate`; a host that wants to supply its own `SettingsMemoryController` would have to re-add the `memory` slot. Both are one-line re-adds if a passer ever appears. Nothing user-visible changes.

**Verifier corrections to the evidence above**

Two corrections. (1) The claim's ratchet-row deletion for (d) is 5 JSON lines, not counted in production LoC; and §3.1 of `docs/proposals/2026-08-25-cli-controller-seam-audit.md` did NOT "explicitly exclude already-baselined symbols" as an out-of-scope rule — it counted them ("Of those, 14 are already in `config/ratchets/knip-baseline.json`") and then narrowed to the 12 non-baselined ones as "the cleanest sub-batch". So (d) was a knowingly-deferred row, not an oversight. (2) The strongest supporting citation is missing from the claim: `docs/proposals/2026-08-15-shared-contracts-and-retirement.md:533-536` names inline `options?: {…}` bags as an unswept follow-up seam, which is exactly what (c) is. Everything else in the claimed evidence reproduced exactly, including the `git log --all --grep="setHelperModel"` hit on `b741de9876` and all three `new SettingsViewHost(` construction sites.

<details><summary>Verifier reasoning</summary>

I re-derived all four independently and could not break any of them.

(a) `setHelperModel` — `rg --no-ignore-vcs -n "setHelperModel" . --glob '!dist' --glob '!*.js'` returns exactly one line: `src/controllers/settingsView/SettingsModelSelectionController.ts:132`. No wire command exists to route to it: `grep -rn "SET_HELPER" src packages --include='*.ts' --exclude-dir=dist` is empty, and there is no dynamic dispatch (`settingsHost[...]` / `modelSelectionController[...]` both return nothing). The live writer is confirmed: `packages/extension/src/settingsView/frontend/components/profile/ModelSelectionList.ts:112` `postStateSetting(GlobalStateKey.HELPER_MODEL, readSelectValue(e))` against the catalog row `src/shared/schemas/stateSettings.ts:1349-1351` (`surfacedSetting({ key: GlobalStateKey.HELPER_MODEL, schema: z.string().min(1).prefault(DEFAULT_HELPER_MODEL) … })`). Second dead writer to a single-owner persisted setting — confirmed. Orphaning commit `b741de9876` confirmed via `git log --all --grep="setHelperModel"`.

(b) `afterUpdate` — grep over src+packages minus dist returns exactly two lines: `src/controllers/settingsView/SettingsViewHost.ts:41` (declaration) and `:162` (`await options?.afterUpdate?.();` inside `postModelSelectionMutation`). Zero passers. `Awaitable` stays alive via `afterPost`, so no cascade.

(c) `controllers.memory` — I enumerated every `new SettingsViewHost(` site: three total. `packages/desktop/src/main/desktopSettingsIpc.ts:126-132` passes `controllers: { modelSelection: … }` only; `packages/extension/src/settingsView/SettingsViewMessageHandler.ts:137-143` passes no `controllers` block at all; `src/test-kernel/controllers/SettingsViewHost.vitest.ts:38-53` passes `controllers: { modelSelection }` only. The `memory?` slot has zero passers in production and test. `MemoryControllerOptions` survives via `memoryPrompt`, and the `controllers` bag survives via `modelSelection`, so the collapse is local — no unrelated churn.

(d) `SettingsTeamRosterPresentation` — three hits total: declaration `SettingsTeamRosterController.ts:22`, self-reference `:35`, and `config/ratchets/knip-baseline.json:1877-1881` (`"category": "unused", "kind": "types"`). Un-exporting plus removing that row shrinks the baseline, which is the sanctioned direction ("never widen a baseline"), not a settled-surface collapse.

Not already done: `git log --oneline -15 -- src/controllers/settingsView/` shows the orphaning commit and no later cleanup; the open PR #11412 ("source the active team from the roster") touches `SettingsAgentCatalogController.ts` and the roster/team modules but NOT `SettingsTeamRosterController.ts`, `SettingsViewHost.ts`, or `SettingsModelSelectionController.ts`, so there is no collision.

Not already filed: `gh issue list --state all --search "setHelperModel"` and `--search "SettingsTeamRosterPresentation"` are both empty; the `SettingsViewHost` search returns #9426/#8480/#6972/#8744/#8425/#8428/#8424/#7745/#6953/#10674, none naming these. #10674 is CLOSED/COMPLETED and enumerates a _different_ Tier-2 six (`ifUnset`, `shouldFilter`, `truncationMarker`, `resolveWorkspaceRoot`, `kickerIcon`, `canvas`).

No ruling defeats it — the opposite. `docs/proposals/2026-08-15-shared-contracts-and-retirement.md:533-536` closes the Tier-2 section with "(The sweep covered optional fields on `*Options` interfaces; inline `options?: {…}` bags and required-but-unread fields were not systematically swept — a follow-up seam.)" `controllers?: { memory?: … }` is precisely that inline nested bag, so (c) lands in an explicitly-owed follow-up. `docs/proposals/2026-08-25-cli-controller-seam-audit.md` §3.1 scoped to `export` keywords only ("all 193 exports in `src/controllers/**`"), so a method (a) and two option fields (b,c) were never in its corpus. Not a settled surface, not a catch/fallback (§15 M1-M6 does not apply — `postModelSelectionMutation` masks nothing), no CLI result-JSON contact.

One honest caveat on (d): §3.1 states "found 44 with no production consumer. Of those, 14 are already in `config/ratchets/knip-baseline.json`." `SettingsTeamRosterPresentation` is one of those 14 — knowingly seen and deferred by that audit, not missed. It is not a filed duplicate, but it is already registered in the gate and contributes 0 production LoC, so it should ride along as the cheap tail of the PR rather than be sold as the finding.

</details>

#### Drop the never-read `issues: z.array(z.custom<ZodIssue>())` from ValidationErrorDiagnosticsSchema

- **Area**: `shared-schemas` · **Kind**: dual-representation · **Risk**: low
- **Net**: -6 LoC, -2 elements

**Evidence**

Declaration: `src/shared/schemas/toolResult.ts:75` `issues: z.array(z.custom<ZodIssue>()),` inside `ValidationErrorDiagnosticsSchema` (`:73-77`), beside `formatted: z.array(FormattedZodIssueSchema)` (`:76`). It forces the `type ZodIssue` import at `src/shared/schemas/toolResult.ts:1` and a 3-line justification comment at `:70-72` ("`issues` stays `z.custom<ZodIssue>()` since `ZodIssue` is Zod's own internal type with no exported schema"). PRODUCERS (production, 2): `src/tools/core/base.ts:77` `issues: err.issues,` and `src/agent/core/flows/toolCallParsing.ts:131` `issues: error.issues,` — both set `formatted: formatZodIssuesForDiagnostics(...)` on the very next line from the same `error.issues`, so `formatted` is a total function of `issues`. READERS of the field: 0 production, 0 test-kernel. The single production consumer of the payload, `src/agent/core/tools/toolAttachmentExtraction.ts:65-70`, does `ValidationErrorDiagnosticsSchema.safeParse(value)` then `const { type, formatted } = validationError.data; sanitizedResult[key] = { type, formatted };` — it explicitly drops `issues` before the result reaches the model. The other diagnostics site, `src/shared/toolUse.ts:37`, destructures `diagnostics: _diagnostics` and discards it. `rg -n 'diagnostics\.issues' src packages` → 0 hits; `rg -n 'issues' src/test-kernel | rg 'diagnostics|DIAGNOSTIC'` → 0 hits. Fix spans outside `src/shared/schemas/` (2 one-line deletions in `src/tools/` and `src/agent/`).

**Proposal**

Delete the `issues` field from `ValidationErrorDiagnosticsSchema` (`toolResult.ts:75`), drop `type ZodIssue` from the `zod` import (`:1`), and trim the now-stale sentence in the schema docstring (`:70-72`). Delete the two producer lines `src/tools/core/base.ts:77` and `src/agent/core/flows/toolCallParsing.ts:131`. `formatted` (path/message/expected/received/code per `FormattedZodIssueSchema`, `toolResult.ts:56-62`) remains the single representation, which is already the only one that survives sanitization. This also removes the file's only `z.custom<>()` escape hatch; the remaining one (`toolDefinition.ts:24`) stays, it is live.

**What we give up**

The raw `ZodIssue[]` on an in-process validation-error diagnostics payload. Nothing reads it today and the sanitizer strips it before the payload reaches the model or any host, so no rendered or model-visible behavior changes. A future consumer wanting structured issues would use `formatted`, which already carries path/message/expected/received/code.

**Verifier corrections to the evidence above**

Two corrections.

1. The claim that the field "forces the `type ZodIssue` import at `src/shared/schemas/toolResult.ts:1`" is false, and the proposal step "drop `type ZodIssue` from the `zod` import" would not compile. `ZodIssue` is independently required by `formatZodIssuesForDiagnostics` in the same file — `src/shared/schemas/toolResult.ts:104` (`issues: ZodIssue[],`) and `:107` (`const extendedIssue = issue as ZodIssue & {`) — a function with two live callers (`src/tools/core/base.ts:78`, `src/agent/core/flows/toolCallParsing.ts:131`). Line 1 stays exactly as it is. The claim's related note that this "removes the file's only `z.custom<>()` escape hatch" is correct (`rg -n 'z\.custom' src/shared/schemas/toolResult.ts` → only `:75`), and `toolDefinition.ts:24` is indeed live.

2. Producer line number: `formatted:` is at `toolCallParsing.ts:131`, so the `issues: error.issues,` line to delete is `:130`, not `:131`. In `base.ts` the line is `:77` as claimed.

Everything else in the evidence checks out: declaration at `:75`, docstring sentence at `:69-71`, `FormattedZodIssueSchema` at `:56-62`, the drop site at `toolAttachmentExtraction.ts:65-70`, and the discard at `src/shared/toolUse.ts:37`.

<details><summary>Verifier reasoning</summary>

Independently verified and it survives, with one evidence error corrected.

Zero readers confirmed. `rg -n '\.diagnostics\b' src packages` returns only unrelated sites (`src/tools/lean/*`, `AnthropicStreamHandler`, `packages/extension/src/frontend/review/*`, `src/utils/diagnostics/diagnosticFormatting.ts`) — none touch a validation-error payload. Destructuring form (`diagnostics,` / `diagnostics }`) gives only the two producer sites (`src/tools/core/base.ts:90`, `src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts:326,330`) and `src/shared/toolUse.ts:37` which discards it as `_diagnostics`.

Producers are exactly two, both writing `issues` and `formatted` from the same `error.issues`: `src/tools/core/base.ts:77` and `src/agent/core/flows/toolCallParsing.ts:130`. `rg "DIAGNOSTIC_TYPE_VALIDATION_ERROR|'validation_error'"` finds no third producer in `src`, `packages`, `packages/extension/resources/`, `prompts/`, or `supabase/functions/`.

I traced the full data path, which the claim only asserted. Every route out of a `ToolResult` goes through `extractToolAttachments` (`src/agent/core/tools/toolAttachmentExtraction.ts:65-70`), which rebuilds the payload as `{ type, formatted }`: the model-facing follow-up uses `execResult.extracted.sanitizedResult` (`ToolUseDispatchNode.ts:595`, `:269`), and the progress/transcript log uses it too (`ToolUseDispatchNode.ts:469` `const { status: _status, ...logOutputBase } = extracted.sanitizedResult`). The unsanitized `result` is read only for `result.files` (`:489`), `result.edits`/`lineChanges` (`:430-440`), `endTurn` (`:76`), and the duplicate fan-out (`:249-268`, which forwards the primary's already-sanitized result). So `issues` reaches neither the model, the logs, nor persisted transcripts today — no debuggability is lost by deleting it.

Not already done, not filed, not deliberately ruled on. `git log -S"issues: z.array(z.custom" -- src/shared/schemas/toolResult.ts` → introduced by #8977, whose message says only that `ToolResult.diagnostics` itself stays `z.unknown()`; it never justifies keeping `issues` (it merely transcribed the pre-existing hand-written interface into Zod). `gh issue list --label tech-debt --state all --search "diagnostics issues formatted validation"` → 0 rows; `gh issue list --state all --search "ZodIssue z.custom"` → 0 rows. No hit in `docs/`, AGENTS.md, CLAUDE.md, or `config/ratchets/`. It touches no settled surface: not a ratchet, not the frozen `@agent/*` SDK surface, not `src/agent/node/index.ts`, not the AgentEvent/SessionFact split, not the browser-safe `@utils` set, not the CLI result-JSON contract consumed by texra-ai/texra-action.

No fallback/masking site is involved (checklist §15 N/A): the schema is strip-mode, so `safeParse` of an old payload that still carries `issues` keeps succeeding, and the two partial-match tests (`WorkflowScriptTool.vitest.ts:488,659` and `DiagnosticsTool.vitest.ts:82` use `toMatchObject`) stay green. No unrelated churn is forced.

The one claim I refute is the LoC accounting, not the candidate.

</details>

#### Drop the dead `checkToolInstalled('sox')` probe — TOOL_CONFIGS has no sox row, so it always returns false

- **Area**: `utils` · **Kind**: defensive-machinery · **Risk**: low
- **Net**: -5 LoC, 0 elements

**Evidence**

src/utils/system/toolUtils.ts:101-154 defines TOOL_CONFIGS with 19 rows (magick, gm, perl, gs, wolframscript, latexdiff, latexdiff-vc, latexindent, tex-fmt, texcount, latexmk, pdflatex, xelatex, lualatex, bibtex, biber, pandoc, texra, texra-local). There is no `sox` row. src/utils/system/toolUtils.ts:267-274: `const config = TOOL_CONFIGS[toolName]; if (!config) { if (showError) await reportMissingTool(...); return false; }`. The only caller passing 'sox' is src/tools/media/audio.ts:58, `if (!(await checkToolInstalled('sox', false)))` — with showError false it silently returns false every time, so the branch is always entered. Inside it (audio.ts:59-66) the real decision is made by `resolveSoxCommand()` (audio.ts:36-44, which goes through BinaryResolver): missing → error return, found → `log.warn('Sox check failed but found at: ...')` fires on every single recording start. So the probe changes nothing and emits a permanent false warning. Production consumers of the 'sox' string as a tool name: 1 (that call). Non-production: 0 (`rg "'sox'"` over src/test-kernel returns nothing). Every other checkToolInstalled call site passes a name that exists in TOOL_CONFIGS or goes through src/tools/setup/toolProbing.ts:35 `locateTool`, whose doc block (:29-32) explicitly designs for names without a config entry by OR-ing in a PATH search — audio.ts is the one site that does not.

**Proposal**

In src/tools/media/audio.ts, delete the `checkToolInstalled('sox', false)` call, its import, and the `log.warn('Sox check failed but found at: ...')` line, reducing lines 57-66 to `if (!soxCommand) return { success: false, error: 'Sox is required for audio recording. Please install it first.' };`. The utils side stays as is. If the registry-miss path is worth hardening at all, the right shape is a loud `log.warn` in toolUtils.ts:269 naming the unknown tool, so the next typo'd probe name is not silent — but that is an add, not part of this deletion. The fix lands in src/tools/media/audio.ts, outside src/utils/; the evidence for it is the utils-side registry.

**What we give up**

Nothing observable. The probe's only effects today are a constant-false result and a misleading warn line; sox availability is and remains decided by BinaryResolver.

**Verifier corrections to the evidence above**

Core claim verified. Corrections: (1) Net LoC is about -5, not -9: src/tools/media/audio.ts:58-67 is 10 lines (the claim cited 57-66) and collapses to a 6-line `if (!soxCommand) { return { success: false, error: 'Sox is required for audio recording. Please install it first.' }; }` — the error string fits one line at the reduced indent — plus one removed import line. (2) The claim's "Non-production: 0" is wrong: src/test-kernel/utils/system/SystemUtils.vitest.ts:468-473 does contain 'sox', but it exercises `BinaryResolver.resolveOptionalCommand('sox')`, not `checkToolInstalled`, so nothing pins the probe and the conclusion is unaffected. (3) Added evidence the claim lacked: TOOL_CONFIGS is a module-local `const` at src/utils/system/toolUtils.ts:101 that is never mutated — the only other references are the read at :267 and `TOOL_CONFIGS[tool]?.openDocsCommand` at :394 — so no runtime registration can ever supply a 'sox' row. (4) `git log --all -S "sox: withDocs"` and `-S "  sox:"` on toolUtils return nothing: the row was never present and later deleted, so this is vestigial code from #2956's reshaping, not a regression from a removed entry. (5) The probe removal is not a fallback deletion under checklist §15: the load-bearing check (`resolveSoxCommand()` via BinaryResolver, honoring `texra.audio.soxPath`) and the missing-sox error return both survive untouched; only the unconditional `log.warn('Sox check failed but found at: ...')` disappears. (6) audio.ts is live, not dead: `startRecording` is consumed by packages/extension/src/frontend/media/RecordingManager.ts:41 and packages/desktop/src/main/desktopAgentExecution.ts:96.

<details><summary>Verifier reasoning</summary>

Survives. `checkToolInstalled('sox', false)` is provably dead: src/utils/system/toolUtils.ts:101-163 defines TOOL_CONFIGS with no `sox` key, the object is a module-local const with no mutation site anywhere in the repo (only reads at :267 and :394), and :267-274 returns false for an unknown name with showError=false silently. So the branch at src/tools/media/audio.ts:58 is always entered and the block reduces exactly to `if (!soxCommand) return error;` plus a `log.warn` that fires on every successful recording start with misleading text ("Sox check failed but found at: ..."). Consumer sweep with a word-boundary grep for `sox` across src/, packages/, docs/, config/, prompts/, supabase/, scripts/ (excluding node_modules and build output) finds exactly one production use of the string as a tool name — audio.ts:58 — with the other hits being the `texra.audio.soxPath` setting (src/tools/setup/ConfigTools.ts:45-48, src/shared/schemas/coreSettings.ts:397), BinaryResolver test coverage, prose in packages/extension/resources/tool_use_agents/setup.yaml:154, and generated bundles under packages/cli/.texra-validate-run and packages/extension/resources/traceViewer. No VS Code command ID, no wire string, no YAML/settings key depends on it. `checkToolInstalled` keeps many other callers (src/tools/setup/toolProbing.ts:35, src/tools/wolfram/wolframScriptUtils.ts, latex paths), so no dead-export or knip-baseline churn follows, and the utils side is untouched. Not already done (git log on src/tools/media/audio.ts shows only #10005 logger migration, #9951, #9827, #9216) and not already filed (`gh issue list --state all --search "sox"` and `--search "checkToolInstalled"` both empty, with gh verified working). No dated ruling defends it: no docs/ file mentions checkToolInstalled, and the audio.ts mentions in docs/proposals/2026-08-15-lifecycle-ownership.md:179,:370 and docs/proposals/2026-08-15-shared-contracts-and-retirement.md:847 concern subprocess teardown and extension registrations, not the probe. None of the five ratchets, the frozen @agent/* surface, the PocketFlow engine, the host/platform composition root, the six browser-reachable utils, or the AgentEvent/SessionFact split is involved. Under §14 R5/R6 and §13 it is a true element reduction with no relocation of complexity and no forced unrelated churn; under §15 it deletes no load-bearing fallback — the real capability check (BinaryResolver plus the soxPath override) and the missing-sox error path both remain. It is small (about -5 LoC in one file), but it removes a permanently-false conditional and a misleading warning that fires on every recording, which clears the bar for a bounded issue.

</details>

#### Un-export 11 interfaces in src/latex and src/model that have zero consumers anywhere

- **Area**: `latex-replacement-model` · **Kind**: dead-export · **Risk**: low
- **Net**: 0 LoC, -11 elements

**Evidence**

Scripted export scan + per-symbol `rg -l "\bNAME\b" src packages` confirms each of these appears in exactly ONE file — its own definition site — with production consumers = 0, src/test-kernel consumers = 0, docs/scripts = 0: src/latex/formatter/texFormatter.ts:9 `LatexFormatter`; src/latex/texcount.ts:45 `TexcountResult`; src/latex/latexdiff/diffFileNameManager.ts:15 `GeneratedLatexdiffArtifact` and :142 `VersionControlDiffFilename`; src/latex/extractBibliography.ts:30 `BibliographyReferenceResult` and :39 `BibliographyEntriesResult`; src/latex/criticismParser.ts:14 `CriticismAnnotation`; src/model/providerCapabilities.ts:35 `ProviderCapabilityKey`; src/model/signedInProbe.ts:16 `SignedInProbeSlot`; src/model/runModelDecision.ts:31 `RunModelDecision`; src/model/modelListRefresh.ts:27 `ModelListRefreshResult`. None of the 11 appears in config/ratchets/knip-baseline.json (knip does not flag a type that its own file references), so these are NEW dead exports, not grandfathered ones. Verified safe to un-export: no tsconfig in the repo sets `declaration`, and `rg '@latex/|@model/' packages/agent/src` returns zero hits, so none of these types crosses the frozen @texra-ai/agent surface. Deliberately EXCLUDES `TeXCountStat` (texcount.ts:279), `AcceptedFileTarget` (acceptedFileTarget.ts:16) and `LatexdiffExecutionResult` (runLatexdiff.ts:83) — those three are already named leads in docs/proposals/2026-08-07-prod-structural-leads-triage.md:107,120,215.

**Proposal**

Drop the `export` keyword from all 11 interface declarations (each is still referenced by its own module, so the declaration itself stays). Where the interface is only a return/parameter shape used once — `GeneratedLatexdiffArtifact`, `VersionControlDiffFilename`, `BibliographyReferenceResult`, `BibliographyEntriesResult` — inline the object type at the signature and delete the declaration outright. One PR, one file per module, no behavior change and no test edits (zero test-kernel consumers).

**What we give up**

Nothing at runtime. A future external caller that wants to name one of these shapes would have to re-export it — which is exactly the 'exports are contracts, add the export with its consumer' rule in AGENTS.md.

**Verifier corrections to the evidence above**

Two corrections. FIRST, the safety argument is wrong on its facts: tsconfig.build.json:4 DOES set `"declaration": true` with `"emitDeclarationOnly": true`, and although its `include` is only packages/agent/src, these files are pulled into that graph transitively (src/agent/runtime/helperModelPreference.ts, src/agent/implementations/flows/reflection/output/LatexDiffManager.ts and 8 more import @latex/* or @model/*), which is why packages/agent/dist/types/src/latex/extractBibliography.d.ts and .../src/model/providerCapabilities.d.ts exist today. The conclusion nonetheless holds, for a different reason: TypeScript emits a referenced but non-exported interface as a local declaration in the .d.ts rather than erroring (TS4023 does not apply to a same-file named type), and the emitted tree already contains that exact pattern — packages/agent/dist/types/src/model/runtimeModelRegistry.d.ts:9,14 and .../src/skills/loadSkills.d.ts:5 are bare `interface` declarations. So the change is declaration-emit safe, but not for the stated "no tsconfig sets declaration" reason. SECOND, the inlining half of the proposal should be dropped, which zeroes the LoC claim. BibliographyReferenceResult and BibliographyEntriesResult carry per-field JSDoc (extractBibliography.ts:31-37, :40-43) and GeneratedLatexdiffArtifact / VersionControlDiffFilename are the named nullable return shapes of two deliberately-contrasted public helpers (diffFileNameManager.ts:118-124 and :146-155 carry doc comments explaining why the two parsers differ); inlining them into `Promise<{...}>` / `{...} | null` signatures relocates the lines rather than deleting them and discards documented named result shapes. It also contradicts the accepted scope of the precedent, which #11386 states explicitly: "Drop the `export` keyword only. No file moves, no signature changes, no behavior change." Also minor: RunModelDecision does have one docs hit the claim reported honestly (docs/proposals/2026-07-12-fallback-audit.md:1008 proposes deepening it into a ModelRouteDecision) — a design note, not a consumer, and it does not block un-exporting.

<details><summary>Verifier reasoning</summary>

Survives, with two corrections. (1) I re-ran the greps myself, repo-wide (rg over the whole tree, .gitignore-respecting, so packages/extension/package.json, packages/extension/resources/, prompts/, supabase/functions/, docs/ and scripts/ were all in scope). Every one of the 11 symbols appears in exactly one file — its own — with only same-file references: src/latex/formatter/texFormatter.ts:9 LatexFormatter (used :17, :35); src/latex/texcount.ts:45 TexcountResult (:227); src/latex/latexdiff/diffFileNameManager.ts:15 GeneratedLatexdiffArtifact (:125) and :142 VersionControlDiffFilename (:158); src/latex/extractBibliography.ts:30 BibliographyReferenceResult (:48) and :39 BibliographyEntriesResult (:148); src/latex/criticismParser.ts:14 CriticismAnnotation (:57,:60); src/model/providerCapabilities.ts:35 ProviderCapabilityKey (:96); src/model/signedInProbe.ts:16 SignedInProbeSlot (:23); src/model/runModelDecision.ts:31 RunModelDecision (:52); src/model/modelListRefresh.ts:27 ModelListRefreshResult (:135,:208). Zero test-kernel consumers, zero wire/string/command-id/config-key forms (these are compile-time-only types). No `export *` barrel in src/latex, src/model, or packages/agent/src re-exports them, and no packages/agent/src file imports @latex/* or @model/* directly. (2) Not already done: git log -12 over all nine files shows the last touches are a26652b030, e072b02c0c, c47d5d04d0, 2d82c8138e — none un-exports these. (3) Not already filed: no open or closed issue names any of the 11; nothing in config/ratchets/knip-baseline.json matches (the only nearby entry is a different symbol, CODEX_DEFAULT_SUBSCRIPTION_INPUT_LIMIT in providerCapabilities.ts). (4) Not deliberately justified anywhere — the opposite: docs/proposals/2026-08-19-dead-code-gate-blind-spots.md §4 (added 2026-08-25) records "Un-exporting a type is never flagged" as a live, open gap, and issue #11386 ("Un-export 12 controller types with zero cross-file references") closed COMPLETED today via #11392 with exactly this shape and accounting (0 net LoC, −14 exported elements). This candidate is the disjoint src/latex + src/model continuation of that accepted precedent, not a duplicate of it. The three leads it excludes (TeXCountStat, AcceptedFileTarget, LatexdiffExecutionResult) are indeed separately named in docs/proposals/2026-08-07-prod-structural-leads-triage.md, and that doc's "15 zero-production-caller exported types" lead names a genuinely different set. (5) Settled surfaces: untouched — nothing here crosses the frozen @agent/* SDK surface, the five ratchets, src/agent/node/index.ts, the platform composition root, the six browser-reachable @utils modules, or the AgentEvent/SessionFact split. (6) R5/R6: real element reduction (−11 exported types), no unrelated churn, compiler-verified, no test edits. (7) No catch/fallback and no CLI result-JSON contract involvement.

</details>

### L7-scripts — Scripts, config, resources

**Paths**: `scripts/`, `config/` (only rows this lane owns in `knip-baseline.json`), `packages/extension/resources/`, `supabase/`

#### Cut format-staged's prettier-config-sourcing machinery down to the one config form this repo has

- **Area**: `scripts-config` · **Kind**: speculative-generality · **Risk**: medium
- **Net**: -1100 LoC, -13 elements

**Evidence**

`scripts/format-staged.mjs` is 923 lines; roughly 450 of them resolve prettier configs this repo does not have. Branches: `configSnapshotFor` package.json handling (`:636-700`), package.yaml handling (`:702-772`), JS-config handling (`:774-780`), plus the supporting `isJsConfig` (`:183`), `normalizeSpecifier` (`:190`), `isRelativeSpecifier` (`:195`), `isConfigPointerPath` (`:203`), `statProbe` (`:211`), `isWorktreeFile` (`:224`), `readPackageMain` (`:233`), `isIndexTracked` (`:267`), `resolveConfigDepPath` (`:277`, a hand-rolled reimplementation of Node's CJS LOAD_AS_FILE/LOAD_AS_DIRECTORY order over `CJS_FILE_EXTENSIONS`/`CJS_INDEX_EXTENSIONS` at `:65-66`), `collectJsRelativeDeps` (`:412`, a regex scanner for JS module specifiers in a repo that already depends on `acorn`/`acorn-walk`/`typescript`), and `verifyJsConfigDeps` (`:448`).

Repo reality: `find . -maxdepth 3 \( -name '.prettierrc*' -o -name 'prettier.config.*' \) -not -path '*/node_modules/*'` returns exactly one file, `./.prettierrc` (4 keys: singleQuote, trailingComma, semi, tabWidth — no `plugins`, no `extends`, no `overrides`). `rg -n '"prettier"' package.json packages/*/package.json` returns only devDependency version lines (package.json:91, packages/extension/package.json:1136) — no `prettier` config key anywhere. `find . -maxdepth 3 -name package.yaml -not -path '*/node_modules/*'` returns zero hits. So the package.json-key, package.yaml, JS-config, string-pointer, Windows-pointer, node_modules-shareable-package, and directory-package-`main` paths have zero production exercise.

Consumers: production = 1 (`scripts/install-local-hooks.mjs` installs it as an opt-in local git hook, `npm run hooks:install`, package.json:21). It is NOT a CI gate — `format:check` (package.json:20) is, and the script's own header states it "warns and exits 0 rather than blocking a commit" (`:32-33`). Non-production = `src/test-kernel/scripts/FormatStaged.vitest.ts` (1630 lines); ~25 of its `it(` blocks (`:502`, `:524`, `:544`, `:564`, `:586`, `:608`, `:628`, `:749`, `:793`, `:823`, `:852`, `:898`, `:930`, `:960`, `:983`, `:1084`, `:1146`, `:1179`, `:1221`, `:1262`, `:1309`, `:1442`, …) each build a temp git repo to exercise a config form the repo does not have.

Provenance: `git log --oneline -- scripts/format-staged.mjs` shows one feature PR (#10327) followed by five "harden" PRs (#10401, #10482, #10577, #10599, #10657) closing 20+ review-bot follow-up issues (#10429/#10430/#10431/#10433/#10434/#10435/#10436/#10500/#10501/#10502/#10503/#10591/#10602 — all CLOSED). This is the review-checklist §13 growth pattern applied to a dev-only convenience hook.

**Proposal**

Keep the index-blob format → `git update-index` → three-way `merge-file` core (`:506-585`, `:800-923`) and the single supported config path: a `.prettierrc`-style file config, snapshotted from the index when it diverges from the worktree (`writeConfigSnapshot` at `:586`, plus `verifyConfigDeps`/`verifyDepSpecs`/`verifyConfigDep` for its relative `plugins`/`extends`). Replace every other branch in `configSnapshotFor` with one loud `SkipError('unsupported prettier config form; skipped auto-staging')`, and delete `isJsConfig`, `normalizeSpecifier`, `isRelativeSpecifier`, `isConfigPointerPath`, `statProbe`, `isWorktreeFile`, `readPackageMain`, `isIndexTracked`, `resolveConfigDepPath`, `collectJsRelativeDeps`, `verifyJsConfigDeps`, `CJS_FILE_EXTENSIONS`, `CJS_INDEX_EXTENSIONS`, and the pointer-recursion `depth` parameter. Delete the ~25 paired tests in `src/test-kernel/scripts/FormatStaged.vitest.ts` with the behaviour (fix spans outside scripts/ into src/test-kernel/). Skipping is already the script's designed failure mode, so a future contributor who adds a package.json `prettier` key gets a loud skip, never a commit formatted with uncommitted rules.

**What we give up**

Auto-staging assistance stops working (loudly, exit 0) for prettier config forms nobody in this repo uses: a `prettier` key in package.json or package.yaml, a `.prettierrc.js`/`prettier.config.mjs`, a string pointer to another config file, or a shareable config package. If one of those is ever adopted, the branch has to come back — but it comes back once, driven by a real config, not by 20 speculative follow-ups.

**Verifier corrections to the evidence above**

Three corrections, none fatal:

1. The claim's `find -maxdepth 3` missed a second config: `marketing/media/remotion/texra-video/.prettierrc` (`{useTabs, bracketSpacing, tabWidth}`). It is the same supported plain-`.prettierrc` form with no plugins/extends, and `prettier.resolveConfigFile` on a file in that subtree resolves to it, so the conclusion survives — but the honest statement is "two `.prettierrc` files, both the one supported form", not "exactly one file".

2. The delete list is wrong on two symbols. `verifyDepSpecs` (:389) — which the proposal keeps — calls `isRelativeSpecifier` (:195), which calls `normalizeSpecifier` (:190). Both must stay (or be inlined into `verifyDepSpecs`), not be deleted. And `resolveConfigDepPath` (:277) does not vanish: `verifyConfigDep` (:334) is kept and always calls it, so it collapses to its non-`cjs` first line, `resolve(configDir, normalizeSpecifier(spec))`, inlined into `verifyConfigDep`. What genuinely goes with it is the CJS candidate machinery: `CJS_FILE_EXTENSIONS`/`CJS_INDEX_EXTENSIONS` (:65-66), `statProbe` (:211), `isWorktreeFile` (:224), `readPackageMain` (:233), `isIndexTracked` (:267), plus `isJsConfig`, `isConfigPointerPath`, `collectJsRelativeDeps`, `verifyJsConfigDeps`, the `depth` param, and the `statSync`/`isAbsolute` imports.

3. LoC is overstated. Measured spans: script deletions ≈ 320-350 lines (143 in `configSnapshotFor`'s three branches + ~180 in helpers/consts), not "roughly 450" — the file goes 923 → ~580. Test deletions ≈ 800-830 lines (the file is 1630 lines / 58 `it(` blocks; ~29 blocks across :502-655, :749-874, :898-1470 pin deleted forms, while the mixed-EOL/autocrlf block at :658-747 and the JSON `.prettierrc` case at :875 stay). Net ≈ -1,100, not -1,250.

<details><summary>Verifier reasoning</summary>

I tried to break this and could not. Independent verification:

(1) Config-form reachability is real, and I confirmed it empirically rather than by grep alone. `node -e "prettier.resolveConfigFile(...)"` returns `/…/.prettierrc` for `package.json` and `scripts/format-staged.mjs`, and `/…/marketing/media/remotion/texra-video/.prettierrc` for files under that subtree. Those are the only two Prettier configs in the whole tree (`find . \( -name '.prettierrc*' -o -name 'prettier.config.*' -o -name 'package.yaml' \) -not -path '*/node_modules/*'` — no maxdepth), both plain extensionless JSON `.prettierrc` with 3-4 formatting keys, no `plugins`/`extends`/`overrides`. There are only 7 tracked `package.json` files and none carries a `prettier` key (`rg '"prettier"\s*:\s*\{'` → nothing; the only `"prettier":` string hits are the `^3.9.6` devDependency lines at package.json:91 and packages/extension/package.json:1136). Zero `package.yaml`. So `configSnapshotFor`'s `package.json` branch (scripts/format-staged.mjs:636-700), `package.yaml` branch (:702-772), and JS-config branch (:774-780) plus the whole CJS-resolution stack under them are unreachable in this repo.

(2) Consumers: `rg -n "format-staged" -l` (no node_modules) returns exactly four files — AGENTS.md (:26-38, prose describing the hook's user-facing behaviour only), scripts/format-staged.mjs, scripts/install-local-hooks.mjs (:43 `node scripts/format-staged.mjs`), src/test-kernel/scripts/FormatStaged.vitest.ts. `.pre-commit-config.yaml` references only `npm-format`, not this script. Nothing imports symbols from it; it is spawned as a hook. No extension contribution, command registration, coreSettings/stateSettings key, resources YAML, prompts/, or supabase/ touchpoint exists — this is a dev-only opt-in git hook, not a CI gate (`format:check` is).

(3) Not already done: `git log --oneline -- scripts/format-staged.mjs` shows exactly the six additive commits the claim names (65ed3187c1 #10327, then 5b3a24775a #10401, 847c94dce0 #10482, 4a487eb4b5 #10577, 11c688a93d #10599, 2539cd4347 #10657) plus one test-simplifier checkpoint. No cut-back attempted.

(4) Not already filed: `gh issue list --state all --limit 40 --search "format-staged"` returns 20+ issues, every one CLOSED and every one additive-hardening (#10367 #10369 #10370 #10428-#10436 #10499-#10505 #10591 #10602 #9955). No open or closed issue proposes trimming the config-sourcing surface.

(5) No deliberate ruling protects it: `rg "format-staged|prettier config" docs/ config/ratchets/ .claude/skills/code-review/references/review-checklist.md` returns nothing. AGENTS.md documents only the hook's behaviour, not the multi-config-form generality. None of the settled surfaces (five ratchets, frozen @agent/* SDK, src/agent/node/index.ts, the four hosts/platform root, six browser-safe @utils modules, AgentEvent/SessionFact) is touched — this is `scripts/` plus one test file.

(6) §14 R5/R6: this strictly removes elements (13+ module-level functions, 2 consts, a recursion depth param, ~29 of 58 `it(` blocks) and relocates nothing. §15: the deleted branches are all loud `SkipError` guards, and the proposal replaces them with a single loud `SkipError`, so no masking site is created and no load-bearing fallback is removed — the safety invariant (never format staged content with uncommitted rules) is preserved by skipping, which is already the script's designed failure mode, with `npm run format:check` still gating in CI. §13's "growth pattern" and "don't reward activity" apply squarely: one feature PR followed by five hardening PRs closing 20+ bot-filed follow-ups, all for config forms the repo does not have.

(7) Not the CLI result-JSON contract; texra-action is unaffected.

Residual risk is that the kept core manipulates the git index and working tree (the #9953/#9955 data-loss story), so the edit must not disturb :506-585 / :800-923 — hence medium, not low.

</details>

#### log-usage: delete the two wire fields no client has ever sent (subscriptionSource, isMultipleOutput)

- **Area**: `resources-prompts-supabase` · **Kind**: dead-export · **Risk**: medium
- **Net**: -8 LoC, -2 elements

**Evidence**

`supabase/functions/log-usage/usageValidation.ts:46` declares `subscriptionSource: optionalString` and `:34` declares `isMultipleOutput: optionalBoolean` on the accepted usage-log wire schema.

Production producers, grepped repo-wide (`rg -n 'subscriptionSource|subscription_source' --hidden -g '!node_modules' .` and the same for `isMultipleOutput|is_multiple_output`): **0 outside `supabase/functions/log-usage/`**. The only client wire schema is `src/telemetry/UsageLogTypes.ts:9-42`, which emits exactly model, provider, agentName, agentCategory, usageRoute, streamId, inputTokens, outputTokens, cost, responseTimeMs, cachedInputTokens, reasoningTokens, timestamp, extensionVersion, editorType — neither field is present.

Non-production consumers: `supabase/functions/log-usage/usageValidation_test.ts` calls `subscriptionSourceForUsage` at :52/:64/:75/:84 but **never sets `subscriptionSource`** on any fixture (each test sets only `usageRoute`). Zero test references to `isMultipleOutput`.

History: `git log -S'subscriptionSource' -- src/ packages/` returns **zero commits ever** — the field was introduced server-side on 2026-07-03 (#6931) as a client-override hook that no client was ever written for. `git log -S'isMultipleOutput' -- src/ packages/` last touches 2026-05-12 (`refactor: retire legacy compat code`), after the field left the client wire on 2026-05-07 in #3237 (`feat: unify single and multiple output into one protocol`) — 3.6 months ago, past the compat window; `docs/guide/multiple-output.md:111` records that the YAML field is retired.

Consequences at the call sites: `usageValidation.ts:74/76/78/81` are four `entry.subscriptionSource ?? '<product>'` expressions whose left arm is provably always `undefined`, so `subscriptionSourceForUsage` is a pure `usageRoute -> product` map wearing an M5 re-derive-resolver shape. `index.ts:72` then adds a second, redundant `?? 'chatgpt'` over a value the destination's own `accepts` predicate (`index.ts:64`) has already proven non-undefined (M6). `index.ts:145` writes `is_multiple_output: entry.isMultipleOutput ?? null` — an always-null column write on every row.

Dedupe: `gh issue list --state all --limit 40 --search "subscriptionSource log-usage"` → 0 hits; `--search "isMultipleOutput"` → only #4559 (closed, a docs sweep). The R6 debt audit that covered `supabase/functions` (#8874, 11 sub-issues, 2026-07-19) filed #8883 for the _opposite_ direction (two client-sent fields the server strips); neither of these fields appears in its table. `git log --oneline -40 -- supabase/functions/log-usage/` shows no PR doing this.

**Proposal**

Delete `subscriptionSource` (usageValidation.ts:46) and `isMultipleOutput` (usageValidation.ts:34) from `UsageLogEntryInputSchema`. Collapse `subscriptionSourceForUsage` (usageValidation.ts:69-83) from the four-arm `??` switch into a single `Record<UsageRoute, string>` lookup keyed on `usageRoute`, dropping the `subscriptionSource` member from its `Pick<>` parameter type. Drop the now-dead `?? 'chatgpt'` at index.ts:72 (the `accepts` predicate at :64 already guarantees a value). Drop the `is_multiple_output` key from `toDbRows` (index.ts:145); leave the DB column in place (it becomes permanently NULL) and let ops drop it separately.

Explicitly NOT in scope, and each for a stated reason: `usedRelay` / `usageRoute: 'relay'` carry a dated retirement comment (`usageValidation.ts:18-20`, "Delete after 2026-11") tracked by open issue #10921 — respect the date. `viaChatGptSubscription` left the client only on 2026-07-04 (`9291d24417 fix: normalize usage route at parse boundary`), inside the compat window, so released clients may still send it.

Deploy-gated like every other edge-function change in this repo; before merging, confirm the `usage_logs_upsert` RPC tolerates rows without the `is_multiple_output` key (jsonb_to_recordset/jsonb_populate_record both yield NULL, but this is a production-only check).

**What we give up**

The ability for a future client to override the subscription product name per entry without changing the route enum — a capability that has never had a producer. And per-row multi-output tagging in `usage_logs`, which has been NULL for every row written since 2026-05-07.

**Verifier corrections to the evidence above**

Three corrections.

1. WRONG SCOPE STEP — do not drop `?? 'chatgpt'` at supabase/functions/log-usage/index.ts:72. The claim calls it dead M6 because `accepts` (index.ts:64) proves the value non-undefined. True at runtime only: `entries.filter(destination.accepts)` (index.ts:101) uses a plain boolean predicate, not a type guard, so `subscriptionSourceForUsage(entry)` stays `string | undefined` to the compiler. Deleting the `??` makes `source` possibly-undefined on the write to `subscription_usage_logs.source` — that table's own product discriminator — with no compile error, converting a currently-total mapping into a latent NULL-discriminator hazard for one line. Per §15 a redundant-but-attributing guard is kept or made loud, not silently deleted. Leave index.ts:72 alone.

2. OVERSTATED COLLAPSE — the `Record<UsageRoute, string>` rewrite is churn, not a win. `UsageRoute` is not an exported type today (usageValidation.ts exports only `UsageRouteSchema`), so the lookup form must ADD a `z.infer` alias plus a `Partial<Record<...>>`, and it drops the `default:` arm covering `relay`/`api-key`/undefined along with the load-bearing xai→grok comment at usageValidation.ts:80. Keep the switch; just replace each `entry.subscriptionSource ?? '<product>'` with the bare literal.

3. NUMBERS — the honest delete list is: usageValidation.ts:34 (isMultipleOutput), :44-46 (the stale 2-line comment + subscriptionSource — that comment is itself wrong today, describing the mapper rather than the field), the `| 'subscriptionSource'` member of the `Pick<>` at :70, the four `entry.subscriptionSource ??` left arms at :74/76/78/81, and index.ts:145 (is_multiple_output). That is -8 lines, not -12, and 3 elements (2 wire fields + 1 persisted column write).

One landmine the claim flagged is actually defused and the issue should say so: `is_multiple_output` already receives literal `null` on every row today (entry.isMultipleOutput is provably always undefined), so the column demonstrably has no NOT NULL constraint, and omitting the key yields the identical NULL under either jsonb_to_recordset or jsonb_populate_recordset. The RPC bodies (usage_logs_upsert / subscription_usage_logs_upsert) are not in this repo — no migrations directory under supabase/ — so it remains a production-only confirmation, but it is near-certainly a no-op.

<details><summary>Verifier reasoning</summary>

Survives, with scope corrections. I re-ran every grep myself. `rg -n 'subscriptionSource|subscription_source' --hidden -g '!node_modules' .` returns hits ONLY in supabase/functions/log-usage/{usageValidation.ts,index.ts,usageValidation_test.ts} — zero in src/, packages/, prompts/, packages/extension/resources/, packages/extension/package.json, src/shared/schemas/. Same for `isMultipleOutput|is_multiple_output`: only usageValidation.ts:34 and index.ts:145, plus two docs mentions of the unrelated _YAML settings_ field (docs/proposals/2026-04-30-unified-output-protocol.md, docs/guide/multiple-output.md:111, which records it as retired).

Single-producer confirmed: `rg -n 'log-usage'` shows exactly one POST path, src/telemetry/UsageLogService.ts:25, fed by src/agent/runtime/UsageMonitor.ts:262-275 (note: NOT src/agent/utils/ as the audit-era issues say). That call site emits 12 keys, neither field among them. The relay producer is gone (attic/supabase-relay). No parity fence exists — src/test-kernel/ has no supabase/ dir and nothing under it references usageValidation.

History checks out and is stronger than the claim states: `git show 085b0ccf52` (#6931, 2026-07-03) introduced the field with the comment "Explicit subscription source (e.g. 'copilot') for future non-ChatGPT subscription clients" — speculative generality that lost. The future arrived via `usageRoute` instead, and the field can never be reclaimed as a no-deploy hook because `usageRoute: optional(UsageRouteSchema)` is a CLOSED enum (usageValidation.ts:13-23): an unknown route fails parse and rejects the whole batch, so any new subscription source already requires an edge redeploy. `git log -S'subscriptionSource' -- src/ packages/` = 0 commits ever.

Back-compat is safe, and the claim understates why: `UsageLogEntryInputSchema` is a plain `z.object` (strip mode, no `.strict()`), so a released client still sending either key is silently stripped, not rejected.

Not already done (both fields present at HEAD). Not already filed: `gh issue list --state all --search "subscriptionSource"` = 0; `--search "isMultipleOutput"` = only #4559 (closed docs sweep). #8883 (R6 finding 9/11 under tracker #8874) is provably the opposite direction — I read its body: it deletes cacheMissInputTokens/cacheCreationInputTokens from the CLIENT schema, and UsageMonitor.ts:262-275 confirms it already shipped. Neither field appears in #8874's 11-row table or its do-not-redo ledger. #10921 covers only the four dated relay members ("delete after 2026-11"), correctly excluded. No docs/proposals or config/ratchets ruling protects either field, and no settled surface (five ratchets, @agent/* SDK, PocketFlow engine, hosts/platform, browser-safe utils, AgentEvent/SessionFact) is touched.

</details>

#### Stop shipping the four extension/desktop-only agent-creator templates in the CLI npm bundle

- **Area**: `resources-prompts-supabase` · **Kind**: test-only-consumer · **Risk**: low
- **Net**: -4 LoC, 0 elements

**Evidence**

`packages/cli/scripts/copy-resources.mjs:19-22` copies four files into the published CLI tarball:

- `templates/agentCreatorToolUse.yaml` (67 lines)
- `templates/agentCreatorWorkflow.yaml` (123 lines)
- `templates/agentTemplate-toolUse.yaml` (31 lines)
- `templates/agentTemplate-workflowSingle.yaml` (53 lines)

274 lines of YAML total. The CLI never reads any of them.

Consumer grep, production: `rg -n "templates/|AGENT_TEMPLATE|agentTemplate|writeTemplateAgentFile|agentCreator" packages/cli/src` → **0 hits**. The two consumers of these files both live in VS Code / desktop surfaces:

- `packages/extension/src/commands/agent/agentCreatorCommands.ts:36-43` reads `agentCreatorWorkflow.yaml`, `agentCreatorToolUse.yaml`, `agentTemplate-workflowSingle.yaml`, `agentTemplate-toolUse.yaml` and feeds `buildCreatorConfig` — reachable only through `texra.createAgentWithAI`, contributed at `packages/extension/package.json:299` and `:830`, i.e. VS Code only.
- `src/controllers/settingsView/backend/templateAgentCreation.ts:64-70` reads `templates/<AGENT_TEMPLATE_FILES[kind]>`; its only importers are `packages/extension/src/settingsView/handlers/agentHandlers.ts:27` and `packages/desktop/src/main/desktopAgentSettingsController.ts:23`. No CLI importer.

The CLI's own use of the packaged `resources/` root is `initializeBundledPrompts(context.resourcesPath)` (`packages/cli/src/runtime/initPlatform.ts:369`), `bootstrapNodeAgentDirectories` (:372, agents/tool_use_agents only), and `initializeNodeRuntimeSkills` (:378). The one `templates/` file `bundledPrompts.ts` can read is `templates/instructionPolish.yaml` — and `copy-resources.mjs` deliberately does not copy it, a fact `src/agent/runtime/bundledPrompts.ts:18-21` documents by name. So after this change the CLI bundle simply has no `templates/` directory at all.

Precedent for the exclusion already exists: `packages/cli/scripts/validate-pack.mjs:54` forbids `dist/resources/templates/chatExport.tex` with the comment "The chat-export template is extension-only." These four are extension-only for exactly the same reason.

Ambiguous-path classification: `packages/cli/scripts/*.mjs` are build/packaging scripts, inspected directly — `copy-resources.mjs` is the producer and `validate-pack.mjs` is the tarball gate; neither reads the YAML content.

Dedupe: `gh issue list --state all --search "copy-resources CLI bundle templates"` → #10344 (closed, desktop polish-prompt init) and #4031, neither related. `git log --oneline -10 -- packages/cli/scripts/copy-resources.mjs` → last edits are #10365 (desktop polish init), #9757 (trace-viewer dir rename), #7137/#7142 (trace-viewer export); nothing pruned the template entries.

**Proposal**

Delete lines 19-22 of `packages/cli/scripts/copy-resources.mjs`. In `packages/cli/scripts/validate-pack.mjs`, replace the single exact-match `relative === 'dist/resources/templates/chatExport.tex'` at :54 with the prefix test `relative.startsWith('dist/resources/templates/')`, so the whole directory is a forbidden tarball entry and any future re-add fails the pack gate instead of silently shipping. The resource files themselves stay where they are under `packages/extension/resources/templates/` — the extension and desktop still read them.

**What we give up**

Nothing at runtime. It forecloses a future CLI `texra agent create` that wants the bundled templates without re-adding the copy entries — which is the visibility the pack gate is for.

**Verifier corrections to the evidence above**

Three corrections/additions.

1. PRECEDENT IS STRONGER THAN CLAIMED, AND IT IS ON THIS EXACT LIST. The claim cites `validate-pack.mjs:54` (chatExport). The better precedent is `62ab7da8c7` / #10365 (2026-08-15): it deleted `'templates/instructionPolish.yaml'` from `runtimeResourceEntries` in this very file for exactly this reason ("the CLI stops copying the unused polish template"), leaving these four behind because that PR was scoped to the desktop polish defect. `src/agent/runtime/bundledPrompts.ts:18-21` documents the resulting state by name. So this is the unfinished half of a ten-day-old cleanup, not a novel idea.

2. THE CLI'S AGENT-CREATION STORY IS SEPARATE AND MUST NOT BE CONFLATED. `packages/extension/resources/tool_use_agents/creator.yaml` IS bundled to the CLI and IS reachable there, but it drives creation through `docs/agent-creation/{workflow_schema,tooluse_schema,tool_catalog,execution_and_testing}.md` (copied via the `docs/agent-creation` entry), never through `templates/*.yaml` — verified by grepping creator.yaml and that doc directory. The issue text should say this explicitly so a reviewer does not read the deletion as removing CLI agent creation.

3. THE PROPOSED `validate-pack.mjs` PREFIX BAN IS BROADER THAN THE EVIDENCE. `relative.startsWith('dist/resources/templates/')` permanently forbids a legitimate future add: `bundledPrompts.ts` deliberately keeps the polish row registered for the CLI so a CLI polish caller "would fail loudly", which implies `templates/instructionPolish.yaml` is a supported future add. Prefer enumerating the forbidden filenames (chatExport.tex plus the four), or keep the prefix and record the trade-off in the comment. This does not change net LoC either way.

Also note `packages/cli/src/runtime/resourcesPath.ts` falls back to `../extension/resources` in a dev checkout, so local dev behavior is unchanged by the deletion — only the published tarball shrinks.

<details><summary>Verifier reasoning</summary>

Survives. Independently verified at HEAD (8968988375).

DEAD-PAYLOAD CLAIM CONFIRMED. `packages/cli/scripts/copy-resources.mjs:14-24` lists the four `templates/*.yaml` entries in `runtimeResourceEntries`; `packages/cli/package.json:26-30` ships all of `dist`, so they land in the tarball. `rg -n "templates/|agentTemplate|agentCreator|AGENT_TEMPLATE" packages/cli/src packages/cli/scripts` returns hits only in the two `.mjs` build scripts — zero in `packages/cli/src`. Repo-wide grep for the four filenames gives exactly: the extension command (`packages/extension/src/commands/agent/agentCreatorCommands.ts:36-42`), `src/agent/templates/agentTemplateRenderer.ts:8-11` (`AGENT_TEMPLATE_FILES`), `src/agent/implementations/agentCreator/agentCreatorFlow.ts` (string literals used only in error messages — `buildCreatorConfig` takes bytes the host already read), the copy script, and three vitest files. `writeTemplateAgentFile` (`src/controllers/settingsView/backend/templateAgentCreation.ts:54-70`) is imported only by `packages/extension/src/settingsView/handlers/agentHandlers.ts` and `packages/desktop/src/main/desktopAgentSettingsController.ts`. No CLI importer of either.

NO INDIRECT CLI PATH. The CLI's three uses of `resourcesPath` (`packages/cli/src/runtime/initPlatform.ts:369,373,380`) are `initializeBundledPrompts`, `bootstrapNodeAgentDirectories`, and `initializeNodeRuntimeSkills`. The bootstrap copies only `BUNDLED_AGENT_DIRECTORY_NAMES` = `['agents','tool_use_agents']` (`src/agent/index/BundledAgentDirectories.ts`), and skills resolve `resourcesPath/skills`. I also checked the bundled YAML/doc payload for a runtime reference: `rg "agentTemplate|templates/"` over `resources/{agents,tool_use_agents,shared,docs}` and `skills/` returns nothing. No CLI polish caller exists (`rg -i polish packages/cli/src` → 0), so the one `templates/` row `bundledPrompts.ts` can read is unreachable from the CLI too.

DESKTOP UNAFFECTED. `packages/desktop/electron-builder.yml:46-47` copies `../extension/resources` directly, not the CLI's `dist/resources`.

NOT ALREADY DONE / NOT FILED / NO CONTRARY RULING. `git log -12 -- packages/cli/scripts/copy-resources.mjs` shows the entries untouched since introduction; issue searches (`copy-resources templates CLI bundle`, `agentTemplate CLI`, tech-debt `resources bundle templates`) return only #10344, #4031, #7094, all unrelated. No ratchet, AGENTS.md/CLAUDE.md rule, or dated doc requires the CLI to ship `templates/`; the newest ruling (`docs/proposals/2026-08-25-agent-sdk-readiness-reverify.md:109-117`) states the opposite — `agentCreator` is the one flow that "runs inline in the extension host through the `AgentCreatorUI` port", and closing that boundary is deferred interactive-UI design. Touches no settled surface (no ratchet, no `@agent/*` specifier, no PocketFlow engine, no host/platform seam, no `@utils` browser set, no AgentEvent/SessionFact split, no CLI result-JSON contract).

CHECKLIST 13/14/15. Pure deletion of dead build-script entries; no relocated complexity, no forced churn (the YAML stays at `packages/extension/resources/templates/`, all three vitest suites read it from the repo path, not `dist/`). No catch/fallback involved, so §15 M1-M6 does not apply. Only real caveat is size: repo net is -4 lines; the "274 lines" is shipped payload (~9 KB of a ~2.6 MB tarball), not LoC.

</details>

## 3. Refuted — do not re-file

Forty-one candidates were killed on independent verification, grouped by area.

### `agent-runtime`

- **Retire the inline goal-continuation duplicate in bundledPrompts and its source-scraping parity test**

  <details><summary>Why it was refuted</summary>

  Refuted on two independent grounds.

  (1) A dated architecture ruling covers exactly this asymmetry and the claim does not beat it. docs/architecture/2026-07-26-embedding-the-agent-runtime.md:543-550, under "What degrades gracefully (safe to skip)", states: "Degradation is per row, not global: the `goal` row falls back to its inline copy when no root was registered, and also on a broken YAML — logging a warning in that case; the `polish` row is `required` and rejects instead, so an embedder that skips this call loses follow-up polish loudly." The polish/goal contrast the claim cites as evidence of accidental duplication IS the documented decision: an SDK/embedder that never calls initializeBundledPrompts must still get the goal continuation (a correctness-critical prompt that keeps an autonomous run from silently ending), while polish fails loudly. The module header at src/agent/runtime/bundledPrompts.ts:14-21 says the same thing and ties it to a shipped regression (#10365). Flipping goal to `required` deletes a documented embedding contract and forces churn in that doc.

  (2) The consumer inventory is wrong: there is a third non-production consumer, and it is the one that would break. src/test-kernel/agent/GoalContinuation.vitest.ts never calls initializeBundledPrompts, and no shared setup does either — @test/support/defaultSessionTestSetup.ts only calls initializeDefaultSession, and grep over src/test-kernel/support/ finds zero initializeBundledPrompts. Its whole maybeBuildGoalContinuation suite therefore renders through the `resourcesRoot === null` arm at bundledPrompts.ts:137-139 and asserts on the inline text ("Autonomous objective active", "<goal_context>", "Time elapsed: 2h 5m"). I ran it: 10/10 pass with no bundle wired. Under { kind: 'required' } every one of those cases throws `Bundled prompt "goal" is unavailable`, so the proposal silently requires rewriting a suite it never mentions — unrelated churn that eats the claimed -75.

  Also, the fallback is not a section-15 masking site: it warns at log.warn (bundledPrompts.ts:159-162), the doc calls it a substitution, and the parity test pins it line-for-line — it is the accepted loud form, and src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts:130 awaits it inline with no local catch, so `required` converts a benign "no continuation" into a thrown error mid-wait. The only genuinely ugly artifact is the source-text-scraping parity describe (BundledPrompts.vitest.ts:96-121), which is far too thin on its own.

  No prior filing found (git log for the path shows only a605117e23, f810acb9ec, 868d0940f8; `git log --all --grep=INLINE_GOAL_PROMPTS` is empty), but "not yet filed" does not rescue a candidate that a dated ruling already decided against.

  </details>

### `model-handlers-anthropic-openai`

- **Collapse the two content-stringification knobs in ModelHandlerOpenAI onto the vision-aware one**

  <details><summary>Why it was refuted</summary>

  Refuted on a dated in-file ruling plus a live divergence risk, and the evidence is partly wrong. (1) src/agent/modelHandlers/ModelHandler.ts:238-249 and :258-266 carry two #7101-triage rulings that reject exactly this move: "capabilities.supportsVision looks like the natural candidate, but it doesn't line up - Grok, Kimi, and Qwen models all report supportsVision: false ... Folding this into supportsVision would silently drop attachment summaries", and "it would coincidentally match capabilities.supportsVision ... but that conflates two unrelated capabilities and would break the moment they diverge." The candidate's whole case is that coincidence, on the same class hierarchy the rulings govern. (2) The knobs are not the same decision: modelHandlerDashScope.ts:12 states a provider-wide wire constraint ("DashScope requires content to be converted to strings"), while convertContentToStringUnlessVision (modelHandlerOpenAI.ts:539) is a per-model predicate for providers that ship both vision and non-vision models. Folding converts an unconditional invariant into a catalog-derived one, and the catalog changes: 545288c8bb (#11268, 2026-08-21, four days before this audit) flipped a DeepSeek entry to supportsVision: true via an llm-zoo bump. The first llm-zoo release carrying a qwen-vl entry would then silently change DashScope's wire format with no code change and no log - a silent-degradation regression, not a saving. (3) docs/dev/audits/2026-07-08-agent-sdk-readiness-checkpoint.md:214 already ruled the thin DashScope class a Keep specifically because of that one line. (4) Checklist R5/R6: element count is unchanged (one knob, one setter, one derivation before and after) for roughly five lines, and the base JSDoc at modelHandlerOpenAI.ts:530 ("Real OpenAI keeps all three off") needs an unrelated edit too. Verified independently: rg over src/packages/supabase/prompts/docs, packages/extension/package.json contributions, coreSettings.ts/stateSettings.ts, resources/ YAML - no other production consumer; gh issue search for convertContentToString / DashScope handler returned 0 rows, so it is not a duplicate, just not worth doing.

  </details>

- **Delete the dead pre-2025-12 reconstruction branch in ModelHandlerAnthropic.buildToolCallAssistantContent**

  <details><summary>Why it was refuted</summary>

  The `else` branch is not an expired compat reader — it is the base-case implementation of a live, documented cross-handler contract, and it is exercised today.

  1. Falsified consumer count. The claim says "non-production consumers: 0". `src/test-kernel/agent/modelHandlers/ModelHandlerAnthropic.vitest.ts:675` ("batches parallel tool results into one assistant and one user message") calls `handler.createBatchedToolUseFollowUpMessages(entries, undefined /* workspaceState */, 'analysis' /* text */, NO_UPLOAD_CLIENT)` and asserts `callContent.map(b => b.type)` deepEquals `['text', 'tool_use', 'tool_use']`. With the proposed deletion the stored path is skipped (`workspaceState` is undefined), the text block is never pushed, and the assertion becomes `['tool_use','tool_use']` — the test fails. The private method is reachable through the public one, so "private, 2 references" understates its surface.

  2. The `text` push is contract, not legacy. `ModelHandler.ts:1705-1713` declares `createBatchedToolUseFollowUpMessages(..., workspaceState: AgentWorkspaceState | undefined, text: string | undefined, ...)` and documents `text` as "Assistant text emitted before the tool calls, if any". Every sibling handler implements exactly this shape independent of any stored ordered content: `modelHandlerOpenAIResponse.ts:2690-2711` (`if (text && !isResponseChaining) messages.push(this.createAssistantMessage(text))` then server-tool blocks), `modelHandlerGoogleInteractions.ts:1274-1290`, `modelHandlerOpenAI.ts:1120-1130`, `modelHandlerValidation.ts:286-300`. Deleting Anthropic's branch makes Anthropic the only handler that silently drops the assistant text and silently ignores a declared parameter whenever the store is empty — checklist §15 silent-degradation, not dead code.

  3. The "cannot fire" analysis has a hole: `AgentWorkspaceState.fromSnapshot` (`src/agent/core/state/AgentWorkspaceState.ts:371-400`) restores `reasoning.thinkingBlocks` from the snapshot but rebuilds serverToolContent as `ServerToolContentStateSchema.parse({})` (:397), i.e. `lastAssistantContent: []`. `toSnapshot()` (:402-418) never persists serverToolContent at all. So "thinking present, lastAssistantContent empty" is a state the persistence layer constructs on every tool-use resume (`ToolUsePrepareNode.ts:76-83`). It happens not to reach dispatch today only because the resume path re-calls the model first — an incidental property of one caller, not a structural impossibility. Deleting the branch removes the only handling of that state.

  Nothing about this is version-gated: no date fence, no format check, no deprecation marker. Reframing an `if/else` default arm as a "pre-2025-12 branch" because the preferred arm landed in e8aa0b2d3c does not make it compat debt.

  Also checked and clean: no other production caller (`ToolUseDispatchNode.ts:603,616` only, both passing `workspace`); no `ModelHandlerAnthropic` subclass in production; not already filed; nothing in docs/proposals, docs/architecture, or config/ratchets rules on it either way; not a settled-surface collapse.

  </details>

### `model-handlers-rest`

- **Drop three provider residues: an unreachable Kimi rule key, a log-only xAI override, and a local error-message duplicate**

  <details><summary>Why it was refuted</summary>

  The candidate as filed is refuted: leg (a) misses a live production consumer and its deletion is a silent regression, and leg (c) proposes replacing a helper whose non-Error `.message` handling is load-bearing for two error-classification predicates. Per the "a single missed production consumer refutes the claim" rule, the batch does not survive.

  (a) fails because `kimiCodeRuntimeConfig` (`src/model/kimiCodeSubscriptionRouting.ts:148-162`) rewrites `fullName` to the coding-endpoint wire id `'k3'`, and `ModelFactory.ts:571` applies that before handler construction, so `modelHandlerKimi.ts:108,136` genuinely look up `'k3'`. Deleting the key would restore `temperature` on requests to the Moonshot coding endpoint for every Prefer-Kimi-Code user and drop `disableThinkingInCompactionSummary` — checklist §15 M-class masking: the entry is a real constraint, not residue. Two tests would also fail.

  (c) fails on §13/§14 grounds compounded by a correctness bug: `toErrorMessage` returns `String(err)` for non-Errors, so a Google GenAI `{ code, message }` plain object collapses to `'[object Object]'` and `isStaleInteractionChainError` / `isBackgroundUnsupportedError` both stop matching. The file's own comment documents that the error shape is unconfirmed and object-like; the sibling `code` read on the raw value corroborates it. This is exactly the load-bearing fallback §15 says to keep, and the swap nets ~-5 LoC while risking two silent retry paths.

  (b) survives verification unchanged and is the only recordable residual: an override that adds nothing but a debug log for a value already carried by `NormalizedUsage`. Delete `ModelHandlerXAI.extractResponse` (`src/agent/modelHandlers/openai/modelHandlerXAI.ts:186-203`) plus the two now-unused type imports at `:4` and `:24`. No consumers, no tests, no ratchet or settled-surface involvement (this is a leaf provider handler, not the frozen `@agent/*` surface, the PocketFlow engine, or the AgentEvent/SessionFact split), no forced unrelated churn. File the issue scoped to (b) ONLY, with an explicit note that (a) and (b)... that (a) and (c) were adversarially refuted so they are not re-proposed later.

  </details>

- **Delete the static Copilot-provider handler path; the Copilot route is the only live one**

  <details><summary>Why it was refuted</summary>

  Two independent failures.

  (1) The central dedupe claim is factually wrong. `src/agent/runtime/ModelFactory.ts:260-262` is NOT "a second statement of a mapping the route table already makes." `resolveModelHandlerCompatibilityKey` only reaches `PROVIDER_HANDLER_ROUTES` at the tail of a fall-through chain (`ModelFactory.ts:274`), after `shouldUseResponsesAPI` and `shouldRouteModelThroughOpenRouter`. The comment immediately above the early return (`ModelFactory.ts:243-249`) states the ordering is deliberate: "Both Copilot routes -- the per-model route preference on a canonical base model, and a config whose provider is Copilot itself -- must win before the global OpenRouter preference below." And it is load-bearing: `shouldRouteModelThroughOpenRouter` (`src/model/openRouterRouting.ts:94-99` -> `isOpenRouterAccessSelected`) returns true for the copilot4o config whenever the global OpenRouter toggle is on (not Kimi-exclusive, no `forceDirectProvider`, `openRouterOnly:false`, `useOpenRouter:true`), so deleting the early return re-routes a COPILOT config to `ModelHandlerOpenRouterNative`, not to the route table. Separately, the route table's COPILOT `load` is unreachable anyway: `createModelHandler`'s explicit `case 'ModelHandlerVscodeLm'` (`ModelFactory.ts:660-666`) bypasses the default provider-table branch and says so in its own comment. So the proposed end state ("the record becomes the single statement of COPILOT -> ModelHandlerVscodeLm") is not what the code would do.

  (2) "Production consumer count 0" is not established. All three claimed gates gate _selection_, not _dispatch_: the retired sweep only rewrites `GlobalStateKey.ENABLED_MODELS` (`src/model/modelListRefresh.ts:64`), and the two filters are picker/CLI-argument filters. The resume path bypasses all of them: `src/agent/runtime/AgentLaunchContext.ts:342-352` takes a persisted/inferred `modelHandlerCompatibilityKey` and calls `createModelHandlerForCompatibilityKey(modelConfig, key)` (`ModelFactory.ts:420`), which resolves the static config via `getRuntimeModelConfig` -> `MODEL_CONFIGS[model]` (`src/model/runtimeModelRegistry.ts:194-196`) with no retired/provider check. A stored session with `model: copilot4o` and key `ModelHandlerVscodeLm` lands directly in `languageModelReference()`, where the fallback is the only thing that produces a usable reference. Whether such data exists is a user-data question, unverifiable from the repo -- so the deletion trades a working resume for a hard `AgentError`, which is a behavior change, not a dead-code removal.

  Context that further weakens it: the fallback is not incidental cruft. It was added deliberately in `496f36086d` (#9652) as an explicit fix to a Cursor Bugbot medium finding ("ModelHandlerVscodeLm fell back to a config-shaped reference built from the base provider... config shape only for the deprecated static Copilot-provider entry, otherwise a descriptive AgentError"), and the carve-out is documented in place. Checklist section 15: this is not an M1-M6 masking site -- it is an explicit, narrow, documented compat branch with a loud error on the non-matching path.

  Scope/value: the proposal leaves `ModelProvider.COPILOT` in the enum, the route-table entry, `ProxyConfigResolver.ts:57`, `PROVIDER_DISPLAY_NAMES`/`MODEL_SOURCE_ORDER` (`src/shared/constants/providers.ts:173,185`), and both host filters (`SettingsModelSelectionController.ts:173`, `cliConfig.ts:54-56`) in place. It removes the two lines that make the surviving machinery coherent while retiring none of it -- checklist 14 R5/R6 churn, not an element reduction. Production LoC removed is ~10, not 45; the rest is test deletion.

  If anything here is worth doing, it is retiring `copilot4o` from llm-zoo and then removing the whole COPILOT-provider surface as one unit, recorded on the dated retirement ledger (the closed #9627 table already carries the sibling "Copilot `copilot:` model-id cohort" row, retire-after 2026-11-03). That is a different, larger piece of work than what is proposed, and it is not blocked today.

  </details>

### `agent-core-node`

- **Fold three single-implementation seams in the flow kernel: the post-compaction hook, stampCompatibilityKey, and shouldAutoRetry**

  <details><summary>Why it was refuted</summary>

  All three legs fail on independent verification; two are refuted on facts, the third is filed and too thin to carry the batch.

  (c) shouldAutoRetry — the load-bearing evidence is false. The claim says it is "called once (ModelInvocationNode.ts:432)" and that "the only override anywhere is a test harness, PocketFlowNode.vitest.ts:117". In fact `src/test-kernel/agent/runtime/RetryState.vitest.ts` calls `node.shouldAutoRetry(...)` directly at lines 691, 718, 728, 806, 827, 881, 889, 1101 and 1117, on real `ModelInvocationNode` instances (factory at :228-238) — nine assertions the claim never found. These are product-policy tests, not internal-seam pins: :1105-1117 is explicitly labelled "Regression for the retry storm where a context-window overflow ... got auto-retried with the exact same oversized payload forever. The base shouldAutoRetry gate must refuse a context-window error unconditionally." Deleting the method forces rewriting all nine plus the PocketFlowNode override, and strands two production docstrings that name it (`src/shared/schemas/errors.ts:134-137`, `src/common/errors/sdkError/providerErrorFormat.ts:408`). It is also a dated, deliberately-retained seam: `docs/prds/2026-06-29-prd-runtime-gold-standard.md:186` records `shouldAutoRetry` as part of the retry policy surface that was _relocated_ onto the invocation node ("honest: logic moves, not deleted"), and `docs/dev/audits/2026-07-29-agent-sdk-readiness-checkpoint.md:181-186` (§New-3) rules that the retry-prompt/shouldAutoRetry surface should sit on the invocation node rather than the generic `Node` — which is exactly where #11067 put it. The claim does not beat that ruling; it reverses it.

  (a) getPostCompactionContext — the proposal as written does not compile, and inverts a dated architecture recommendation. `InvocationServices = Pick<AgentCore, 'modelCell'|'logger'|'setting'|'config'|'runScope'>` (ModelInvocationNode.ts:159-162) and `AgentCore` (`src/agent/core/flows/BaseFlowServices.ts:47`) has no `workspace` member; `workspace` exists only on the _non-exported local_ alias `WorkspaceScopedCore = AgentCore & { workspace: AgentWorkspaceState }` (CommonCycleTypes.ts:85). So "widen the Pick with 'workspace'" is a type error; the real change is re-basing the generic kernel node's service constraint on a workspace-scoped type, hardwiring `AgentWorkspaceState.workPlan` and `runScope.session.executions` into a node shared by both flow families — the opposite of that node's documented "Only the services this node reads" contract. The optional slot is also runtime-load-bearing for callers that have no workspace: `src/test-kernel/agent/ResponseCycleTools.vitest.ts:92-100` constructs a node whose `createResponse` returns `updatedMessages: []` (non-null, so the branch at :779-793 is taken) with services cast `as never` and no `workspace`; unconditional inlining dereferences `services.workspace.workPlan.toSnapshot()` and throws. And `docs/dev/audits/2026-07-25-agent-sdk-readiness-audit.md:79-95` flags this precise helper as the `core/flows → @tools` value edge and recommends _injecting_ it as a port — travel direction is more injection at this boundary, not hardwiring.

  (b) stampCompatibilityKey — the only survivor, and it is both thin and already filed at design level. It is 2 lines of body under a 7-line docstring (persistedFlow.ts:148-161) documenting the keyless-legacy-record contract and where the sibling model-based inference lives (SessionResumeRetrieval); inlining either moves that docstring or loses it, so the honest win is ~-4 and it touches persisted legacy-format normalization (authored tier). `docs/proposals/2026-08-14-delegation-flow-substrate-consolidation.md:341-355` already enumerates this exact hydration skeleton — "read → parse/migrate → `stampCompatibilityKey`", naming `runReflectionFlow.ts:189-210` — under "§8 The flow twins", so the seam is recorded and its ruling is "not near-identical, audit before consolidating". A separate issue to inline two lines inside a block an open proposal already owns is duplicate churn.

  Section 14 R5/R6 and section 13: netting out, (c) is a net _increase_ in churn (nine test rewrites plus two stale docstrings for -3 production lines), (a) is a coupling regression that widens a kernel node's service surface and needs new test workspace stubs, (b) is ~-4 already covered by an open proposal. The claimed -30 is not reachable.

  </details>

### `agent-storage-export`

- **Inline hasPersistedParent and getPersistedUserFollowUpSupport into their one call site, reading meta.json once**

  <details><summary>Why it was refuted</summary>

  The two wrappers and the single production call site are real, but the candidate's supporting evidence is wrong in ways that change the verdict, and the actual payload is ~11 production lines bought with rewiring of two heavily-mocked suites.

  (a) Consumer set is misreported. `rg -n -w` over the whole repo gives production hits only in `src/agent/runtime/executeAgent.ts` (imports at :16-17, call site :549-552, doc-comment references at :532 and :645), and FOUR test files — but not the ones claimed. `src/test-kernel/agent/runtime/RunAgentOwnership.vitest.ts` has zero hits (invented), while `src/test-kernel/agent/runtime/AgentLaunchActivation.vitest.ts:10-11,36-37,137,172` mocks BOTH symbols and was missed entirely.

  (b) The migration story is false. `rg "FakeExecutionKVStore|ExecutionKVStore"` over all four test files returns nothing — none of them "already use `FakeExecutionKVStore` elsewhere in the same file". `AgentLaunchActivation.vitest.ts:33-36` and `ResumeToolUseCancellation.vitest.ts:46-50` both replace `@agent/storage/executionLifecycle` with a three-export factory mock and never touch the store layer. Inlining forces both suites to add an `importActual`-spread mock of `@agent/storage/ExecutionKVStore` (a module many others in the launch graph import by name, so a bare factory mock breaks them) plus a `createFakeKv` per suite — unrelated churn against the repo's "tests are a budget" rule, not covered by the -14 estimate.

  (c) It weakens a real assertion. `ResumeToolUseCancellation.vitest.ts:262` asserts `expect(mocks.hasPersistedParent).not.toHaveBeenCalled()` to pin that lineage resolution never runs after `clearTerminalExecutionState` rejects. Named-symbol observation is what makes that ordering assertion unambiguous; `readMeta` is generic and shared with other meta consumers, so the rewrite degrades it. And deleting `ExecutionChildLineage.vitest.ts` drops the only coverage of the fail-open "no readable metadata means no parent" semantics (`:29-31`), which governs whether a resumed run may legitimately resolve WAITING again.

  (d) The perf framing is overstated. `KVStoreCache` (`src/common/storage/KVStoreCache.ts`) caches handles not content, so the claim that two reads occur is technically right — but it is two concurrent reads of one small meta.json, once per tool-use resume. That is not "real work" worth a design argument.

  Nothing settled blocks it (no ratchet, no docs ruling, no barrel export at `src/agent/storage/index.ts:33-38`, no open/closed issue: `hasPersistedParent` → only #7154, unrelated; `executionLifecycle wrapper` → #10901/#9590/#6951, none covering this). So it is not forbidden — it is just too thin once the corrected footprint is counted: ~-11 production lines, four test files touched, one assertion weakened, one regression suite deleted. Checklist 14 R6 (deletion forces unrelated churn) and section 13 apply. Drop.

  </details>

- **Read execution metadata through the store's own validated accessor in deriveResumability instead of the raw 'meta' key**

  <details><summary>Why it was refuted</summary>

  Not dual representation — two deliberately different validation policies, and the swap is a functional regression.

  1. The core-only parse in `deriveResumability` is a dated, deliberate ruling, not an oversight. `git show 1384c1d64e -- src/agent/storage/resumability.ts` (#9918, "Add workflow execution observability", 2026-08-10) changed exactly this call site from `ExecutionMetaSchema.safeParse` to `ExecutionMetaCoreSchema.safeParse`, and in the same commit split the schema with the docstring "Core execution metadata that remains readable without workflow observability" (`src/shared/schemas/stream.ts:78-79`). The whole point of the split was that the resume decision must not depend on the workflow projection.

  2. `readMetaStrict()` does the opposite by design. `readValidatedMeta('throw')` (`src/agent/storage/ExecutionKVStore.ts:239-274`) validates `meta.workflow` against `WorkflowExecutionSnapshotSchema` and, in strict mode, throws on a bad workflow projection — its own comment says "Strict recovery must fail closed so a present but corrupt snapshot is never treated as 'no prior state.'" That schema is built from `z.strictObject` (`src/shared/schemas/workflowExecutionSnapshot.ts:47,53,…`), so a snapshot written by any binary with an added field fails to parse. Under the proposal, a workflow run with a perfectly valid flow-record checkpoint would return `{kind:'unreadable'}` and become non-resumable purely because a display-only snapshot drifted. That is the exact regression #9918 engineered around. The permissive `readMeta()` is no better: it collapses malformed→null, i.e. corruption read as absence, which the module explicitly refuses ("A present-but-malformed checkpoint is corruption, not an absent run", `resumability.ts:115`).

  3. The LoC claim does not survive the behavior the tests pin. `src/test-kernel/agent/storage/Resumability.vitest.ts:220-227` pins `cause: 'execution metadata is malformed'` and `:243` pins `cause: 'checkpoint could not be read (disk offline)'`; a single `try/catch` around `readMetaStrict()` cannot tell an IO failure from a ZodError without re-adding an `error instanceof z.ZodError` sniff — relocating the classification into error-type inspection rather than deleting it. Log level also changes debug→warn on a path called per-row from listing surfaces (`src/tools/ExecutionsTool.ts:403,652`).

  4. The "escape hatch" framing is weak on its own terms: the same file already calls `store.read(flowKey(executionId))` (`resumability.ts:98`) through the generic KV surface, which is a public method on the `ExecutionKVStore` interface (`ExecutionKVStore.ts:137`), not a private hole. `isReservedKvKeyName` exists for directory walkers, not as a ban on `read()`.

  No new consumer was missed and no duplicate issue exists (gh search returns only closed #7209/#6966/#7243 about the resumability decision), but the candidate is refuted on merit: it would trade a correct, documented policy for a stricter one that breaks resume.

  </details>

### `agent-workflowscript`

- **Shrink the @agent/workflowScript barrel: 6 baselined production-dead exports can leave knip-baseline**

  <details><summary>Why it was refuted</summary>

  Refuted on two independent grounds.

  (1) A dated, deliberate ruling from eight days ago does the exact opposite. `git show 0db6741c30` (#10826 "refactor: document curated barrel surfaces", 2026-08-17) is the commit that wrote the doc comment at `src/agent/workflowScript/index.ts:1-12`. Its diff shows it ADDED `workflowScriptCheckpointKvKey` to the barrel (before: `export { deriveWorkflowScriptCheckpointId } from './checkpointKey';`) and simultaneously CONVERTED the test's deep import into a barrel import: `src/test-kernel/agent/WorkflowScriptPersistence.vitest.ts` lost `import { workflowScriptCheckpointKvKey } from '@agent/workflowScript/checkpointKey';` and gained the name in the `@agent/workflowScript` import list. The same commit also rewrote the governing rule at `.claude/skills/code-review/references/review-checklist.md:153` from "No new convenience barrels" to "No undocumented convenience barrels … unless it documents a real external public surface, **its consumers, and its door policy**." The barrel's own header names its consumers as "delegation tools, execution cleanup, runtime control, **and their tests**" and enumerates exactly which symbols are excluded and why (`sandbox.ts` as an engine seam; `isWorkflowScriptCheckpointKvKey` to keep KV cleanup off the QuickJS/Wasm graph — the "perf(workflow): keep KV cleanup on leaf import" half of that PR). Test consumption of this curated surface is the documented door policy, not an oversight. The candidate proposes reverting a one-week-old curation decision in the precise direction it was just moved.

  (2) Zero net elements, positive source LoC (checklist §14 R5/R6, lines 126-127). Every one of the six symbols keeps its definition-site export; nothing is deleted, only re-addressed. index.ts loses ~~5 lines (three of the six share a line with a live export: `runWorkflowScript` with `WorkflowRunAbortError`, `WorkflowScriptParseError` with `parseWorkflowScript`), the doc-comment rewrite adds some back, and 7 test files each gain a new deep-import statement (~~+20 lines). The claimed -42 is dominated by 36 lines of machine-generated `config/ratchets/knip-baseline.json` JSON, which is not complexity. Real source delta is net positive. It also forces unrelated churn in `WorkflowScriptProgressProjectionFailure.vitest.ts:12-13`, which does `vi.mock('@agent/workflowScript', … importOriginal)` against the barrel shape.

  The self-contradictory fold-in confirms the confusion: interpolating `WORKFLOW_SKIPPED_RESULT` into the prompt copy at `src/tools/delegation/WorkflowScriptTool.ts:211,236` would make that constant a live production consumer of the very barrel export being deleted.

  </details>

- **Delete the vestigial 'starting' workflow call status: it never survives one synchronous transition**

  <details><summary>Why it was refuted</summary>

  REFUTED. `WORKFLOW_CALL_STATUS` is not an in-memory-only vocabulary: it is a member of the strictly-parsed persisted `meta.json` snapshot, and 'starting' does reach disk.

  1. Persistence path. `src/tools/delegation/WorkflowScriptTool.ts:429-440` reads the prior snapshot with `runStore.readMetaStrict()`, and its own comment says "Strict read preserves absent-vs-malformed: corrupt present snapshots stop recovery rather than being treated as a clean first launch" — a parse failure is rethrown as a hard `ToolError` ("prior workflow execution snapshot is malformed and cannot be recovered"). Writes go the other way: `src/agent/workflowScript/runWorkflowScript.ts:351-366` wires `WorkflowExecutionState`'s publish into `CoalescedSnapshotWriter`, whose `publish()` (:227-231) does `this.#running ??= this.#drain()`, and `#drain()` (:248-256) runs its body synchronously up to the first `await`: it calls `structuredClone(this.#pending)` before awaiting `#write`. So whenever the writer is idle at the moment `beginAttempt` publishes (the normal case — the previous call's write has long since drained while an agent ran), the snapshot cloned and handed to `onSnapshot` (workflowScriptStrategy.ts:277-282 → run meta) carries `status: 'starting'`. The claim's "no `await` between :681 and :682" is true and irrelevant: the clone happens synchronously inside the STARTING publish. A crash/kill/cancel before the RUNNING write lands leaves `'starting'` permanently on disk.

  2. Consequence. Deleting `STARTING: 'starting'` from the `z.enum(WORKFLOW_CALL_STATUS)` at src/shared/schemas/workflowExecutionSnapshot.ts:22/30 makes every such existing `meta.json` unparseable, which by the comment above blocks relaunch/recovery of exactly the interrupted runs recovery exists for. This repo has already been bitten by precisely this: commit 1b19db5796 "fix(workflow): tolerate legacy stageTitle in persisted snapshots" added the `z.preprocess` shim at workflowExecutionSnapshot.ts:106-115, whose comment states the rule — "a `meta.json` snapshot persisted before that removal — e.g. by an interrupted run `hydrate()` must still recover — keeps parsing instead of failing strictObject's unrecognized-key check." An honest version of this proposal must add the same kind of legacy reader (a `z.union`/preprocess mapping 'starting' → 'running') plus its comment, which is roughly the LoC the deletion saves and leaves the vocabulary present forever.

  3. The "zero production reads" claim is also wrong as stated. `src/tools/executions/workflowSummaryView.ts:125` passes `status: call.status` through verbatim from the persisted snapshot into the /executions view, and `deriveWorkflowCounts` (workflowExecutionSnapshot.ts:129-141) builds a per-status tally keyed by `Object.values(WORKFLOW_CALL_STATUS)`, so `counts.starting` is a live derived field of that view. A user inspecting an interrupted run reads 'starting' there today.

  Minor corrections aside (the projection rows are :55 STARTING / :56 RUNNING, not :54/:55), the mechanical part of the proposal is separately harmless — `updateCall`'s extra work over `beginAttempt` is only `#refreshExitedStage`, which at workflowExecutionState.ts:413-421 settles a stage only when every call in it is terminal, so it is a no-op for a call transitioning to RUNNING. But that collapse alone saves ~3 lines and does not justify touching the persisted enum, which is where the claimed savings and all the risk live.

  </details>

- **Stop re-validating script, files, and checkpoint id at the WorkflowScriptTool → persistence → engine handoff**

  <details><summary>Why it was refuted</summary>

  All three legs fail on independent inspection.

  (a) REFUTED ON FACT. The claim's load-bearing premise — "parses 2 and 3 can only ever return their input" — is false for parse 3. `src/agent/workflowScript/runWorkflowScript.ts:845` reads `WorkflowScriptFilesSchema.parse(options.files ?? {})`, and `files` is OPTIONAL on the run options (`src/agent/workflowScript/types.ts:369` `files?: WorkflowScriptFiles`). When omitted, `{}` goes in and a NEW object with three `.prefault([])` arrays comes out. That value is not decorative: `runWorkflowScript.ts:846` `stableStringify(files)` → `filesJson` → `sandbox.ts:215-217` `parseJson(config.filesJson)` installs it as the script-visible frozen `files` global. The published contract (docs/guide/multi-agent-workflows.md:53 `files.inputFiles.slice(0, 2)`, :85; src/agent/workflowScript/README.md:86; packages/extension/resources/docs/agent-creation/tool_catalog.md:68) promises `files.inputFiles/.contextFiles/.mediaFiles` always exist. Deleting the parse makes `files` the bare `{}` for every caller that omits the option, and `files.inputFiles.slice(...)` throws inside the sandbox. `runWorkflowScript` is exported from the barrel (src/agent/workflowScript/index.ts:18), so this is a public host-neutral surface, not "the sole production caller." Worse, the parse sits inside a deliberately documented try (runWorkflowScript.ts:837-842): "an unserializable `args` value, AN INVALID `files` OPTION, or a bridge-serialization fault used to escape before `finish()` and leave the persisted snapshot permanently non-terminal." That is a fixed defect commented in place — checklist §15 says a load-bearing guard is not elegance to delete.

  (b) REFUTED BY A DATED RULING AND BY DATA-FLOW. `persistence.ts:232` is not a same-process re-assertion. The value it parses is `script = requestedScript ?? prior?.script` (persistence.ts:227), and `prior` comes from `readWorkflowScriptCheckpoint` (:219) — i.e. from execution KV, a true deserialization boundary. `WorkflowScriptCheckpointSchema` only pins `script: z.string().min(1)` (persistence.ts:40); nothing else re-establishes parseability before the script is adopted and re-persisted by `persistCheckpoint()` (:255). On the resume path `WorkflowScriptTool.ts:301` never runs (no `script` in input), so this is the FIRST parse, not the second. This is exactly the boundary-only validation rule ruled in #9434 and applied to this subsystem by bb14c01eb8 (#9966, "PersistedFlow validates the shared blob through sharedSchema only at true deserialization boundaries... Records the instance wrote itself are trusted"). The proposed hoist also mutates an exported engine signature to carry `{meta, body}` alongside `script`, creating a dual representation that must be kept in sync — element add, not removal. The claim itself hedges on this half.

  (c) Only leg with any merit, and it is thin. `CheckpointIdSchema` + `parseCheckpointId` + 3 sites is ~13 LoC on two EXPORTED functions (`readWorkflowScriptCheckpoint`, `writeWorkflowScriptCheckpoint`, index.ts:20-23). The claim's test analysis is also wrong: the tests at WorkflowScriptPersistence.vitest.ts:856/:870 are about malformed PERSISTED STATE (`store.write(..., null)`) and an unserializable journal result (`result: () => 1`), not id shape — nothing there targets `parseCheckpointId`, so nothing is freed. The tests at :933 ("preserves opaque checkpoint ids without normalizing them") and :956 ("maps maximum-length checkpoint ids to filesystem-safe keys") document intent tied to the `max(256)` bound; they are not retired validation.

  Prior-art check: docs/proposals/2026-08-16-overdefensive-top10.md (9 days old) is a repo-wide census of exactly this pattern class. Its §2 boundary charter names `runWorkflowScript.ts` in the KEEP column ("vm-sandboxed user-script values at runWorkflowScript.ts:428") and lists persisted-file reads as untouchable; its sweep list does not include any of these three sites. This candidate does not beat that ruling.

  Perf framing is also inflated: the vm cost in `parseScript.ts:141-149` is one 250 ms-capped `JSON.parse(JSON.stringify(literal))` on the meta object literal — microseconds — amortized against a workflow launch that spawns LLM agents.

  Net: leg (a) is a live behavior regression against a published contract, leg (b) is ruled by #9434/#9966 and is a genuine boundary, leg (c) is ~13 LoC on an exported error surface with mischaracterized test collateral. Below the bar; drop.

  </details>

### `agent-trace-misc`

- **Two exported types named ContextStateData: delete the trace-local shadow of the shared schema type**

  <details><summary>Why it was refuted</summary>

  The raw facts check out, but the diagnosis and the payoff do not.

  What I confirmed independently:
  - Both declarations exist: src/agent/trace/events.ts:47-51 (`export interface ContextStateData { readonly inputTokens; readonly contextWindow }`) and src/shared/schemas/contextManagement.ts:61-67 (`ContextStateDataSchema` with a third `utilizationPercent`).
  - Repo-wide grep for the identifier returns exactly the sites claimed. No hits in packages/extension/package.json, packages/extension/src/commands.ts, coreSettings.ts, stateSettings.ts, packages/extension/resources/, prompts/, or supabase/functions/. Wire strings ('context.state', MESSAGE_TYPES.CONTEXT_STATE = 'contextState') are unaffected by a type-name change.
  - Not re-exported from src/agent/trace/index.ts (its export list ends at line 18 and omits it), so no @agent/* SDK/Tier-1 or host-deep-import-baseline exposure.
  - No filed issue (`gh issue list --state all --search ContextStateData` returns 0; tech-debt label search returns nothing related). PR #6168 ("refactor/context-state-reuse-schema", merged 2026-06-18) touched only packages/extension/src/progressView/frontend/slices/logSlice.ts, not the trace type, so the dedupe claim survives.

  Why it is still refuted:

  1. The "dual-representation" framing is wrong, and that framing is the whole basis of the candidate. These are not two representations of one thing; they are a producer payload and a derived record. The trace type carries the two facts the model handler actually knows at emit time (src/agent/core/flows/CommonCycleTypes.ts:165-167 reads `inputTokens` from usage and `contextWindow` from `modelHandler.getEffectiveContextWindow()`). `utilizationPercent` is computed downstream, at src/controllers/session/SessionFactApplier.ts:183 and src/transcript/TexraTranscriptRecorder.ts:647, via `roundedUtilizationPercent(...)`. SessionFactApplier.ts:174-177 carries an explicit in-code justification for that split ("the handler that produced the response is the only authority on the window it actually used ... every host reads this one record instead of re-deriving from a model registry"). A name collision between a 2-field emit input and its 3-field derived record is not duplicated state; TypeScript module scoping already separates them, and both trace consumers use explicit type-only imports from './events'.

  2. The proposed remedy increases duplication rather than reducing elements. Deleting the named type writes the same anonymous structural literal at src/agent/trace/AgentTrace.ts:162 and src/agent/trace/TraceEmitter.ts:157, so the shape appears three times in the module (two inline copies plus the `ContextStateEvent` arm) instead of once behind a name that keeps the interface and its sole implementor in lockstep. The "two consumers" cited are the interface declaration and its implementation, i.e. the definitional pair, not speculative generality. That is not the single-caller-extraction pattern AGENTS.md abstraction discipline bans.

  3. The name was already deliberately narrowed. 87687be86d (2026-06-30, "macro round 2 phase 1 - logic consolidations and dead-code pruning") removed `ContextStateData`, `ContextStateEvent`, `StageStamp` and others from the index.ts re-export block: a considered decision to demote it from the SDK surface to a module-internal name while keeping it. The candidate does not beat that ruling, it just proposes one more cosmetic step.

  4. The payoff is overstated and thin. `contextState(snapshot: ContextStateData, options?: StagedEmitOptions): void;` is one line today; the inline literal exceeds the print width, so prettier re-wraps it to four. Honest arithmetic: -5 (interface plus doc comment) -2 (two type imports) +3 (AgentTrace signature wrap) = -4, not -6, in exchange for two uglier signatures on the AgentEvent contract file. Checklist 14 R5/R6: no element is genuinely retired, no behavior simplifies, and it is churn on a settled surface (src/agent/trace/events.ts is the AgentEvent side of the AgentEvent/SessionFact split).

  No catch/fallback is involved and nothing touches the CLI result-JSON contract, so section 15 and the texra-action risk bump do not apply.

  </details>

### `tools-delegation`

- **Fold settledWorkflowCall into cardFor so one table owns the terminal workflow-call card shape**

  <details><summary>Why it was refuted</summary>

  Not a dual representation. The two builders differ on every branch in emitted card content, not just identity source. src/tools/delegation/workflowScriptRun.ts:187-188 makes settledWorkflowCall unconditionally spend-only (no model, no durationMs), while cardFor:398-400 (completed/cancelled), :405 (non-sweep skipped) and :395 (non-sweep failed) emit terminalMetadata(call) (:355-367 = model + durationMs + cost). src/shared/copy/workflowCall.ts:62-65 renders model and duration on the terminal line, so this is user-visible output, not internal shape. call.settledBySweep is a snapshot fact, not "settled by this projection's finally sweep": the sweep at :559-573 fires for any projected card still planned/running, including one whose snapshot row is COMPLETED with settledBySweep=false, which today yields a deliberately metadata-poor card and through cardFor would gain model+duration. The switches also discriminate on different domains with opposite defaults: settledWorkflowCall switches on raw WORKFLOW_CALL_STATUS incl. undefined and converts non-terminal/missing into failed + WORKFLOW_CALL_UNFINISHED_NOTE (:200-208), whereas cardFor switches on the projected progress status (mapped via WORKFLOW_CALL_STATUS_PROJECTION at :50+) and its default (:406-407) is a pass-through returning planned/running/cached unchanged. The sweep would have to keep its own mapping/branch, i.e. the second switch the proposal claims to remove. cardFor is also not a terminal builder at all: it is called on every transition at :498 for planned/running, returns WorkflowCallProgress, and only settledWorkflowCall's WorkflowCallTerminalProgress return type keeps recordTerminalActivity(call) at :572 statically safe; folding forces the `as WorkflowCallTerminalProgress` cast at :521 into a second site. The comment at :387-389 the claim reads as "documented mirroring" covers the one branch where the two genuinely agree (sweep-settled failed), and exists because the others deliberately do not.

  </details>

### `tools-external`

- **Batch: drop three re-derivations of already-decided facts in the arXiv tools and the PR poller**

  <details><summary>Why it was refuted</summary>

  Item (c) is factually wrong and would break a test; items (a)/(b) are real but micro and (b)'s proposed fix creates a new duplication. Verified myself:

  (c) REFUTED. `src/test-kernel/tools/PRPollingSourceAnnotationPages.vitest.ts:69-83` builds its harness with `vi.resetModules()` followed by `await import('@tools/github/PRPollingSource')` and `await import('@tools/github/checkRunsClient')`. After `resetModules` the whole graph is re-evaluated, so `@tools/github/annotationFetchBudget` is a FRESH module with a FRESH `SharedAnnotationFetchBudget` instance (`src/tools/github/annotationFetchBudget.ts:83-88` is a module-level `new`). The static forwarder `PRPollingSource.resetAnnotationFetchBudgetForTests` (`src/tools/github/PRPollingSource.ts:214-220`) resolves to that fresh singleton — which is exactly why it exists, and the module doc at `annotationFetchBudget.ts:10-12` says so ("a single shared singleton is the authority; ... `PRPollingSource` exposes a test-only reset that targets the same instance"). A top-level `import { SharedAnnotationFetchBudget }` in the test file would reset the STALE instance bound at file load, while the code under test claims against the fresh one (50 tokens, not 0), so `PRPollingSourceAnnotationPages.vitest.ts:174-186` ("leaves queued annotation runs in place when the page budget is exhausted") would start calling `ghGet` and fail. A correct version has to add a dynamic `await import('@tools/github/annotationFetchBudget')` plus a new field to `createHarness` — relocating complexity, net LoC ~0, not a deletion.

  (a) TRUE but trivial. `extractEntryIdentifier` (`src/tools/arxiv/arxivShared.ts:50-56`) already returns `normaliseArxivIdentifier(...)`, and I confirmed empirically that `identifiers-arxiv`'s `extract` is idempotent on its own output for new-style, versioned, and old-style (`cs/0501072`, `math.NT/0501072`) ids, so the second call at `ArxivSearchTool.ts:139` is a no-op and `?? base.id` is unreachable. Worth about -3 LoC (expression + the now-unused import).

  (b) TRUE as a re-derivation, but the proposed fix is contested, not obviously better. `INVALID_ARXIV_INPUT_ERROR` is module-private (`src/latex/arxivProcessor.ts:44`, not exported), so the fix must add a new export; `validateId` also has a distinct empty-input message ("arXiv ID or URL is required", `arxivProcessor.ts:119`) that the replacement silently collapses into the invalid-format message — a user-visible tool-error change; and `ArxivDownloadTool.ts:65` plus `packages/extension/src/commands/latex/arXivCommands.ts:21` keep going through `ArxivProcessor.validateId`, so the sibling arXiv tools would end up validating ids two different ways. That ADDS a dual representation of the validation policy rather than removing one. The single-authority fix is to have the processor hand back the normalized id (one `validateId`-shaped API returning the value it already computed), which is a different, larger change than what was filed.

  Claimed -18 LoC is inflated roughly 4x: (c) nets ~0, (b) nets ~-2 after the new export, (a) nets ~-3. What remains is a ~-5 LoC cosmetic sweep spread over three unrelated files, which is below the section 13 / R5 churn bar for a filed issue.

  No production consumers were missed (grep for `resetAnnotationFetchBudgetForTests` outside dist: 1 definition + 3 test sites; `validateId`: 3 production call sites), no dated ruling exists in docs/ or AGENTS.md/CLAUDE.md, and none of the settled surfaces are touched.

  </details>

- **Delete GhCheckAnnotationSchema — a boundary schema that is never applied at the boundary**

  <details><summary>Why it was refuted</summary>

  REFUTED on three independent grounds.

  (1) The load-bearing premise is false. The claim asserts "every sibling schema IS applied", making the annotation schema a unique "third state". My own greps show otherwise. `src/tools/github/prTypes.ts` declares 11 schemas; several are declared purely for `z.infer` and are never applied at any boundary:
  - `GhCheckRunSchema` (prTypes.ts:69, type at :80) — no `GhCheckRunArraySchema` exists (`rg "GhCheckRunArraySchema" src packages` → 0 hits), and check-run payloads come back through an unchecked cast at `src/tools/github/checkRunsClient.ts:161` `const res = await ghGet<{...}>(...)`. Structurally identical to the annotation case the claim wants deleted.
  - `GhReviewSchema` (prTypes.ts:52) — no array schema; reviews arrive via unvalidated `ghGet<GhReview[]>` at `src/tools/github/PRPollingSource.ts:406`.
  - `GhUserSchema` (:13) and `GhCheckRunOutputSchema` (:64) are likewise never parsed on their own.
    So the annotation schema is the file's normal convention, not an anomaly. Deleting only it makes the file less uniform, not more.

  (2) There is a dated ruling the claim does not beat. `git log -- src/tools/github/prTypes.ts` surfaces commit `06b73201ee` ("refactor: zod-native + SSOT for GitHub poller REST shapes", 2026-06-22), whose message states the decision explicitly: "replace the 9 hand-written GitHub REST interfaces with z.looseObject schemas (extra fields tolerated) + z.infer types, making the schema the single source of truth", and — critically — "Validate the **state-driving** 200-path payloads at the poller boundary with NON-THROWING safeParse", because a throw on the 200 path would stall `lastSuccessAt` and trip `PollingSourceBase.handleFailure`'s 24h detach. Annotations are not state-driving (they are formatted into event text via `formatCheckAnnotations`), so their being unparsed is the ruling's intended outcome, not an oversight. The proposal is a per-shape revert of that commit.

  (3) The proposed direction contradicts standing repo policy. CLAUDE.md "Schemas (Zod v4)": "Schemas are the single source of truth: define the schema, derive types with `z.infer`." Replacing a Zod shape with a hand-written `interface` walks that backwards. The cited precedent is inverted: `src/tools/arxiv/arxivShared.ts:9-13` says plain types are for "the JSON the tools EMIT (built locally from already-typed arxiv-client entries), **not a parse boundary**". `GhCheckAnnotation` is the opposite — inbound external GitHub REST JSON. Under arxivShared's own stated rule it belongs as a schema.

  Element/LoC check (checklist §14 R5/R6, §13): the schema block is ~16 lines and the replacement interface ~12, so the prTypes half is LoC-neutral churn; nearly all of the claimed -28 is deleting a test and a baseline row, which the far smaller fix achieves anyway.

  What is genuinely true and residual: the `export` keyword on line 86 is stale. Its unapplied siblings (`GhCheckRunSchema`, `GhReviewSchema`) are correctly module-private; this one is exported with zero production importers, which is why knip carries it. The correct, minimal fix is to drop the word `export` (keeping the schema and `z.infer` type intact), delete the self-referential `safeParse` case at `src/test-kernel/tools/GitHubPrTypes.vitest.ts:66-77`, and remove the baseline row — a one-word production diff worth roughly -14 LoC. That is below the bar for a filed issue, and the candidate as written (delete the schema, hand-write an interface) must not be filed at all.

  Note the type itself is very much alive in production — `src/tools/github/formatPREvent.ts:28,66,83,172`, `src/tools/github/PRPollingSource.ts:75,786`, `src/tools/github/checkRunsClient.ts:19,336,337,343` — so "dead-export" describes only the binding name, not the shape.

  Dedupe: `gh issue list --state all --limit 30 --search "GhCheckAnnotation prTypes annotation schema"` → 0 results; `git log --all --grep="GhCheckAnnotation"` → 0. Not previously filed, but that does not rescue it.

  </details>

### `tools-session`

- **Demote 11 file-local type exports, drop the TerminalRunResult alias re-export, and delete two never-used validators**

  <details><summary>Why it was refuted</summary>

  Verified every sub-claim independently; the bundle fails on three of four items and the one survivor is already recorded.

  WHAT HOLDS: the 11 type exports do have zero cross-file references. I re-ran rg repo-wide for each symbol (src, packages, docs, config, supabase, prompts, YAML) and every one resolves only inside its defining file — src/tools/approval/tempFileManager.ts:40, src/tools/executions/conversationFormat.ts:17, src/tools/executions/processOutput.ts:35, src/tools/inquiry/ExternalInquiryTool.ts:146, src/tools/inquiry/inquiryActions.ts:57, src/tools/memory/memoryFileSystem.ts:42/:50/:290, src/tools/setup/platform.ts:31, src/tools/support/externalBinaryUtils.ts:99. None appears in config/ratchets/knip-baseline.json. The TerminalRunResult re-export at src/tools/setup/platform.ts:84 likewise has 0 production importers (packages/extension/src/frontend/setupTerminalRunner.ts:20 imports from @hosts/uiHosts) and 2 test importers.

  WHY IT IS STILL REFUTED:

  (a) Item 3 contradicts a standing repo mandate. AGENTS.md:209-211 ("Define schemas first, then derive TypeScript types using z.infer<typeof Schema>"), AGENTS.md:525, and CLAUDE.md "Schemas are the single source of truth" all require exactly the shape the claim wants deleted. BashApprovalRequestSchema (src/tools/approval/bashApproval.ts:36) is ALSO not an export at all — it is a plain const, and BashApprovalRequest at :41 is a plain type. So it is neither a dead export nor a rule violation; converting it to an interface would be the violation, and it saves ~2 lines.

  (b) Item 4 deletes a boundary parse for 1 line. src/tools/userQuestion/UserQuestionTool.ts:97 sits at the host->core seam with three independent producers (packages/extension/src/progressView/ProgressViewMessageHandler.ts:755, packages/desktop/src/main/desktopAgentExecution.ts:837, packages/cli/src/runtime/approvalAdapter.ts:232). The extension and desktop paths do safeParse upstream via createDispatcher (src/shared/utils/dispatcher.ts:138-148), so the claim is technically right — but src/shared/utils/dispatcher.ts:150-158 explicitly documents defense-in-depth re-checking as the repo's chosen pattern for exactly this situation. Trading a documented defense-in-depth check on model-visible output for -1 line is not a simplification.

  (c) Item 1 is already recorded, verbatim, in a dated proposals file. docs/proposals/2026-08-07-prod-structural-leads-triage.md lists it under the CONFIRMED verdicts with the identical fix ("repoint the two test imports to '@hosts/uiHosts', delete platform.ts:88"), scoped to a named "test-only-export wave"; docs/proposals/2026-08-10-simplifier-fleet-round1-strategy.md:35 names it again as area-04. That is a triaged, scoped, recorded lead. Worse, the proposal misses that src/tools/setup/platform.ts:71-83 is a 13-line JSDoc documenting setup-agent-specific terminal rationale (shellIntegration preference, undefined-exit-code semantics) that exists nowhere in src/hosts/uiHosts.ts. Deleting :84 orphans it: you either lose the doc or relocate it, which is churn the claim never budgets.

  (d) Item 2 is a repeat of an executed sweep, at 0 LoC. Un-exporting a type removes a keyword, not a line — net LoC is exactly zero for all 11. The identical class in the identical directory was already swept 7 days ago by #10855 -> merged as #10866 ("14 export keywords on types that never leave their module" in src/tools), and the same chore has been filed and closed four more times in the last four days (#11253, #11385, #11386, plus #11401 recording the gate blind spot). This is recognized recurring maintenance, not a non-obvious simplification finding.

  Nothing here touches the five ratchets, the frozen @agent/* surface, src/agent/node/index.ts, the platform composition root, the six browser-reachable @utils modules, the AgentEvent/SessionFact split, or the CLI result-JSON contract consumed by texra-action.

  </details>

### `shared-schemas`

- **Unexport the two shared-schemas type aliases that have no importer anywhere**

  <details><summary>Why it was refuted</summary>

  Facts check out, framing and value do not. (1) Zero-consumer claim CONFIRMED: repo-wide `rg --hidden -g '!node_modules'` plus a full token scan over every git-tracked src/ and packages/_/src file give only in-file hits for both names (src/shared/schemas/toolResult.ts:63,105 and src/shared/schemas/stateSettings.ts:170,191,1592), the sole outside hit being a prose comment naming FormattedZodIssueSchema at src/agent/core/tools/toolAttachmentExtraction.ts:63. (2) But "these two are the residual the #8844 sweep missed" is FALSE. I scanned the whole production tree (git-tracked src/\**/_.ts and packages/_/src/\**/_.{ts,tsx}, excluding src/test-kernel): 1628 `export type`/`export interface` declarations, of which 472 have zero references outside their own file. Two of them are named in a dated ruling: docs/proposals/2026-08-07-prod-structural-leads-triage.md lines 53-56 covers `DuplicateCallMap` (still exported today at src/agent/core/flows/toolCallParsing.ts:19, used only at :42-:43) and lines 383/413 record an explicit "Unexport micro-sweep" / "one unexport PR" class item, including `ViewBundle` (still exported at packages/extension/src/common/webview/BaseViewContentProvider.ts:35, used only at :55). This candidate is an arbitrary 2-of-472 slice of a class that was triaged 18 days ago and deliberately left as a single wave; filing it separately fragments that recorded plan. (3) The knip argument is a misread, not evidence. `npm run check:dead-code-ratchet` passes clean on main (411 combined vs 411 baselined) and neither `knip --include exports,types` nor the production run reports either name, while the same run DOES report an in-file-only-used exported interface elsewhere (SettingsTeamRosterPresentation, src/controllers/settingsView/SettingsTeamRosterController.ts:22, used only at :35). So absence from config/ratchets/knip-baseline.json is not "residue"; #8817/#8844 burned down _baselined knip findings_, and these two were never knip findings at all. Unexporting them therefore removes no baseline row and changes no tool output. (4) Value: net LoC 0 and net elements 0. Both type declarations stay declared and stay used; only two `export` keywords disappear. CLAUDE.md's bar is "fewer elements"; this removes none, and section 13/14 R5/R6 puts a 2-keyword, 0-line, tool-invisible edit below any filing bar. (5) Side note against it, not for it: FormattedZodIssue is the element type of exported `formatZodIssuesForDiagnostics` and ModelsTabSurface of exported `modelsTabSettings`, and both ship in the packages/agent declaration build (packages/agent/dist/types/src/shared/schemas/toolResult.d.ts:33,50 and stateSettings.d.ts:30,84) — naming a public signature's element type is normal TS practice, so this narrows ergonomics for a zero measurable gain. The one thing I could not confirm against the candidate is the proposal's stated blocker: I reproduced the exact shape with the repo's own tsc under `declaration: true, emitDeclarationOnly: true` and a non-exported local type in an exported signature emits cleanly (exit 0), so TS4023 does not fire here. The change is safe; it is simply not worth recording on its own.

  </details>

### `shared-rest`

- **Unexport six production-dead src/shared helpers and shrink their knip-baseline rows**

  <details><summary>Why it was refuted</summary>

  The consumer census is accurate but the candidate fails on economics, on two of its six items, and against a dated ruling.

  1. NET LoC IS INVERTED, NOT -6. The exact precedent the claim leans on measures the true cost: `git show --stat fe8e48145c` (PR #11260, 7 symbols, 3 suites) is **226 insertions / 138 deletions = net +88**, of which -42 was the baseline JSON. Rewriting tests through a public surface costs more than the export keyword saves. This candidate is strictly larger: 6 baseline rows (-36 JSON lines at `config/ratchets/knip-baseline.json:2141-2185`) against **six** test suites, not four — the claim missed `src/test-kernel/cli/TuiStateAndFocus.vitest.ts` and counts the two desktop suites as one. Affected suites total 938+ lines (`SubagentFollowup.vitest.ts` 481, `SharedStreams.vitest.ts` 221, `NormalizeToolUse.vitest.ts` 171, `StateSettingWrite.vitest.ts` 65) with ~60 direct call sites to re-point. Checklist §14 R5/R6: **zero elements are removed** — all six functions/types keep existing, they just lose `export`. This is relocation of test coupling at net-positive LoC.

  2. TWO OF SIX ITEMS ARE AFFIRMATIVELY WRONG.
     - `StreamStatusLabelStyle` (`src/shared/streams/streamStatusDisplay.ts:119`) is `keyof typeof STREAM_STATUS_LABELS`, and `STREAM_STATUS_LABELS` is declared **unexported** at `:64`. Unexporting the alias forces `SharedStreams.vitest.ts:150,170` to hand-write the style union literal — replacing a derived type with a duplicated literal. That is a regression, not a simplification. It is also exactly the case §4 of `docs/proposals/2026-08-19-dead-code-gate-blind-spots.md` labels "**Open question, not an established gap** … treat the twelve as unexplained rather than as evidence for a fourth mechanism" (issue #11401, closed as documentation only). A dated open question the claim does not beat.
     - `isUnsupported` (`src/shared/utils/dispatcher.ts:28`) is the type predicate paired with the exported `Unsupported` interface (`:21`) and the exported `unsupported()` constructor (`:24`), and it is imported in the **same import statement** as `assertSupported` in both desktop suites (`DesktopAgentSettingsController.vitest.ts:10`, `DesktopToolingSettingsController.vitest.ts:10`). The claim itself concedes `assertSupported` must stay as a sanctioned test affordance. The 2026-08-19 proposal's Risks section names `assertSupported` explicitly among "sanctioned test-only seams … required by AGENTS.md's no-bare-module-level-mutable-singletons rule and **must be baselined, not deleted**." Unexporting one half of a coherent public predicate/constructor/assertion trio to retire one JSON row is incoherent.

  3. THE `normalizeToolUseData` REWRITE LOSES A LOAD-BEARING DISTINCTION (§15). `normalizeToolUseForRender` is `normalizeToolUseData(data) ?? malformedToolUseFallback(data)` (`src/shared/toolUse.ts:211`). `NormalizeToolUse.vitest.ts:7-9` pins `toBeNull()` for malformed input — the precondition that the fallback exists to absorb. Routing those assertions through the wrapper indirects away the only tests that prove the null branch is reachable.

  4. NOT A DUPLICATE, but the sanctioned framing cuts against acting: `scripts/check-dead-code-ratchet.mjs:1-10` calls burn-down "a separate, scheduled sweep," and the proposal establishes that production-dead/test-alive is the _intended_ baseline population. These rows are grandfathered by design; retiring them is only worth it when a real export disappears, which here it does not.

  Not already done (`git log` on the five source files shows no unexport commit; `git log --all --grep` on the symbols returns only the original introducing commits). Not already filed (#11253 covers seven different `packages/extension/` symbols; #11385/#11386 cover approvalPolicy constants and controller types).

  </details>

### `controllers-progressview`

- **Carry one session handle through the progress-view command actions instead of four**

  <details><summary>Why it was refuted</summary>

  The core evidence is materially wrong on three counts, and the residual win falls below the bar. (1) Miscount: the four `?? currentSession()` sites in src/controllers/progressView/ProgressViewCommandHandlers.ts are :314, :363, :411, :420, but :314/:411/:420 all read the SAME field — `bypass.session`, destructured once at :325 (`const { session, showInfo } = actions.bypass`). Only :363 reads a second field (`followUp.session`). `externalInquiry.session` (:246) is never `?? currentSession()`-resolved. So this is one field read three times in three handler bodies, not "the same fact re-derived four times". (2) `externalInquiry.session` is a structural pass-through, not duplication: src/tools/inquiry/inquiryActions.ts:126-128 declares `continueExternalInquiryAction(transition, options: { session?: SessionHandle } = {})` and ProgressViewCommandHandlers.ts:457 forwards the whole `externalInquiry` bag into it. Removing the field relocates an element and adds a call-site literal rather than deleting one. (3) The second tier is not foldable: `ProgressViewSecondTierActions` (:464-525) belongs to a separate exported factory `createProgressViewSecondTierHandlers` (:542) that each host calls with its own deps object (desktopAgentExecution.ts:847-861/:921; ProgressViewMessageHandler.ts:247-315). Its `session` is required and EAGERLY resolved — the extension passes `defaultSession()` (ProgressViewMessageHandler.ts:254), which throws when uninitialized (SessionHandle.ts:1053-1057) — while the three optional fields resolve LAZILY via `currentSession()` (run-context session else default, SessionHandle.ts:1083-1085). Eager-required and lazy-optional are different resolution contracts; merging them means merging the two factories, which the file's own doc comments (:530-541) justify keeping split. Beyond the evidence errors, the change is risk-bearing: three of the four sites drive approval-bypass grants (setToolEditApprovalSessionBypass / setBashApprovalSessionBypass / approvals.setDelegatedWorkBypasses). The extension currently passes `undefined`, and src/tools/approval/toolEditApproval.ts:68-79 resolves `options?.session ?? currentSession()` at call time; a factory-construction-time `const session = actions.session ?? currentSession()` captures a handle instead, changing which SessionHandle owns an auto-approval grant — the exact hazard the single-owner-sessions work addressed. Checklist §14 R5/R6: the feasible version nets roughly -10 lines across three files while forcing churn through six `bypass: { session, ... }` construction sites in src/test-kernel/controllers/ProgressViewCommandHandlers.vitest.ts (:149, :446, :591, :680), and trades group-local dependency bags — one of which is literally a callee's options type — for a cross-cutting scalar wedged among bag-of-bags fields. Dedupe/design checks came back clean (no tech-debt issue matches; `git log --all --grep=ProgressViewCommandActions` returns only #11079; nothing in docs/proposals defends or forbids the split), so it is not a duplicate — it is simply too thin once corrected.

  </details>

- **Fold the per-host approval/follow-up/retry adapter lambdas into the shared progress-view command factories**

  <details><summary>Why it was refuted</summary>

  Refuted on dedupe, not on code facts. The duplication is real and I confirmed every cited site, but the candidate is covered by a just-closed issue carrying a dated owner ruling against it. gh issue list --state all --search "progress view host callback duplicate" surfaces #11282 "Consolidate cross-host settings/progress-view orchestration duplication (extension + desktop)" (tech-debt, area:progress-view, risk:medium, CLOSED 2026-08-23, two days before this claim). Its body explicitly scopes "the progress-view command-handler wiring has a similar shape across hosts", and its closing comment rules on exactly this surface: "The remaining progress-view command paths were rechecked during the review: both hosts already route first- and second-tier commands through the shared handler factories, with the residual wiring limited to host ports and policy. No parallel orchestration path remains to consolidate safely." The resolving PR #11305 touched only config/ratchets/knip-baseline.json, packages/desktop/src/main/desktopAgentSettingsController.ts, packages/desktop/src/main/index.ts, packages/extension/src/settingsView/handlers/agentHandlers.ts and src/controllers/settingsView/SettingsTeamRosterController.ts -- it never touched the progress-view handlers, so the progress-view half was closed by explicit review judgment rather than by code. #11282 also records why it is not a cheap deletion: a safe merge "needs live UI testing in both the VS Code extension host and Electron", and the only coverage today is the mocked bag in src/test-kernel/controllers/ProgressViewCommandHandlers.vitest.ts:106-162 plus ProgressViewRunCommands.vitest.ts:115-117, which would pass regardless of a routing regression. The claim's stated dedupe check searched "ProgressViewCommandHandlers" and "approval action mapper duplicated hosts progress view" and missed #11282 entirely, so its conclusion that "none covers the approval-action mapping" is unsupported. Nothing else refutes it: no docs/ or AGENTS.md/CLAUDE.md/config/ratchets ruling mentions submitBashDecision, applyFollowUpPlan or ProgressViewApprovalCommandActions; no settled surface is collapsed (no @agent/* deep import, no ratchet widening, no VS Code import into a free zone); it does not touch the CLI result-JSON contract; there is no catch/fallback involved. If the owner wants to revisit, the right move is a comment reopening #11282 with the byte-identity evidence, not a new issue.

  </details>

- **Sweep three residues in the progress-view backend: dead prepare-deletion boolean, single-caller UI-config factory, duplicate polish-failure arm**

  <details><summary>Why it was refuted</summary>

  All three sub-claims verified independently; the bundle survives only as a ~3-line residue plus two contestable rewrites, and its headline evidence is materially wrong.

  (a) FALSE as stated. The claim asserts the `P` generic and `prepared` capture "exist solely to carry that always-false value". They do not. src/controllers/progressView/backend/ProgressBackend.ts:481-487 is a LIVE producer of `true`: `this.prepareStreamDeletion(stream).catch((error) => { log.warn(...); return true; })`, and :488-494 turns that `true` into the `'failed'` retention outcome the SessionFactApplier depends on to retire its provisional removal barrier (doc comment at :464-467). `prepareStreamDeletionCore` still awaits `this.lifecycle.stopStream(stream)` (:588), which can reject, so that catch is load-bearing and is the loud, classified arm §15 explicitly accepts, not masking. What is genuinely vestigial is only the hardcoded `return false` at :590 (git log -L confirms f531898b80 deleted the `return true` branch along with `waitForExecutionQuiescence`) and the two `return false` at :594-595 — about 3 lines, since `.catch(() => true)` keeps `P = void | true` alive regardless. Reaching the claimed "drop the `P` generic, the `prepared` capture, and the `_prepared` parameter" requires replacing a clean prepare→work value channel with a mutable flag captured across an async boundary in `deleteStream` — a style downgrade in the tombstone/barrier path, not a simplification.

  (b) Misapplies AGENTS.md. AGENTS.md:634-640 "When factories ARE justified" lists "Need to capture closures with initialization context" as a standalone justification, and `createProgressBackendUiConfig` (src/controllers/progressView/backend/progressBackendUiConfig.ts:246-261) does exactly that, closing over `handlers`, `renderer`, and `canSend`. It is not the banned two-layer buildX/createX shape. It also lives in the module that owns `APPROVAL_REQUEST_HANDLER_KEYS` and `buildApprovalRequestHandlerSet`; inlining relocates the key-list iteration into ProgressBackend's constructor (§14 R5: relocation, not reduction) and forces retargeting src/test-kernel/progressView/ApprovalRequestHandlerSet.vitest.ts:103. Caller count is confirmed at 1 production + 1 test, and the two docs mentions are stale (that fix landed as the SessionFactApplier `deleteStream` dep at ProgressBackend.ts:169-172), so the docs neither defend nor block it — it is simply thin.

  (c) Not a duplicate arm. src/controllers/progressView/ProgressFollowUpPolishController.ts:44-56 distinguishes an expected polisher failure (`failed`, `userMessage = result.error` raw) from a thrown exception (`exception`, prefixed message plus `logData?: Error`); only the throw carries the Error object into `ports.logError` (src/controllers/progressView/followUpApply.ts:56-58). The `userMessage === logMessage` overlap is one redundant field, not a redundant arm. The proposed "always log a failure" is a behavior change on the non-throwing path, not a deletion, and it erases the thrown-vs-reported distinction the discriminated union exists to carry.

  Not already done (HEAD still has all three shapes), not filed (gh search returns only unrelated CLOSED #9862/#6286), no ratchet or settled-surface conflict. But with (a)'s headline evidence refuted, (b) permitted by the repo's own factory rule, and (c) a semantic collapse plus behavior change, the residue is ~3 lines of dead `return false` — below the bar for an issue; it belongs in the next code-simplifier sweep of that file.

  </details>

### `controllers-rest`

- **Collapse the identity-only getAgents/getVisibleAgents seam threaded from desktop into SettingsAgentControllerFactory**

  <details><summary>Why it was refuted</summary>

  The production facts check out, but the candidate is refuted as scoped, on two independently sufficient grounds.

  (1) It arbitrarily carves two members out of a uniform five-member identity-injection bag. The claim's whole distinguishing argument is "desktop passes the factory's own default." That is true of EVERY member of desktop's `registry` bag, not just these two: `packages/desktop/src/main/index.ts:679-688` passes `loadAgents` (imported :28), `refreshAgents: refresh` (:29), `loadAgentOptionsData: computeAgentOptionsData` (:24), `getAgents: getAgentsByCategory` (:26), `getVisibleAgents` (:27) — all five are byte-identical `@agent/index` re-exports handed straight through from the composition root, and the bag type at `packages/desktop/src/main/desktopAgentSettingsController.ts:67-72` declares all five together. Deleting exactly the two that happen to have `??` defaults downstream leaves an incoherent host seam (three identity injections retained, two hard-wired inside a shared factory) and does not remove the pattern the finding objects to. Whether `DefaultDesktopAgentSettingsController` should take a registry port at all is the real question, and it is a design-level item covering all five, not this bounded two-field deletion.

  (2) The evidence's consumer count is materially wrong, which invalidates the LoC and risk numbers. The claim says "test passers 1" and "the one test that uses the seam." There are three, because deleting the desktop option fields also breaks the desktop suites that inject through them: `src/test-kernel/desktop/DesktopAgentSettingsController.vitest.ts:49-50,67-68` (a 527-line suite whose entire fake catalog flows through `getAgents`/`getVisibleAgents`, including mid-test mutation at :351-368) and `src/test-kernel/desktop/DesktopSettingsCapabilityMarkers.vitest.ts:38-39`. Worse for the claim, `DesktopAgentSettingsController.vitest.ts:415-424` ("saves visible agents as a custom team") passes a `visibleCatalog` that deliberately DIVERGES from `catalog` — so the seam carries live test semantics, not just a duplicated default. Replacing it means converting three suites from typed constructor DI to hoisted `vi.mock('@agent/index')` module mocking, and the real `getVisibleAgents` (`src/agent/index/agentRegistry.ts:421-423` → `createWorkspaceAgentRosterController()` → `platform()` at :403) reads the process-global platform stores rather than the `FakeStateStore`s these tests construct, so the mock is mandatory, not optional. That is checklist §14 R5/R6 churn: complexity relocated from a typed seam into module-mock scaffolding, for roughly -12 production lines against +15-ish test lines.

  Not refuted on these axes, for the record: no missed production consumer (only two callers of `createSettingsAgentControllers` exist — `packages/extension/src/settingsView/handlers/agentHandlers.ts:70-75` passing neither, and the desktop controller at :160-167); nothing in `packages/extension/package.json`, `commands.ts`, the Zod settings schemas, `resources/` YAML, `prompts/`, or `supabase/functions/` references these names; no ratchet or settled surface is collapsed; not already done (`git log` on both paths shows d56d39c7c2 as the last relevant touch); not already filed (#11013 is CLOSED and covers `builtInOrchestratorAgentNames` only, on the explicit "zero production passers" criterion this pair fails). But note `docs/proposals/2026-08-16-services-injection-audit.md:138-157` (C14) already tiers this exact species and says "Do not pre-empt the ruling"; the landed Tier-3 ruling (`docs/proposals/2026-08-15-shared-contracts-and-retirement.md:493-496,537-544`) was "test seams move to test-kernel or die" for seams with zero production passers and self-labeled test helpers — a divergent-value DI option used by three suites is not that shape.

  </details>

### `platform-ports`

- **Retire the hex-16 legacy workspace-storage directory migration**

  <details><summary>Why it was refuted</summary>

  The symbol-level greps hold up, but the load-bearing premise ("expired compat — no reachable hex-16 directory can exist under a root read today") is false, and I falsified it on the live root rather than by argument.

  Confirmed parts: `src/platform/defaults/workspaceStorage.ts:30/107/139` are file-private, the only production call site is `getStoragePath()` at :187, and the only non-production pin is `src/test-kernel/platform/WorkspaceStorage.vitest.ts:143`. Full-tree grep (excluding node_modules/dist/.texra-validate-run build artifacts) finds no other reader; `'workspace-storage'` as a literal exists only at workspaceStorage.ts:22 (plus a comment at `src/platform/defaults/nodeStores.ts:113`), so no history/session enumerator touches these directories. No `package.json` contribution, command id, settings key, YAML, prompt, or supabase function references it. Not filed: absent from #9422 and from the #9627 table (both read in full); `gh issue list` surfaces only #4204 (the closed feature that introduced it). Not a settled surface, not a §15 masking site (the catch warns loudly and is not what the proposal is really about).

  What refutes it: `~/.texra/workspace-storage` on this machine holds 21 hex-16 directories today (2026-05-05 … 2026-05-18). I computed `truncatedHexId(path, 16)` over every modern directory's `_workspace.json` path and cross-matched: **0 of the 21 have a modern `basename-hex8` counterpart**, so `migrateLegacyWorkspaceStorage`'s guard (`!existsSync(legacyPath) || existsSync(currentPath)`) does not short-circuit for a single one of them. 15 of the 21 carry `executions/` payloads — 32 execution records in total (one directory has 13). Reopening any of those workspaces from any host today fires the rename and restores that history; delete the function and the same reopen silently starts an empty history and strands the data, which is the "silent degradation is a defect" case in CLAUDE.md, not an expired reader.

  The candidate's reachability window is also mis-dated: hex-16 naming landed in c26f4384f8 (2026-05-14, #3993), not with `DEFAULT_NODE_STORAGE_ROOT` (085578b6cd, 2026-05-15), and directories under this root are stamped as early as 2026-05-05 — so the affected cohort is wider than the claimed "4-day CLI-only window", and it is populated, not hypothetical.

  The appeal to the fe906df516 ruling does not carry it either. That commit deleted `migrateLegacyVscodeStorage`, which moved data _between roots_ that are no longer read at all; this one is an in-root rename whose source data demonstrably still sits under the one root every host reads. "Missed by that sweep" is speculation, and the commit's own message names its out-of-scope survivors, so a silent omission is not evidence of intent to delete. #9627's closing condition explicitly forbids retiring an undated compat branch by hand-waving — it asks for an exact path plus date or a permanent-boundary classification.

  35 lines of production code that recover 32 live execution records is not a simplification win. If anything survives here it is a bounded cleanup filed _after_ a one-shot sweep migrates or reports the remaining hex-16 directories, which is a different piece of work from this proposal.

  </details>

- **Trim ten never-imported declarations across the platform, hosts, and ambient-types surface**

  <details><summary>Why it was refuted</summary>

  Refuted on three independent grounds; only ~2 trivial items survive, well under the bar.

  (1) HALF THE BATCH IS ALREADY FILED. `docs/proposals/2026-08-07-prod-structural-leads-triage.md:194-196` records this exact lead by name: "Unexported-but-still-exported types (CreateLifecycleHostOptions, StatCapableFs, FileLockTuning, NodePlatformServices, etc.) have no non-test importers", with evidence citing `FileLockTuning (fileLocks.ts)` and `NodePlatformServices/NodeAgentDirectoryBootstrapOptions/NodeRuntimeSkillOptions (nodeHost.ts)` and the fix "drop `export` keyword or delete the type", batched into the test-only-export wave. A sibling lead in the same doc ("15 zero-production-caller exported types … prunable by type-export audit") covers the same class. The claim's dedupe check queried only `gh issue list` and never searched `docs/proposals/`, which is where this lead lives.

  (2) THE AMBIENT HALF IS REFUTED BY A DATED RULING. `22ae473752` (#11016, 2026-08-19) is the most recent commit on `src/types/ambient.d.ts` and its message states the governing hazard: the hand-written `sortablejs` stub "covered five properties out of the real surface, so any consumer reaching past them would have hit a phantom TS2353/TS7006". #11016 deleted _whole dead module blocks_ (mark.js, dep removed) and _shadowing_ declarations — it did not trim members from a live stub. The proposal here does exactly the inverse: `src/types/ambient.d.ts:106-112` is a complete, faithful stub of `turndown-plugin-gfm@1.0.2`, whose real surface is precisely `gfm, highlightedCodeBlock, strikethrough, tables, taskListItems` (verified against `node_modules/turndown-plugin-gfm`); the package ships no types, so this file is the only type source. Narrowing it to `gfm`, and deleting `BibLibrary.getEntry` (a real `bibtex` method — note `f2d401bc4d`/#9391 was a startup crash from mishandling this same untyped package), converts a correct third-party stub into an incomplete one whose next consumer gets a phantom TS2305. A `.d.ts` member also emits nothing, so this deletes no code that runs.

  (3) THE CLAIM'S OWN CITED AUTHORITY CONTRADICTS IT. `docs/proposals/2026-08-19-dead-code-gate-blind-spots.md:74-105` §4 is titled "Un-exporting a type is never flagged — **mechanism unconfirmed**" and states verbatim: "**Open question, not an established gap** … treat the twelve as unexplained rather than as evidence for a fourth mechanism", and asks for a specimen before writing it up. The claim asserts §4 "records exactly this blind spot"; it records the opposite. If these five types are that specimen, the doc's own ruling routes the work to the tooling fix ("one owner of 'dead'"), not a manual 10-item trim PR. Also relevant: that same doc warns "Every 'zero consumers' claim made with plain `rg` in this repo is unsound" because `~/.gitignore_global` hides tracked source — the claim used plain `rg` throughout. (I re-ran with `--no-ignore-vcs -g '!dist' -g '!*.js' -g '!*.html'` and the counts do hold, but the claim's method was unsound as stated.)

  Secondary: `NodePlatformServices`, `NodeRuntimeSkillOptions`, and `NodeAgentDirectoryBootstrapOptions` are the argument types of `createNodePlatform`, `initializeNodeRuntimeSkills`, and `bootstrapNodeAgentDirectories` — the three entry points `docs/architecture/2026-07-26-embedding-the-agent-runtime.md:34-214` documents as the SDK-embedder bootstrap sequence, reached from `packages/agent/src/node.ts:11`. Un-exporting the options type of a documented embedder entry point on a surface CLAUDE.md calls "frozen, not open" with an unfinished Tier-1 public manifest is not obviously a win. (I did check and empirically REFUTE the TS4023 hazard the 2026-08-07 doc raised for DuplicateCallMap: `tsc --declaration --emitDeclarationOnly` on a non-exported local interface used in an exported signature emits fine, exit 0. So that specific objection does not apply here.)

  Residue after removing the duplicate and ambient halves: two parameter defaults. `createNodeWorkspace`'s `getRoot` default is genuinely unreached (verified: `nodeHost.ts:119` and `packages/extension/src/extension.ts:238` both pass an argument; all other sites are test-kernel) — a 0-line token deletion. `WorktreeStateStore`'s `sharedKeys` is test-only (sole prod caller `extension.ts:252-256` passes 3 args) — a -1-line change, but the sub-proposal is actively harmful: today's test injects `new Set([sharedKey])`, exercising the namespacing mechanism independent of the key list; forcing it onto a real `WORKTREE_SHARED_KEYS` member pins an unrelated test to a list that is already scheduled to shrink (`docs/prds/2026-08-03-prd-approval-policy-unification.md:342,419` removes the `SUPER_YOLO_ENABLED` entry). That is CLAUDE.md's "test pinned to a churning seam", so "stronger than the synthetic one it injects today" is backwards.

  </details>

### `common-housekeeping`

- **Delete the empty 'audio' file-extension category and the null/empty carve-outs it forces on callers**

  <details><summary>Why it was refuted</summary>

  Not refuted on the facts — refuted as a new record. The dead code is real (I confirmed every grep), but the finding is already on record in an open dated proposal that the claimant's dedupe check never looked at. docs/proposals/2026-08-04-ssot-consolidation-part-2.md:429-440 (§7, workstream M4, "File-category vocabulary in 3+ places") names it verbatim: the hand-authored ExtensionCategory union "(fileTypeUtils.ts:12-13, bridged to the zod enum only by an `as` cast; includes a dead 'audio' arm; its doc comment points at a deleted type)". That proposal is Status: proposed / Date: 2026-08-04, unimplemented (the audio arm is still in the tree), and its §0 explicitly instructs that items the audit already owns must not be re-filed. Filing this as a standalone issue re-files a subset of M4 and would fragment it: M4's prescription is broader (satisfies-check the union against the zod enum in src/shared/schemas/fileTypes.ts, derive the context-only set from FILE_HANDLING_RULES instead of the hardcoded ['bib','bbl','cls','sty'] at MainViewDroppedFilesController.ts:100, share the per-host category-to-command map between fileSelectionRegistry.ts:24-56 and desktopFileSelection.ts:44-59), and deleting only the audio arm now leaves the same union to be reopened when M4 ships. Secondary weakening: the claimed net LoC is inflated and the out-of-area edit list is incomplete (see correctedEvidence), so what is left after dedupe is a ~-12-line cosmetic touch spanning 6 files in 3 packages. Nothing here is a settled surface (no ratchet, no @agent/* SDK edge, no AgentEvent/SessionFact split, no browser-safe @utils module), and the two fallbacks proposed for deletion are genuinely unreachable rather than load-bearing masking (checklist §15 M1-M6 does not bite: FileManager.ts:232's `allowedExtensions.size > 0` is dead because DocumentFileType is 'input'|'context'|'media', all non-empty, per src/shared/schemas/fileTypes.ts:3) — so the right disposition is to let M4 carry it, not to record it twice.

  </details>

- **Unexport five symbols with no consumer outside their defining file and drop the TeamPlan knip-baseline row**

  <details><summary>Why it was refuted</summary>

  Refuted on four independent grounds.

  (1) A dated, EXECUTED ruling already covers the buildTeamOptions half, and it went the other way. `git show d3c55fbf7b` (PR #9849, "refactor: structural waves A+D — test-only export shrink") is the very "test-only-export wave" that `docs/proposals/2026-08-07-prod-structural-leads-triage.md:233,236` names. It landed on this exact file: it unexported the sibling `teamExecutionFields` (`src/common/teams/TeamPlan.ts:205`, now `function teamExecutionFields`) and deleted its 16-line test, while deliberately leaving `export function buildTeamOptions` and its `describe('buildTeamOptions')` block untouched — the diff hunk context literally ends at that describe. The wave's own stated policy was "either unexport and test via the public entry, or keep as the wave's accepted direct-unit-test pattern"; it chose keep for this symbol. The candidate offers no new fact that beats that call.

  (2) The four SDK interfaces produce zero ratchet benefit — I verified empirically, not by grep. I ran the real gate command (`knip --include files,exports,types,duplicates --production`, 213 issues) and filtered for these files: the ONLY finding is `src/common/teams/TeamPlan.ts {'exports': ['buildTeamOptions']}`. None of `ChatGptSubscriptionLimit`/`GlmCodingPlanLimit`/`KimiCodeSubscriptionLimit`/`XaiSubscriptionLimit` is reported by knip in either run (knip counts same-file type usage as usage for the `types` category; the baseline's 57 `types` rows prove types ARE included, so this is not a reporting gap). No baseline row shrinks, and deleting an `export` keyword changes zero lines.

  (3) The claim's stated safety condition is factually wrong. It asserts `declaration: true` "is off today (no 'declaration' key in tsconfig.json)". `tsconfig.build.json` — the config `packages/agent`'s `build:types` script runs (`tsc -p ../../tsconfig.build.json`) — sets `"declaration": true, "emitDeclarationOnly": true`, and these repo-root files are inside that program: `packages/agent/dist/types/src/common/errors/sdkError/chatgptSubscriptionDetection.d.ts` currently emits `export interface ChatGptSubscriptionLimit`. Unexporting silently mutates the built (frozen, per CLAUDE.md) SDK type surface and makes the return type of the exported `parse*` functions unnameable to any consumer. It does not hard-break the build (I confirmed with a scratch `tsc --declaration` repro that TS emits a local interface rather than raising TS4060), but the claim's justification for why it is safe is not the reason it is safe.

  (4) Net LoC is positive, not -6. All five `export` removals are 0-line edits; the only -6 is the JSON baseline row. Against that, retargeting `src/test-kernel/common/teams/TeamPlan.vitest.ts:322-380` (a 59-line block covering built-in-order-vs-alphabetized-custom sort, icon/description mapping, `unavailableMembers`, and the capitalized disabled-reason path) onto `loadTeamOptions` means supplying all five ports per case plus async plumbing — the existing single `loadTeamOptions` case already runs ~25 lines for one scenario. That is +20 to +40 lines of test scaffolding to delete a 6-line JSON row, i.e. checklist §14 R5/R6 churn that relocates complexity. The only way to hit -6 is to delete the assertions outright, trading real uncovered coverage.

  Also disqualifying on process: the candidate itself discloses the buildTeamOptions lead is already recorded in a dated proposal, and neighbouring issues #11385/#11386 (both closed today, 2026-08-25) show this unexport genre is an actively-run batched wave — a one-symbol side entry is duplicate work against it.

  </details>

### `utils`

- **Retire @utils/core's `delay` and `perfect-debounce` re-exports; one sleep and one debounce already exist**

  <details><summary>Why it was refuted</summary>

  The primary leg (delay -> node:timers/promises) is refuted on semantics, not just churn. I wrote a throwaway vitest under src/test-kernel/utils/ and ran it (then deleted it); two behaviors diverge:

  (1) FAKE TIMERS. `delay` from npm honors `vi.useFakeTimers()`; `setTimeout` from `node:timers/promises` does NOT (it binds the internal timer implementation, not `globalThis.setTimeout`, so `vi.advanceTimersByTimeAsync(1000)` never resolves it). My test proved this: the npm-delay case passed, the node case failed. This is load-bearing exactly at the one site the claim calls out as the `{ signal }` user: src/agent/modelHandlers/support/BackgroundPoller.ts:259 is driven entirely by fake timers in src/test-kernel/agent/modelHandlers/BackgroundPoller.vitest.ts:107,128,153,183,211 and src/test-kernel/agent/modelHandlers/GoogleInteractionsBackground.vitest.ts:227, whose own header comment at :29 states "the `delay` package honors fake timers". Repointing BackgroundPoller hangs those suites. Same trap in src/test-kernel/agent/WorkflowScriptPersistence.vitest.ts and src/test-kernel/transcript/StreamLogStoreLoad.vitest.ts, which both use fake timers and import `delay` from @utils/core.

  (2) ABORT REASON. npm `delay` rejects with the caller's own abort reason (identity-preserving); node's rejects with its own `AbortError` and discards the reason. My test confirmed `rejects.toBe(reason)` passes for `delay` and fails for node. src/test-kernel/utils/UtilsCore.vitest.ts:218 pins that exact identity (`rejects.toBe(reason)`). The claim's "abort path is compatible" analysis only checked `name === 'AbortError'` and missed this.

  (3) CONSUMER UNDERCOUNT. The claim says "5 production consumers" and "repoint the 5 call sites". `rg "import \{[^}]*\bdelay\b[^}]*\} from '@utils/core'"` returns 16 files, ~60 call sites — 13 of them centralized test-kernel suites (DirectLspAdapter 22 calls, WorkflowScriptEngine 14, CodexSessionCoordinator 6, plus 10 more). Deleting the export breaks all of them at compile. Likewise `delay` is a dependency in three manifests (package.json:125, packages/trace-viewer/package.json:20, packages/agent/package.json:69), not one; `perfect-debounce` is in four (root:165, trace-viewer:35, agent:99, extension:1098).

  (4) DOCUMENTED SURFACE. AGENTS.md:138 enumerates `debounce` and `delay` as part of the documented `utils/core/` primitive surface, so either leg drags a guidance-doc edit through the guidance-refs check. docs/proposals/2026-06-23-google-interactions-background-spec.md:394,519,633 specify `import { delay } from '@utils/core'` by name and explicitly rest the test strategy on the package's fake-timer behavior — a dated design record this claim does not beat.

  The debounce leg is factually correct (I confirmed exactly one consumer: packages/extension/src/webview/MainViewProvider.ts:47,89 with the only invocation at :310), but on its own it is a one-caller rewrite worth roughly -5 LoC across five files plus a dependency drop from four manifests and an AGENTS.md edit — too thin to file, and note that createFlushableDebounce's own doc block at src/utils/core/index.ts:192 frames perfect-debounce as the named baseline it extends, so the re-export reads as the documented reference point rather than a leftover. Nothing was already done (git log on src/utils/core/index.ts shows no retirement) and nothing is already filed, but the candidate as written fails on evidence and on behavior.

  </details>

### `auth`

- **Trim the 19 test-only re-exports and 6 identity aliases from the @auth/codex, @auth/xai and SupabaseSession barrels**

  <details><summary>Why it was refuted</summary>

  Three independent grounds, any one sufficient.

  (1) The headline symbol is not dead, and the aliases are production-live. src/auth/codex/codexAuthAccess.ts:13 imports `type CodexSessionStatus` from './CodexSessionCoordinator' and :38 uses it as the declared return type of the production function `getCodexStatus(): Promise<CodexSessionStatus>`. The xai twin is identical: src/auth/xai/xaiAuthAccess.ts:12,31 -> `getXaiStatus(): Promise<XaiSessionStatus>`. The claim's boldfaced "CodexSessionStatus has ZERO references anywhere outside src/auth/ - not even a test" is true only outside src/auth, and misleads about the alias's role: it is the return-type vocabulary of the two functions every host calls. Only its barrel forward is unused, not the alias. Likewise XaiSessionStatus (one of the claimed "6 identity aliases") is not barrel-exported at all - src/auth/xai/index.ts:21-24 forwards only XaiSessionStorage/XaiOAuthClient - so "6 pure relabels, redundant at the boundary" is wrong on 2 of 6, and the other 3 are the declared field types of the production CodexSessionCoordinatorInit/XaiSessionCoordinatorInit interfaces (CodexSessionCoordinator.ts:41-42, XaiSessionCoordinator.ts:41-42).

  (2) A dated pass already adjudicated exactly these files and declined exactly this. docs/proposals/2026-08-07-prod-structural-leads-triage.md (307 leads, 21 adversarial verifiers, refute-by-default) contains a "Wave A - test-only-export wave" whose two auth entries are at :266-268 (xaiJwt) and :270-271 (the CodexSessionCoordinator.ts:40 alias). That wave shipped as commit d3c55fbf7b / #9849 ("structural waves A+D - test-only export shrink"), whose diff touches src/auth/codex/CodexSessionCoordinator.ts, src/auth/codex/index.ts, src/auth/xai/index.ts and src/auth/xai/xaiJwt.ts - every file this candidate targets. It deleted precisely the one alias with no in-file production use (CodexAuthorizeRequest) and the two genuinely dead xaiJwt functions, and left the three surviving aliases and the rest of both barrels standing. This candidate is the residue that a same-scope adversarial pass looked at and did not take.

  (3) Already filed and closed. #8879 ("trim dead barrel re-exports", CLOSED/COMPLETED, shipped as PR #8892) explicitly enumerates CodexSessionStatus inside its "~17 zero-consumer barrel re-exports in src/auth/codex/index.ts" delete list. The claim's dedupe check asserts #8879's set is disjoint from this one; it is not.

  Separately the arithmetic does not survive. The barrels carry explicit docstrings declaring them documented public surfaces (src/auth/codex/index.ts:1-11, src/auth/xai/index.ts:1-10), which is the exception CLAUDE.md's "no convenience barrels" rule carves out; and src/auth/SupabaseSession.ts:26-28 documents the forward block as deliberate: "Only the symbols consumers actually use are forwarded; the Zod schemas and callback/parse option types stay internal to supabaseSessionTypes." Removing 3 of those 9 forwards inverts that stated design to push a test into the module the comment calls internal. Every affected vitest currently imports through one block: CodexSessionCoordinator.vitest.ts:4-12 becomes 3-4 blocks, XaiSessionCoordinator.vitest.ts:3-10 likewise, CodexLoopbackLogin.vitest.ts:3-8 splits three ways, SupabaseSessionLifecycle.vitest.ts:8-15 gains a block, and five model-layer suites (ProviderCapabilities, ComputeModelOptions, ModelFactoryRouting, CodexSubscriptionFallback, CodexExperimentalTransports) each split one @auth/codex import into two or three deep ones. Source deletions total roughly -29 lines; test-side import churn adds roughly +25 to +30 across ~13 files, plus rename churn at ~20 CodexSessionStorage/CodexOAuthClient use sites. The pkce half is exactly 0 LoC (dropping `export` from two functions that remain, src/auth/oauth/pkce.ts:19,24).

  Nothing here touches a settled surface (no ratchet collapse, no @agent/* widening, no CLI result-JSON contract, no catch/fallback masking site), so risk is low - but low risk on a net-zero, already-adjudicated, already-filed change is churn under checklist 14/R5-R6, not a win.

  </details>

### `latex-replacement-model`

- **Batch: drop a defensive array copy and 21 per-site `satisfies` annotations a single field type would cover**

  <details><summary>Why it was refuted</summary>

  Item 2 — the bulk of the claim — is refuted by a dated, maintainer-adjudicated ruling that the claim misread, and independently by the compiler and by line accounting.

  (a) Closed issue #8914 ("compile-lock category names", shipped as adaa94e06b / #8931) contains a binding verifier correction: "The candidate's type-lock mechanism is wrong and does NOT compile at HEAD. Retyping types.ts:14,23 `name: string` against the coreSettings unions breaks on four internal categories whose names are outside the unions ('all' engine.ts:161, 'custom_regex' engine.ts:193, 'max_auto', 'max_manual'). Apply the lock at the engine registry arrays' element type or via per-exported-constant annotations instead." The 21 per-site `satisfies` clauses ARE the adjudicated mechanism, not a half-finished job. The claim's dedupe check read #8914 and concluded the declaration-level half "was never done" — the issue says it was deliberately rejected.

  (b) The ruling still binds at HEAD. Two outliers survive: src/replacement/engine.ts:201 `name: 'all'` in a value annotated `NonRegexReplacementCategory` (return type at :180) and src/replacement/engine.ts:233 `name: 'custom_regex'` in a `RegexReplacementCategory[]`. Neither name is in the shared unions, so the proposed retype of src/replacement/types.ts:14,22 fails to typecheck. Widening the shared arrays to include them is not a fix: NON_REGEX_REPLACEMENT_CATEGORIES / REGEX_REPLACEMENT_CATEGORIES are the persisted-config universe via z.enum at src/shared/schemas/coreSettings.ts:343,347, so 'all'/'custom_regex' would become config-accepted names that selectEnabledCategories (engine.ts:168-175) can never match — a silently no-op setting, the exact drift the registry test guards. The only compiling variant is `name: Name | 'all'` in types.ts, which relocates the exception into the shared interface rather than deleting it (checklist 14/R5 churn).

  (c) The LoC claim is inflated. Every one of the 21 `satisfies` clauses is a same-line suffix on an existing `name:` line (rules.ts:23,37,174,195,203,324,448,527,542,612,626,747; rulesRegex.ts:84,99,112,152,180,220,338; maxRules.ts:474,594), so deleting them removes ZERO lines. Real deletions are 4 import lines (rules.ts:20, rulesRegex.ts:2, maxRules.ts:3-4) plus ~6 test lines, against +3-5 added in types.ts: item 2 nets roughly -5, not the implied bulk of -28.

  Item 1 is real but thin and its evidence is wrong. The copy at src/model/copilotRouting.ts:32 is genuinely unobserved (setCopilotRoutePreference:45 uses non-mutating filter/spread; the sole prod consumer does `new Set(...)`). But "test-kernel = 0" is false — src/test-kernel/model/RuntimeModelRegistry.vitest.ts:10 imports it and :358 asserts on it — so the rename touches three files, and the injection port `deps.getPreferredCopilotRouteModels` (SettingsModelSelectionController.ts:41,79) either churns with it or is left mismatched. Net ~-8 for a same-process readonly handoff, which is not enough to carry a batch whose other half is refuted by a standing ruling.

  </details>

### `transcript`

- **Drop eight transcript exports with zero production consumers and shrink the knip baseline**

  <details><summary>Why it was refuted</summary>

  The observation ("zero production consumers") is accurate for all six symbols, but the proposal is refuted on four of them and mispriced on the rest. (a) StreamLogAppendInput and StreamLogDelta are not dead barrel exports: they name the signatures of classes the barrel exports and production imports — StreamLogDeltaBuffer.push(delta: StreamLogDelta) via packages/cli/src/chat/tui/state/subscribeStreamLog.ts:34, StreamLog.append(entry: StreamLogAppendInput) via packages/cli/src/chat/tui/state/transcriptFold.ts:42, and StreamLogStore.append/appendSettled (src/transcript/StreamLogStore.ts:224-225) via src/agent/storage/SessionStores.ts:15 and src/controllers/session/SessionState.ts:25. Removing them leaves the barrel's own exported API un-nameable from the barrel; knip --production cannot see this. (b) resolveTranscriptSpillPath is settled by the very commit the claim cites: git show 5f320df0a3 is 'src/transcript/index.ts | 6 +-----', one file, 1 insertion 5 deletions — the author deliberately removed the barrel re-export and kept the module export. src/transcript/spillArtifacts.ts:14-31 is a security predicate (posix/win32 absolute-path rejection, '..' rejection, .txt whitelist, ExecutionIdSchema check); both proposed substitutes collapse reject and absent into the same undefined (readTranscriptSpill swallows isFileNotFoundError at :42, findTranscriptSpillFile gates on StorageFS.isFile at :52), so routing the 8-row table at src/test-kernel/transcript/TexraTranscriptRecorder.vitest.ts:630-647 through them is a weakened security test, not a deletion. (c) The STREAM_LOGS_DIR/STREAM_LOG_SUMMARIES_DIR rewiring turns one canonical constant into four local copies of WORKSPACE_STORAGE_LAYOUT.streamLogs across src/test-kernel/transcript/StreamLogStoreLoad.vitest.ts:25, src/test-kernel/cli/History.vitest.ts:107, src/test-kernel/cli/CliPersistenceFlush.vitest.ts:18, src/test-kernel/desktop/DesktopAgentExecution.vitest.ts:69 — checklist R5/R6 relocation, not removal. (d) Process: config/ratchets/knip-baseline.json holds 402 production-dead rows of 411 total; scripts/check-dead-code-ratchet.mjs:4-5 states baseline burn-down is a separate scheduled sweep, and docs/proposals/2026-08-19-dead-code-gate-blind-spots.md:184-197 rules that test-only exports are reported and baselined, with sanctioned test-only seams 'baselined, not deleted'. Eight hand-picked rows out of 402 is churn against a dated ruling. The only residual (drop the two index.ts barrel lines for the two DIR constants, tests deep-import @transcript/StreamLogStore as StreamLogStoreLoad.vitest.ts:29 already does) is 0 net source lines and 2 of 402 rows — too thin to file.

  </details>

- **Remove three defensive copies and one single-caller wrapper that #11402 left behind**

  <details><summary>Why it was refuted</summary>

  Two of the three legs are wrong, and the third is below the filing bar.

  LEG 1 (snapshotFromMemory clones) — REFUTED by a dated ruling that the claim reproduces rather than beats. The clones were added deliberately by `8d8a074040 fix(transcript): clone round-indexed records in snapshotFromMemory (#7547)`, closing issue #7546 (CLOSED, labels bug/risk:medium, filed off a Bugbot finding on PR #7532). That commit message states the candidate's exact argument and then rejects it as a reason to omit the clone: "the StreamSnapshotSchema.parse() call inside assembleSnapshot already reconstructs both the array and each item fresh (verified directly ... ) so a caller mutating the returned snapshot's outputFilesByRound today can't actually corrupt the store. This change is defense-in-depth / consistency ... it stops relying on assembleSnapshot's specific zod-parse behavior." So the proposal is a straight revert of a merged bug fix, justified by the very reasoning that fix already considered. The candidate's dedupe check searched "cloneRoundIndexed defensive copy" and found #11400/#11408 but missed #7546/#7547 entirely. Secondary point: the candidate is right that the comment at src/transcript/StreamSnapshotStore.ts:1119 mislabels snapshotFromMemory as "the write path" (grep confirms the only caller is line 1823 inside `async read()`), but that is a one-line comment correction, not a deletion — 0 LoC, and it does not license the revert.

  LEG 2 (StreamLog.toJSON) — REFUTED on a missed-consumer count and on a proposal that nets zero. The claim says "the one external consumer of readEntries" is src/tools/ExecutionsTool.ts:728. There are three production consumers: ExecutionsTool.ts:728, src/transcript/traceAssembler.ts:49, and src/transcript/completedRunArchive.ts:350. traceAssembler assigns the result to `TraceDocument.entries`, typed `z.array(StreamLogEntrySchema)` at src/transcript/traceDocumentSchema.ts:26, i.e. mutable `StreamLogEntry[]`. Retyping readEntries to `readonly StreamLogEntry[]` breaks that assignment, so the fix is either `[...entries]` at the call site (the copy reappears, net 0) or making TraceDocument's array readonly, which ripples into the trace-viewer mirror — unrelated churn for zero deletion. The proposal's third step is also a misread: StreamLogStore.ts:904 is `new StreamLog([...diskEntries.entries, ...live.toJSON()], ...)`, a concatenation of two arrays; the `...live.toJSON()` spread is structural and cannot be "dropped". No line count changes anywhere in this leg — only type annotations — so its LoC contribution is 0, not part of -22.

  LEG 3 (resolveAdjacentStreamCleanup) — SURVIVES but is too thin to file. Verified: one production caller (packages/cli/src/runtime/history.ts:346), one non-production file (src/test-kernel/cli/History.vitest.ts:113/1114/1167), and createStandaloneStreamCleanup (src/transcript/adjacentStreamCleanup.ts:88) is called only from it. Folding the `??` into history.ts and exporting createStandaloneStreamCleanup nets about -5 LoC, trades one export for another (no element reduction), and forces churn at two test call sites. On its own that is a cosmetic tidy, not a tech-debt issue.

  Nothing here touches the five ratchets, the frozen @agent/* surface, the PocketFlow engine, the browser-safe utils set, the AgentEvent/SessionFact split, or the CLI result-JSON contract, so risk is low — but the batch as pitched is a revert of a merged fix plus a no-op retype plus a 5-line tidy, against a claimed -22.

  </details>

### `cli-tui-state-input`

- **Retire two plugin-shaped knobs in the slash registry and the shared list form (batched)**

  <details><summary>Why it was refuted</summary>

  Part (a) is refuted on arithmetic and forced churn; part (b) is real but ~3 lines, so the batch as proposed does not stand.

  (a) The factual greps check out — `packages/cli/src/chat/tui/commands/registerBuiltins.tsx` has exactly 22 `registerSlashCommand({` and 22 `category:` lines, and it is the only production caller (`rg -n registerSlashCommand`: every other hit is `src/test-kernel/cli/{SlashRegistry,InputBar,SlashCommandDispatch,ConfigForm,SlashHelpText}.vitest.ts`, plus `packages/cli/scripts/tui-harness.tsx` which only imports the query/format helpers and never builds a `SlashCommand` literal). But the proposal's own step — "make `category` required on `SlashCommand`" — breaks 17 typechecked call sites that pass no category: `src/test-kernel/cli/SlashRegistry.vitest.ts:707,708,709,723,733,734,743,744,751,752,761,789`, `src/test-kernel/cli/InputBar.vitest.ts:135,177,183`, `src/test-kernel/cli/SlashCommandDispatch.vitest.ts:595,613`. These are not excluded from typecheck: root `package.json` runs `npm run typecheck:test-kernel` as part of `npm run typecheck`. Nine of those are one-liners (`registerSlashCommand({ name: 'model', description: 'pick a model' });`) that prettier will split to five lines once a `category:` field is added (+4 each = +36), and eight are already multi-line (+1 each = +8). Against that, the production deletion is tiny: `helpText.ts` loses the `{ category: undefined, label: 'Other' }` row and its two-line comment (-3), `slashRegistry.ts` loses two comment lines and flips `?` (-2, the type line stays), and the `SlashHelpText.vitest.ts` "Other section" case is ~13 lines. Net for (a) is roughly **+24 lines**, not part of a -25 win — textbook checklist §14 R6 churn that relocates a knob into 17 unrelated test edits across three files. The only way to avoid that churn is to keep `category` optional and delete just the `Other` row, which would make an uncategorized command silently vanish from `/help` (§15 silent-degradation), so that variant is worse.

  (b) `descriptionFor` is genuinely dead: `rg -n descriptionFor` over the whole repo returns exactly `ListForm.tsx:288,308,336` plus unrelated `--vscode-descriptionForeground` CSS hits, and its siblings (`detailFor`/`detailRowsFor`/`compactDetailFor`) do have callers in `SkillsListForm.tsx`. Deleting it is -3 lines (line 336 disappears entirely rather than degrading to `description={listProps.description}`, since `{...listProps}` already spreads it). Twelve forms pass the plain `description` prop, which stays. That is a correct but very thin observation — a line-item for a future ListForm props sweep, not an issue of its own.

  Dedupe/rulings: `gh issue list --state all --search "descriptionFor ListForm"`, `"SlashCommandCategory"`, and `--label tech-debt --search "slash registry speculative"` all return zero rows, and nothing in `docs/proposals/`, `docs/architecture/`, `AGENTS.md`, `CLAUDE.md`, or `config/ratchets/` rules on the category model (`2026-08-16-services-injection-audit.md:151` covers only `unregisterSlashCommand`, correctly excluded). So it is not a duplicate — it simply does not pay. No settled surface is touched and the CLI result-JSON contract is not involved, so risk stays low.

  </details>

### `desktop-main`

- **Retire the desktop Sentry crash-reporting path whose product surface was already removed**

  <details><summary>Why it was refuted</summary>

  Refuted on two independent grounds.

  (1) A recent, deliberate, owner-approved ruling already decided exactly this and kept the surviving path on purpose. `git show b8df8b98fd -- packages/desktop/src/main/desktopCrashReporting.ts` shows PR #9490 (2026-08-01, 3.5 weeks ago) is precisely the change that deleted `DESKTOP_CRASH_REPORTING_DSN_SECRET`, `getDesktopCrashReportingStatus`, `setDesktopCrashReportingEnabled`, `setDesktopCrashReportingDsn`, and the `GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED` gate — and in the same diff ADDED the env-var read plus the doc comment at `packages/desktop/src/main/desktopCrashReporting.ts:8-11`: "Native crash capture is a developer-build affordance: it turns on only when TEXRA_SENTRY_DSN is set in the environment, and there is no UI for it." The candidate cites #9490 as proof the feature is dead; the diff shows #9490 is the review that consciously narrowed it to this env-gated stub and documented the intent. "No UI" and "no DSN committed" are the stated design, not evidence of abandonment. A DSN is a secret; its absence from `.github/workflows/` proves nothing about intent.

  (2) It is unshipped pre-release infrastructure with an open, documented release gate, not expired generality. `docs/prds/2026-05-02-prd-electron-app.md:1008` (Phase 7: "Sentry Electron SDK opt-in, native crashes only, tracesSampleRate: 0. beforeSend strips file paths outside workspace root") and `:1066` ("Sentry confirms <1% crash rate on native code paths in beta cohort before public v1") are both unfulfilled. `docs/guide/desktop.md:13-16` confirms the desktop app is still in beta with the public installer pipeline incomplete, and `gh release list --repo texra-ai/texra-desktop-releases` returns "Could not resolve to a Repository" — the release repo does not exist yet. The candidate's own "never had a public release" point therefore cuts the other way: the code is waiting for the release that provisions the DSN, and deleting it now guarantees re-adding the same ~78 lines plus the dependency at v1. Checklist 14/R6: a delete-then-restore cycle, not a net element reduction.

  The scrubber is also not idle weight — `createDesktopCrashEventScrubber` is the path-redaction privacy safeguard the PRD names as a requirement, and it is the only thing the 45-line test covers.

  The one genuinely load-bearing observation in the claim is the bundle cost, which I re-measured and confirmed: 3,458,059 of 26,547,187 input bytes in `packages/desktop/dist/main/metafile.json` come from `@sentry/*` + `@opentelemetry/*` (~13%). But the remedy for a dynamically-imported optional dep being statically bundled is marking it external in `packages/desktop/esbuild.main.options.mjs`, not deleting a PRD-gated feature — a different, smaller finding the proposal as framed does not make.

  </details>

### `ext-progressview`

- **Drop the last defensive copies in syncSlice and the TOOL_ICON_MAP entry for a tool named 'runs'**

  <details><summary>Why it was refuted</summary>

  Part (b) is refuted outright: `runs` is not a nonexistent tool. `git log --all -S"name: 'runs'"` surfaces commit 0d352ebfe0 (2026-02-10) "rename tools: runs → executions, propose_workflow → delegate_workflow, propose_agent → delegate_agent", plus the original "feat: implement runs tool for agent history access". So `packages/extension/src/progressView/frontend/formatters/constants.ts:179 runs: 'clock-rotate-left'` is precisely the retired-tool case the block at constants.ts:122-133 documents (str_replace_editor / apply_path / crossref_doi / ls kept so persisted progress entries from past runs render with the right glyph instead of the 'wrench' fallback at htmlBuilders.ts:296). The corroborating breadcrumb src/common/storage/storageLayout.ts:10 `runs: 'executions'` is the same rename in the storage layer. Deleting the entry is a silent degradation of historical transcript rendering, not a dead-key removal, and the claim's stated rationale ("no transcript can contain that tool name") is false. Part (a) is technically correct but too thin and mis-sized. I confirmed the copy boundary myself: every leaf in src/shared/schemas/progressView/projectionShape.ts is a real Zod record/object (RunUsageMapSchema, roundIndexedRecord(...)), so parseResult.data (src/shared/utils/dispatcher.ts:150-152) is a fresh graph on both entry paths — the webview window message via packages/extension/src/progressView/frontend/ProgressApp.ts and the in-realm trace-viewer replay at packages/trace-viewer/src/replayTrace.ts, which calls dispatchMessage with a locally built buildStreamContentRender payload. The only later writers are mutative copy-on-write (packages/extension/src/progressView/frontend/slices/runTrackingSlice.ts:41-47 and :72), so nothing mutates the parsed objects. But the payoff is 2 lines, not 6, and the spreads were never real defensive copies anyway (shallow over records of arrays/objects) — churn-level under checklist 13/14 R5/R6.

  </details>

### `ext-settingsview`

- **Delete the LaTeX frontend field vocabulary and its 14-row field-to-key translation map**

  <details><summary>Why it was refuted</summary>

  Refuted on three grounds. (1) It relocates the duplication instead of deleting it. LATEX_CONFIG_DEFAULTS and LATEX_CONFIG_RANGES stay field-keyed (the claim concedes this, and they must — src/shared/schemas/stateSettings.ts:1172-1294, src/agent/implementations/flows/reflection/output/compileCheck.ts:46, packages/extension/src/commands/latex/latexdiffCommands.ts:395 read them by field). Because the catalog key is semantically different from the field name (WORKFLOW_AUTO_COMPILE = 'texra.workflow.autoCompileAfterOutput'), each of the 9 compile/diff rows in LaTeXTab.ts:774-845 would end up naming the same setting twice under two different vocabularies: `field: WorkspaceStateKey.WORKFLOW_AUTO_COMPILE` beside `defaultValue: LATEX_CONFIG_DEFAULTS.workflowAutoCompile` and `currentValue: cv[WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]`. The field->key correspondence stated once in the map becomes implicit and repeated at 9 sites — checklist 14 R5/R6 churn, not element reduction. (2) It deletes the only compile-time guard on this path. latexConfig.ts:80 `} as const satisfies Record<keyof LatexConfigValues, string>` makes a frontend field with no catalog key a type error today; after re-keying, a stale or typo'd key in LatexConfigValues type-checks fine and silently renders undefined forever, because data.values is Readonly<Record<string, unknown>> and the latex snapshot key set exists only at runtime. Trading a static completeness check for a silent-default failure mode is a §15-style degradation, not elegance. (3) The surface was deliberately settled four days ago: 549ae9f80c (2026-08-21) hoisted this exact map with the stated purpose "so the completeness check and the map live once", in the same week as f4e3bd7fae (catalog-derived latex snapshot, 2026-08-20) and d7c30c3efc (#11272, 2026-08-21). The candidate does not beat that ruling — it removes the check that ruling was about. Net element change is -1 exported const for ~31 mechanical rewrite sites and roughly -18 lines after prettier rewraps the longer generic constraints and cv[...] indexing; too thin to justify the diff. Not already done and not already filed, but drop on merit.

  </details>

### `ext-webview`

- **Delete the notifyWhenEmpty wire flag: two of its three commands have zero producers**

  <details><summary>Why it was refuted</summary>

  Two of the three factual pillars hold (no producer sets the flag on REQUEST_BASE_FILE or REQUEST_RECENT_COMMITS; desktop ignores it), but the framing as dead code fails on two counts. (a) The REQUEST_EDITED_FILE arm is live: packages/extension/src/webview/frontend/mainViewActions.ts:216-219 sets notifyWhenEmpty: true and is reached from a real user control (packages/extension/src/webview/frontend/components/LatexDiffsSection.ts:244 -> MainApp.ts:632), so packages/extension/src/webview/managers/FileManager.ts:65-67 executes today. (b) The DiffManager toast is an unwired feature, not residue: the user-facing refresh-commits button (LatexDiffsSection.ts:248 -> MainApp.ts:636 -> REFRESH_COMMITS -> packages/extension/src/webview/slices/documentSlice.ts:33 postRecentCommits() with no argument) is precisely the path notifyWhenEmpty exists to serve, and it currently returns no feedback when the workspace has no commits or is not a Git repo. Under CLAUDE.md's "silent degradation is a defect", DiffManager.ts:56-62 is the loud branch and documentSlice.ts:33 is the defect; the competing fix is a one-token change (postRecentCommits(true)) at +0 LoC. docs/prds/2026-01-30-dual-logic-features.md:63 records the option as part of the intended fetchRecentCommits API for a DiffManager consolidation that was never executed, so this is unfinished design intent rather than accidental leftovers. Choosing deletion over wiring is a design call, not a bounded dead-code sweep, and the win (~-18 LoC, dragging a cross-area edit into src/shared/schemas/mainView/inbound.ts) is too thin to justify unilaterally cementing the silent refresh.

  </details>

- **Collapse two alias-only MainView event pairs and two always-supplied optional callbacks**

  <details><summary>Why it was refuted</summary>

  Verified independently; the consumer counts hold but the item does not clear the filing bar, and part (a)'s premise is wrong.

  Consumer verification (my own greps, repo-wide, all extensions, not just .ts): `browse-all-agents` / `manage-teams` / `agent-settings` / `team-settings` appear only at packages/extension/src/webview/frontend/events.ts:147/149/151/153 (factories), InstructionPanel.ts:239/251/355/359 (dispatch), MainApp.ts:446-449 (bind), plus the three test assertions. No package.json contribution, no commands.ts registration, no coreSettings/stateSettings key, no resources/ YAML, no prompts/, no supabase/functions/ hit; the only other matches are the sentinel string constants in src/shared/utils/selectTemplates.ts:36/43 (a different wire value, `__browse-all-agents__`, untouched by the proposal) and minified trace-viewer bundles. Desktop is not a second listener: packages/desktop/src/renderer/main.ts:56/287 imports `@webview/frontend` and instantiates the same `<main-app>`, so MainApp.ts is the single binding site for both hosts. So no missed production consumer — but that is where the claim stops being right.

  (a) is not speculative generality; it is a documented deliberate alias. MainApp.ts:193-194 carries an explicit comment: "Team settings + the team picker's 'Manage teams…' tail both open the multi-agent settings section." The two events name two distinct user gestures on two distinct controls with different mechanics — a `wa-select` sentinel intercept that restores the prior selection before dispatching (InstructionPanel.ts:235-243, :246-254) versus an icon button (`#agentSettingsButton` / `#teamSettingsButton`, :429/:454/:482). events.ts's own header states the vocabulary is the typed contract for "both dispatch and handler sides", i.e. named per gesture, not per current destination. Collapsing makes InstructionPanel dispatch `agent-settings` from a control labeled "Browse all agents…" and `team-settings` from "Manage teams…", and leaves InstructionPanelLauncher.vitest.ts:271-290 with two tests asserting the same event name for two different gestures. That relocates the distinction into comments instead of deleting it (checklist §14 R5/R6: element churn, not element reduction). docs/prds/2026-06-11-agent-native-onboarding.md:225-227 and :331 treat "Browse all agents…" as a named affordance in its own right.

  (b) is legitimate in kind — #10871 ("delete dead props, params, and test-only fallbacks") set exactly this precedent for ProgressBackend ("test-only fallbacks made required … test constructions get explicit stubs"), and it touched MainViewMessageHandler.ts in that same commit without taking these two. But it is a two-optional-marker change worth ~0 LoC: making the params required and dropping 8 `?.` deletes no lines, and the single test construction (src/test-kernel/webview/MainViewMessageHandler.vitest.ts:148) gains stub arguments, so it nets positive.

  Net accounting: events.ts -4 (two entries plus their blank separators), MainApp.ts -2, InstructionPanel.ts/tests 0, (b) roughly +1. About -5, not the claimed -10, split across two unrelated micro-items batched into one filing — which is not a bounded deletion. Not already done (git log -20 on events.ts / MainViewMessageHandler.ts / mainViewInboundContext.ts: 2d82c8138e, 9c57b5a01a, 033c0248b9, 8b71e6149d, none touched these), not already filed (gh issue searches returned only the unrelated closed #6518), and it touches none of the settled surfaces or the CLI result-JSON contract. Drop as refuted-in-part and too thin.

  </details>

### `ext-host`

- **Derive contributes.menus.commandPalette from the command catalog; it already drifted**

  <details><summary>Why it was refuted</summary>

  Refuted as a simplification: it deletes nothing and nets ~+50 LoC plus three new elements. The 198 lines of `packages/extension/package.json:724-921` do not leave the tree under the proposal — they become generator output, exactly like the already-generated 50-row `contributes.commands`, so the file's line count is unchanged (+4 for the grok row). The additions are real: a new `CommandCatalogEntry` field, a new exported `packageCommandPaletteMenus` derivation beside `src/shared/commands/catalog.ts:428`, ~15 per-entry annotations, a destructure in `scripts/sync-package-contributes.mjs:44`, and a regeneration of `scripts/extension-package-invariants.snapshot.json:211` (a SECOND gate the claim never mentions, run by `check:extension-package-invariants` at `.github/workflows/ci.yml:214`). Checklist 14 R5/R6: relocates authorship, nets positive LoC, adds elements. Separately the proposed design is unsound as written — see corrected evidence. The underlying drift IS real and verified, but it is a 4-line bug fix, not a tech-debt simplification, so this candidate should not be recorded as one. Not a duplicate (#7103 scoped codegen to configuration+commands and omitted menus by scope, not by ruling; #3052 is the closed origin of the hand-authored gate); no docs/proposals, AGENTS.md, or config/ratchets ruling touches contributes.menus; touches none of the settled surfaces (five ratchets, frozen @agent/* surface, src/agent/node/index.ts, host/platform composition, six browser-safe @utils modules, AgentEvent/SessionFact).

  </details>

### `scripts-config`

- **Batch three small script/config cleanups: one dead export, one single-caller module, one duplicated zone list**

  <details><summary>Why it was refuted</summary>

  All three sub-items are either zero-value, net-churn, or actively worse than the status quo; the batch as a whole is too thin to file.

  (a) Zero LoC and mis-stated evidence. `scripts/aliasUtils.mjs:64` is indeed used only at `:90` in the same file (grep -rl across the repo returns only that file), but the fix is deleting the word `export` — 0 lines removed. The supporting reasoning is also wrong: `knip.json:7` lists `"scripts/**/*.mjs!"` as a root-workspace _entry_ pattern, so knip does scan `scripts/**`; entry-file exports are simply not reported by default (`includeEntryExports` is off). So its absence from `config/ratchets/knip-baseline.json` is a deliberate configuration choice, not proof of a "new" dead export. Nothing to file.

  (b) Relocates complexity into an already-oversized file, against the established pattern in `scripts/`. `scripts/verify-desktop-package.mjs` is 728 lines and already composes three sibling helper modules (`extension-package-utils.mjs`, `walkFiles.mjs`, `desktop-package-metafile-paths.mjs`). Sibling helper modules are the organizing pattern here: `walkFiles.mjs` has 7 importers and `extension-package-utils.mjs` has 5 (including `src/test-kernel/scripts/DesktopPackagePayload.vitest.ts`). `desktop-package-metafile-paths.mjs` was born together with its logic in `143bb9ccd4` ("fix: resolve desktop metafile relative imports"), i.e. it is a purpose-built split out of a 700-line script, not a speculative extraction. Inlining moves 22 lines back into a 728-line file (pushing it to ~750) for a net of roughly -8 lines. AGENTS.md:645 bans "any _new_ shared helper" with one caller at review time; it does not mandate re-inlining existing script modules. The behavior is covered by `src/test-kernel/scripts/DesktopPackagePayload.vitest.ts:152`, which spawns the verifier, so the change is safe — just not worth it.

  (c) Trades a 15-string literal for a heavier coupling, and does not even complete the dedup. The mirroring is documented as deliberate in three places: CLAUDE.md:94 ("mirrored in ... keep both in sync with this list and with each other"), the rationale block at `src/test-kernel/architecture/dependencyDirection.vitest.ts:20-25`, and `src/README.md:44`. The CLAUDE.md copy survives the proposed fix, so two of the three copies remain. Worse, the mechanics are not what the claim assumes: `eslint.config.mjs` is outside the TS project (tsconfig `include` is `src/**` + `packages/extension/src/**`), so the cited precedent `AliasMapGeneration.vitest.ts:25` is _not_ a static import — it is `pathToFileURL(...)` + a dynamic `await import()` with a hand-written cast. Applying that shape to `dependencyDirection.vitest.ts` would execute `eslint.config.mjs`'s entire top-level import graph (`typescript-eslint`, `@stylistic/eslint-plugin`, `eslint-plugin-import-x`, `eslint-plugin-unicorn`, `globals`, plus `loadAliasEntries()` reading tsconfig) inside a vitest worker just to read one string array, and add an untyped cast. That is a real net loss for ~11 lines. It also lands outside the candidate's own area.

  Not already done and not already filed (checked `git log` on all three paths; #3351 is an additive change to the zone list, #8910 is the unrelated alias/esbuild item). Refutation is on value and design, not on novelty.

  </details>

- **Delete the TypeScript-grammar self-test cases from check-browser-safe-utils.mjs**

  <details><summary>Why it was refuted</summary>

  The claim's load-bearing premise — that the ~30 targeted cases "assert the TypeScript compiler's parser, not `dependencySpecifier`'s own choices" — is false. I read `dependencySpecifier` at `scripts/check-browser-safe-utils.mjs:101-159`: the type-only erasure rules are hand-written conditionals in THIS file, not delegated wholesale to the compiler. Specifically `:105` `if (clause.isTypeOnly) return null;`, `:108-115` `clause.name == null && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)`, `:123` `node.isTypeOnly` on ExportDeclaration, `:126-129` the same four-part condition for NamedExports, and `:135` `if (node.isTypeOnly) return null;` on ImportEqualsDeclaration. Every case the claim names drives one of those hand-written branches: `:245` `{ type as }` and `:249` `{ type as as Value }` exercise `every(isTypeOnly)` on inputs where a text-matching reimplementation gives the opposite answer; `:212` `import value, { type helper }` is the only case pinning the `clause.name == null` clause; `:269` `import type É = require(...)` is the only case pinning `:135`. Delete them and a rewrite that drops `clause.name == null` or reverts to element-text matching passes CI silently.

  Decisive second finding: these are not leftover grammar trivia, they are regression cases for five FILED AND FIXED defects. `gh issue list --search "browser-safe utils self-test"` returns #10256 "Keep aliased runtime `type` bindings reachable", #10257 "Mask per-binding comments in the browser-safe utils type-only detector", #10258 "Skip type-only import-equals", #10274 "Keep aliased `as` imports type-only", #10275 "Preserve commented default imports named `type`" — all CLOSED, and each maps one-to-one onto a case in the block the proposal deletes (`:241` `{ type as value }`, `:285-301` the comment cases, `:269`/`:325` the import-equals cases, `:245`/`:249`, `:281` `import /* note */ type from './value'`). Deleting proven regression coverage for filed bugs is checklist §15-adjacent (removing a tripwire so a known failure returns quietly), not §14 R5 defensive machinery. CLAUDE.md testing discipline caps NEW tests per PR; it does not license removing existing regression coverage.

  Cost side fails too. The block is a static array of string literals in a script with 8 commits total, the last two (`ad965a97f5` walker consolidation, `46ab5d981c`) mechanical and unrelated to the cases. It is not a churning seam, costs microseconds, and has no maintenance drag — the "tests are merge friction" rationale does not apply.

  The guard is also on the settled-surfaces list: `.claude/skills/find-simplification/SKILL.md:25` names `scripts/check-browser-safe-utils.mjs` and its six-module reachable set as an intentional constraint.

  </details>

### `resources-prompts-supabase`

- **Batch three in-area duplications: a byte-twin .tex resource, a re-declared bearerToken, two unreachable trace-viewer listeners**

  <details><summary>Why it was refuted</summary>

  Two of the three parts are wrong on the merits, and the survivor is below the bar.

  (b) is a security/blast-radius regression, not a dedupe. `supabase/functions/_shared/auth.ts:8` imports `SUPABASE_URL`/`SUPABASE_ANON_KEY` from `_shared/edgeClients.ts`, whose module body is side-effecting: `edgeClients.ts:28` `export const adminClient = createEdgeClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)` and `:34` `anonClient`, plus a top-level `@supabase/supabase-js` import. Deno Deploy does not tree-shake module side effects, and `createClient(...)` is not pure-annotated, so pulling `bearerToken` from `_shared/auth.ts` into `github-app-token-exchange` instantiates a **service-role** Supabase client inside an endpoint that is deployed `--no-verify-jwt` and, by its own header comment (`index.ts:5-6`), deliberately verifies GitHub's OIDC token and never a Supabase user JWT. The claim's "the import edge exists" is true only for `_shared/cors.ts` and `_shared/responses.ts`, which have no such module-level clients. The four local lines are a dependency firewall; deleting them buys -4 LoC and hands an unauthenticated public function DB authority it currently does not link against.

  (c) deletes a documented backstop under an invariant the claimant's own evidence shows is leaky. The claim proves `FileList.ts:323` renders `.file-actions` with no `archived` guard — i.e. `archived` is _not_ uniformly applied across the panel surface — and then argues the two sibling listeners can go because `archived` is applied everywhere else. That is the exact class of leak the wiring backstops. It is also inert twice over already: `eventHandlers.ts:76-77` early-returns (`const streamId = appState.get().activeStreamId; if (!streamId) return;`), and the trace viewer never sets an active stream, so `handleToolbarCommand` cannot post anything even if dispatched. Value: -8 lines of wiring plus two import names in a non-core package — churn-class under §14 R5. Checklist §15's M6 is a rule for _new_ defensive wrappers appearing in a diff, not a mandate to strip an existing, comment-justified safety net.

  (a) is real but thin and mildly regressive. The two files are byte-identical but for a trailing space at line 22 (verified), consumers are exactly `presenter.yaml:7` and `paper2slide.yaml:9` (plus build copies under `packages/cli/dist` and `.texra-validate-run`), and the resolver at `src/agent/prompt/userVars.ts:525` (`path.resolve(agentPath, filePath)`, `agentPath` = `path.dirname(resolution.entry.path)` per `AgentLaunchContext.ts:475`) does allow escaping the agent dir. But the cited precedent is not equivalent: `SHARED_LATEX_RULES_REL` is a code-owned constant read through `AbsoluteFS.read(...).catch(() => '')` (`userVars.ts:200`), a tolerated miss; a `requiredFilesInternal` miss returns null from `setVarFromFile` and silently leaves `TEMPLATE_SLIDE_CONTENT` undefined with `throwOnUndefined` disabled. And "Customize agent" copies **only the YAML** into the custom agents dir (`SettingsAgentActions.ts:151-161`), so the escaped path would resolve outside the user's custom dir instead of failing locally. `packages/extension/resources/agents/write/` also keeps `template_poster.tex` and two `.sty` files locally, so the directory does not get simpler. Net: 39 of the claimed 54 lines are a LaTeX asset, not production code; residual production delta after dropping (b) and (c) is zero.

  Also worth correcting for anyone who picks this up: the trace viewer transitively imports `@shared/hostBridge`, whose module-level `export const hostBridge = resolveHostBridgeApi()` (`src/shared/hostBridge.ts:25`) throws outside a TeXRA host. It is present as a top-level `var Zo=Xo();` in the shipped bundle `packages/extension/resources/traceViewer/index.html`, with no stub installed by `src/transcript/standaloneTraceHtml.ts` or `packages/trace-viewer/src/index.html`. Whatever the truth of that (it deserves its own look), it means the claim's reachability argument for keeping `file-action` is not established either.

  No prior filings: `gh issue list --state all --search "template_slide"` and `"bearerToken"` → 0 hits; `"trace-viewer archived listener"` → only #6951 (closed).

  </details>

## 4. Acceptance criteria

Per lane PR:

- Title uses `refactor:` / `simplify:` / `consolidate:` / `dedupe:`, which
  activates the letter-level template: the body carries `## Net elements (R6)`
  (files, `^[+-]export` symbols, class/interface/enum declarations, net LoC from
  `git diff --stat origin/main`) and `## Consumer counts (R8)` (grepped
  subscriber/caller counts for every deleted emit path or public symbol).
- `npm run format`, `npm run compile:safe`, `npm run lint`, `npm test` pass.
- `npm run check:dead-code-ratchet` passes, with `knip-baseline.json` rows
  removed in the same PR as the exports they cover.
- Tests pinning deleted behavior are deleted with it, not rewritten around it.
  No new tests beyond the testing-discipline bar.
- Behavior-preserving. A candidate that turns out to change behavior on contact
  is dropped from the lane and recorded back here instead.

## 5. Risks

- Several candidates shrink a ratchet baseline. That is the sanctioned
  direction, but the row must leave in the same PR as the export it covers.
- `L7`’s `format-staged` cut is the largest single item (-1100 LoC) and
  touches commit-time tooling. Verify the pre-commit hook still runs on a real
  staged change before merging.
- Several of these areas were touched in the last week (#11402, #11404,
  #11410). Rebase onto `origin/main` before opening each PR and re-check the
  cited line numbers.
