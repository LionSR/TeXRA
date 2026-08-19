# Simplification survey — 2026-08-19

Five-domain read-only survey (agent runtime, model handlers/tools, platform &
hosts/webviews, storage & compatibility, build/infra & packaged assets), run
immediately after the relay removal landed. Every candidate below carries
grepped production-vs-test consumer counts; leads that were checked and
rejected are recorded too, because the rejections are what stop the next
survey from re-walking the same ground.

Dedupe base: open `tech-debt` issues #10857, #10867, #10869, #10870, #10897,
#10899, #10905, #10915, #10917, #10920, #10921, #10922, #10933, #10938,
#10944, #10945, #10946.

## Already actioned in this pass

- **`ModelRetryGate.isUnobservedFailure` deleted.** A miss in the relay
  removal itself: commit `368ee4f601` deleted `trailingRoutes` and the
  admission-release flags but left this hook, whose only producers were
  `isRelayAdmissionFailure` and a `'relay-limit'` predicate. Zero production
  producers remained. Removed with its one test and two never-asserted
  harness fields.
- **Issues #10920, #10921, #10922 corrected** — see "Tracker drift" below.

## Candidates, ranked

### A. Dead public surface on three `@agent/*` barrels — 13 re-export lines

`src/agent/runtime/index.ts:104,116`, `src/agent/storage/index.ts:20,21,39,40,53`,
`src/agent/index/index.ts:12,14,15,16,27,34`. These barrels are documented as
derived from host use ("exactly the symbols the three hosts reach for today").
Thirteen entries have **zero importers outside `src/agent/`**. Underlying
symbols stay; only the door narrows. −13 public-surface entries. Low risk.

Do **not** extend this to `@agent/trace`: that barrel doubles as the
intra-agent import door, so its host-less exports are live.

### B. `normalizeLegacyModel` is the identity function — dual filename arm unreachable

`src/shared/constants/workflowOutput.ts:64-66,92,116` and
`src/housekeeping/utils.ts:13,47,72,88-100`. The helper strips dots from model
ids to reconstruct filename-era outputs. **Verified empirically: all 147
`llm-zoo` registry keys are dot-free**, and only registry keys reach it, so
`legacyModel === model` always and both emitted pattern families are
byte-identical. ≈ −22 prod LoC, −1 export, −10 test LoC. Low risk.

Note the enclosing filename grammar has a live writer and a dated horizon
(2027-04-21, #6984) — only this dot-stripping sub-arm is separable.

### C. `ProviderCapabilityProfile.authMode` — a discriminant read as a null check

`src/model/providerCapabilities.ts:18,119,204`; reads at
`modelHandlerXAI.ts:73-75`, `modelHandlerCodex.ts:228-231,245-247,287`. Each
read compares against the only value its resolver can emit, i.e. `!= null`
spelled long. −1 interface field, −1 type alias, ≈ −12 LoC. Low risk.

### D. Webview `localResourceRoots` grants five paths that do not ship

`packages/extension/src/common/webview/resourceRoots.ts:10-18`. Of eight roots,
`src/shared/styles`, `src/common/modules`, `src/common/constants`,
`src/common/webview` and `dist/shared` are either absent from the repo or
excluded from the VSIX (pinned by
`scripts/extension-package-invariants.snapshot.json:688-699`). Only
`src/common/styles` and `dist/<view>` are ever fetched. −5 lines and a
CSP/permission tightening. Low risk.

### E. Quota-limit prose written twice — 4 `describe*Limit` vs the route catalog

`chatgptSubscriptionDetection.ts:73-84`, `xaiSubscriptionDetection.ts:50-60`,
`kimiCodeSubscriptionDetection.ts:71-84`, `glmCodingPlanDetection.ts:117-127`
each hand-write the sentence the catalog already owns via `retrySourceName` /
`retryFallbackName` (`quotaFallbackRoutes.ts:38-53`,
`codingPlanSubscriptions.ts:55-56,88-89`). **The drift is already visible**:
the catalog says "your own Moonshot API keys", the detector says "key".
Keep the four `parse*` detectors (genuinely different wire signals); delete
the four `describe*` and three duplicate result interfaces. ≈ −70 LoC, −7
exports. Medium risk — user-visible copy, and four suites assert exact
strings. Not a banned extraction: the shared table already exists with four
entries; this deletes the mirror.

### F. Injection seams with zero production passers

Same species, batchable: `builtInOrchestratorAgentNames`
(`SettingsAgentControllerFactory.ts:45,100-101`,
`SettingsAgentCatalogController.ts:57,85,244-246` — the union computes
`X ∪ X`); `TerminalRunRequest.cwd`/`.env` (`src/hosts/uiHosts.ts:81-82`,
making `hasLaunchOverrides` permanently false at
`setupTerminalRunner.ts:50-57`); desktop `debugMode`/`getTheme`
(`desktopViewStateIpc.ts:13-14,34-35`, `mainViewIpc.ts:30-31,80-81`);
`ResumeQueuedToolUseOptions`'s residual `'tools'` (`resumeQueuedToolUse.ts:24-31,142`);
`toolInjections` (`runToolUseFlow.ts:98,193`, `agentToolResolution.ts:61,111,146`);
`SignedInProbeSlot.setProbe(null)` (`signedInProbe.ts:18,27-29`). Each is
low risk individually; `toolInjections` is medium because four tests use it to
isolate from module-global registrations.

### G. Build/infra

- **Collapse the `remote-agent-docs` CI lane** into the ungated
  `guidance-refs` job: `.github/workflows/ci.yml:36,53,62-77,96-108,126-131,219-223,225-251,544,578,600-606`.
  The whole `drift_gate_match` classifier exists only because one _code_ input
  (`docs/supabase/remote-agents.config.json`) lives under `docs/`. ≈ −73 YAML
  lines and one fewer job. **Medium risk: branch protection pins check names,
  so it must be updated in the same change or PRs block forever.**
- **De-duplicate the Lit `dedupe` list** across `packages/desktop/vite.config.ts:20-26`,
  `packages/trace-viewer/vite.config.ts:38-44`, `vite.standalone.config.ts:42-48`
  into `scripts/aliases.mjs`, which all three already import. Three callers, so
  not a single-caller extraction. ≈ −11 LoC. Low risk.

### H. Compatibility — fold into #10857 rather than filing separately

`backfillFirstRunDone` (`src/shared/state/onboardingState.ts:58-81`, with
independently re-derived preflights at `extension.ts:336-365` and
`runOnboarding.tsx:130-156`) is an undated one-shot upgrader. Mechanical
horizon ≈ 2026-09-11 from the onboarding PRD. Self-heals; failure mode is one
spurious onboarding pass. Desktop never calls it at all, so that cohort is
already unprotected. Wants a date, not an immediate deletion.

## Needs a ruling

- **`parseStreamMeta`'s executionId-drop retry** (`streamSnapshotRead.ts:130-152`).
  No producer of a malformed FK exists (the sole writer persists a typed
  `ExecutionId`), but the salvaged meta is written back **without** the FK, so
  the repair is permanent for a settled stream. Deleting costs the
  `parentStreamId` edge for a corrupt file; keeping costs a silent FK drop.
- **`repairLegacySelection`'s remaining bare-pair arm**
  (`AgentRosterController.ts:114-120`). The shared schema's permanence
  rationale is immutable run-history rows; this call site is a _rewrite_ event,
  so by that same criterion it is retireable while the history reader stays.
  The bare-pair arm currently has no test coverage.

## Flagged, not simplifications

- **`docs/scripts/check-root-docs.mjs` runs only in pre-commit.** Confirmed:
  no hit in `.github/workflows/`. `docs/.vitepress/publicDocs.js:4` and
  `config.js:213` both call it "the CI gate", which overstates enforcement —
  pre-commit requires opt-in `npm run hooks:install`. Given that a stray
  root-level doc can freeze the texra.ai deploy, this gate belongs in CI.
- **`packages/cli/scripts/validate-pack.mjs` is a four-way orphan but must not
  be deleted.** It is the only guard stopping `.ts`, `src/`, `.map` and
  `chatExport.tex` from shipping in the published npm tarball. This is a
  wire-it lead.
- **`.github/workflows/release.yml:149-197`** — a 49-line `if: ${{ false }}`
  job. Dead, but `docs/proposals/2026-08-01-directory-organization.md:82,331`
  records the disabled state as intended. Needs a human decision, not a sweep.

## Tracker drift corrected

- **#10921** listed five relay tolerance sites; three no longer apply.
  `'relay-limit'` is deleted; `log-usage` is permanent, not dated (released
  wire format, batches validate whole); the `UsageRouteSchema` trio is
  compile-locked together and is a maintainer decision, not a calendar item.
- **#10920** carried the ordering bug: nothing server-side may happen until
  the removal release ships, and "empty the provider list" is
  `supabase secrets unset`, not a config edit — its old steps 1 and 4 were the
  same operation.
- **#10922** proposes collapsing the name with _ten_ call sites onto the one
  with five. The distinction already fails to hold (`RemoteAgentLoader.ts:32`
  gates the catalog on `isAuthenticated`), and `getSetupAuthStatus` calls both,
  making `remoteAgentCatalogAvailable` a duplicate of `authenticated`.

## Sub-areas confirmed clean

`src/agent/trace/`, `src/agent/core/usage/`, `src/agent/core/tools/`,
`src/agent/core/definition/`; `src/agent/modelHandlers/support|utils/`,
`src/model/apiProviders.ts`, `openRouterRouting.ts`, `runModelDecision.ts`,
`src/tools/core/`; all 13 `src/platform/defaults/` modules; every
`GlobalStateKey`/`WorkspaceStateKey`; **desktop compat machinery** (one
unrelated comment repo-wide — there is no dead-on-arrival desktop migration
code to delete); the three webview trees (already collapsed onto the shared
dispatcher; further extraction would net-add); `prompts/`, `supabase/functions/`,
`packages/extension/resources/`, and all 50 `package.json` command
contributions (handler diff empty in both directions).

`config/ratchets/` yields no shrink today: the dead-code ratchet reports 8
current vs 8 baselined with zero stale entries, and the shared-schemas baseline
has already collapsed to a single genuine cycle floor.

## Net-elements note

Every candidate above is a deletion or a narrowing; none introduces a new
port, facade, or helper. The one item that touches shared structure (G's
`dedupe` list) moves an existing constant to an existing shared module with
three callers.
