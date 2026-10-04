# Plugin catalog projections after the harness split

Date: 2026-10-03
Status: implemented (both candidates landed)
Origin: simplification sweep over the harness split lanes M1 to M5 (#13635,
#13637, #13641, #13643, #13644, #13646, #13652, #13653). The same PR
implemented the bounded finds:

- `ToolTable` loses its five per-plugin projections (`plugins`,
  `processLayers`, `sessionLayers`, `continuations`, `prompt`). Readers take
  each fact off the `Plugin` value in `entries`.
- `modelBinding.ts` imports `HttpModelConfiguration` instead of restating it.
- Three stale comments that pointed at the pre-M2 manifest are corrected.

The two candidates below were left for later on purpose: the first rewrites
the step, which was held out of that sweep, and the second crosses files
another sweep owned. Both have since landed in one follow-up PR
(`simplify/livetools-fold`):

- **1 landed.** `pinSwitched` returns `plugins`, the built-in plugins on when
  it pinned, read under the same lock as the tool generation. The step reads
  the continuation, the prompt sections and the skills flag off those values.
  `toolTable()` refuses a list where two plugins continue one agent
  category. Deleted: the `continuations` and `sections` registries and their
  `pin` calls, the matching `pinSwitched` fields, `ContinuationEntry`,
  `PromptContribution` (`stepInstructions` takes the plugins), and the
  write-only `prompt` field of `OpenStep` and of the step `stepFor` returns.
- **2 landed.** Every consumer uses `API_KEY_PROVIDER_IDS` and
  `ApiKeyProviderId`; both aliases are gone, the two `vi.mock` keys are
  renamed, and `src/logger/redaction.ts` imports `ApiKeyProviderId` instead
  of restating it.

## 1. The continuation and prompt registries project the on-plugin set

`LiveTools` (`src/tools/liveTools.ts`) builds three `makeRegistry`
instances, and each built-in plugin contributes to all three when its switch
turns on:

- `registry`: the plugin's tools, by tool name. This one carries real
  per-entry identity: digest, plugin and revision. Loaded and installed
  plugins (MCP servers) contribute to it too.
- `continuations`: `{ plugin, continuation }` (`ContinuationEntry` in
  `src/tools/catalogEntries.ts`), keyed by agent category.
- `sections`: `{ section, skills }` (`PromptContribution` in
  `src/tools/toolTable.ts`), keyed by plugin id.

The second and third registries hold nothing the `Plugin` value does not
already carry. Every entry comes from a built-in plugin, so the set of
plugins that are on decides both registries completely. Their only consumer
is the step (`src/agent/runtime/loop/step.ts`):

- `:292` reads `pinned.continuations.entries.get(category)`.
- `:298` and `:318` read the plugin ids in `pinned.sections.entries` and the
  `skills` flag.
- `:385` sorts the same entries into `prompt`.

`PromptBuilder.ts:62` takes that map as its input.

**Proposal.** `pinSwitched` should return the ids of the plugins that were
on when it pinned. The step then reads `continuation`, `prompt` and `skills`
off `ToolRegistry.entries`. `toolTable()` would refuse a list where two
plugins continue the same agent category, the same check it already makes
for `rounds`. Today that conflict surfaces as `RegistryConflict` under
`Effect.orDie` when the catalog reconciles.

**Deletes:** two `makeRegistry` instances and their `pin` calls; the
`continuations` and `sections` fields of the `pinSwitched` result;
`ContinuationEntry`; and `PromptContribution`, unless `PromptBuilder` keeps
it as its own input shape.

**Sequencing:** the change rewrites `step.ts:290-390`, in
`src/agent/runtime/loop/`. It was held out of this sweep while #13663
(resumability) was in flight there; #13663 has since merged, so it can land
as its own PR.

**Risk:** medium. A step must still see one consistent on-set, which the
`locked` reconcile and pin already give, and a continuation must still pin
its plugin's layers (`used` at `step.ts:296`).

## 2. `API_PROVIDERS` / `ApiProvider` alias `API_KEY_PROVIDER_IDS` / `ApiKeyProviderId`

`packages/llm/src/providers/apiProviders.ts:16` exports
`API_PROVIDERS = API_KEY_PROVIDER_IDS`. Line 18 exports
`ApiProvider = (typeof API_PROVIDERS)[number]`, which is
`ApiKeyProviderId` (`providerPlugins.ts:274`) under a second name. Both reach
callers through the one `@texra-ai/llm` barrel. Neither appears in the
package README. The alias dates from #3577, before the split.

Consumers (`rg -nw`, production and test):

- `API_PROVIDERS`: 10 production files and 4 test files. Two of the tests
  name it as a key inside `vi.mock('@texra-ai/llm')`:
  `ApiStatusLoad.vitest.ts:31` and `ModelAccessSelection.vitest.ts:90`.
  Those keys must be renamed in the same change, or the mocks silently stop
  applying.
- `API_KEY_PROVIDER_IDS`: 2 production files and 1 test file.
- `ApiProvider`: 14 production files and 2 test files.

**Proposal.** Keep the canonical `API_KEY_PROVIDER_IDS` and
`ApiKeyProviderId` names, rename every consumer, and delete both aliases.

**Why not in this PR:** about half the production consumers are TUI forms
and settings-view controllers (`ProviderApiKeyForm.tsx`, `CliConfigForm.tsx`,
`SettingsProfileController.ts`). A concurrent GUI sweep owns those files.

**Risk:** low. It is a type-checked rename, apart from the two mock keys.

## Rejected in the same sweep

- **Ratchet baselines.** All five baselines under `config/ratchets/` fail on
  stale entries (`hostAgentDeepImportRatchet`, `hostAgentMockRatchet`,
  `subsystemEdgeRatchet`, and the dead-code ratchet's "no longer found"
  check). They are therefore already minimal at HEAD. The harness to app
  import cut in M3 shrank them in its own PRs (#13644 removed 8
  architecture-edge rows; #13652 removed the stale `agent -> ui` row).
- **Fold `src/tools/pluginAvailability.ts` into `integrationPlugins.ts`.**
  Its seven exports each have one consumer. The file still keeps the probe
  logic (SDK imports, git, Lean, secrets) apart from the dashboard copy, a
  separation by concern rather than a pass-through. Merging would make one
  file of about 570 lines for a net change of 1 file and roughly 20 lines.
  Only its stale header comment was fixed.
- **`XAI_SUBSCRIPTION_ENDPOINT` (`src/agent/runtime/modelRoutes.ts:53`)
  duplicates the xAI catalog `baseUrl`.** Reading the URL from
  `findModelProviderPlugin('xai')?.baseUrl` would turn a pinned literal into
  an optional lookup. That constant guards a security property: the Grok
  subscription token goes to xAI's own surface only. The literal is the
  clearer guard.
- **`harnessBuiltins.minimal`.** Its only consumers are the README and the
  roster test, but it is a documented `@texra-ai/agent/plugins` surface
  (README line 195).
- **The roster tests in `pluginBoundaryRatchet.vitest.ts`.** They restate
  each plugin list on purpose: split design section 4 makes a roster change
  a reviewed change.
- **Production-dead exports in `packages/llm`** (`GOOGLE_PREFIX_DOMAIN`,
  `SessionAccessCoordinator`, `BindableRoute`). Tests import them, so they
  are not dead to knip. Making them file-local would break those suites.
