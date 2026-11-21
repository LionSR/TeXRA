# Model access: one owner per question, and the questions left open

Date: 2026-11-18
Status: implemented (the three questions left open were decided and landed
on 2026-11-21)
Origin: applying the owner's rule that a host has no service functions or
error types of its own to the terminal client's model layer
(`packages/cli/src/runtime/models/`), against how the GUI hosts choose and
show models.

## The map

For each question, who answers it. "GUI" means both GUI hosts, which reach
the app's controllers; a row marked _landed_ changed with this note.

| Question                                      | GUI                                                                                                                                                                                                                                                                               | Terminal                                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which models exist                            | llm catalog (`MODELS`, `MODEL_CONFIGS`); the Models tab lists those whose source is in `MODEL_SOURCE_ORDER` (`packages/texra/src/controllers/settingsView/modelSelection.ts`)                                                                                                     | the same catalog; `texra models enabled` lists every model `isUnservedModel` keeps (`packages/cli/src/runtime/models/enabledModels.ts`)                                                             |
| Which this user can run now, by which route   | harness `readModelOptions` (`packages/harness/src/model/computeModelOptions.ts`), worded into rows by the app (`modelOptionsFrom`); _landed_: both read `loadModelOptions` (`packages/texra/src/model/setupCredentialAccess.ts`)                                                  | the same, since this note (its `CliModelAccess` copy is gone)                                                                                                                                       |
| Why one is unavailable                        | the row's `availability` kind (harness), worded by `modelAvailabilityLabel` (`packages/texra/src/ui/copy/modelAccess.ts`)                                                                                                                                                         | the same kind and label, lower-cased (`cliModelStatus`); the recovery line naming `texra setup` is the terminal's (`formatCliModelDetails`)                                                         |
| Which model a launch runs, with what fallback | _landed_: `decideLaunchModel` (`packages/texra/src/model/modelOptions.ts`), used by the compile-fixer follow-up; delegation decides over the list it told the model (`selectAvailableDelegationModel`, `packages/harness/src/agent/runtime/delegation/delegationAvailability.ts`) | _landed_: `chooseLaunchModel` (`packages/texra/src/model/setupCredentialAccess.ts`); the terminal resolves its CLI spellings and words the notice                                                   |
| Which model is the default                    | `DEFAULT_AGENT_MODEL` (`packages/texra/src/model/curatedModels.ts`)                                                                                                                                                                                                               | `CLI_CHEAP_START_MODEL` (`packages/cli/src/runtime/platform/cliConfig.ts`), a ruled, deliberate difference (`.agents/docs/implemented/architecture/2026-08-01-architecture-rulings-ledger.md`)      |
| How a preference is stored                    | subscriptions: `provider.setPreferSubscription`; coding plans: the catalog row through `applyStateSettingUpdate` (`packages/texra/src/controllers/settingsView/stateSettingWrite.ts`)                                                                                             | subscriptions: the same; coding plans from `/login`: `codingPlanSubscriptionRuntimes.setEnabled` (`packages/texra/src/model/codingPlanSubscriptions.ts`); from `/config`: `applyStateSettingUpdate` |
| Each subscription's status                    | _landed_: `subscriptionAuthStatuses` (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`)                                                                                                                                                                      | the same                                                                                                                                                                                            |
| How a sign-in starts                          | `subscriptionProvider(id).signIn` with the host's presenter (`packages/desktop/src/main/desktopSignInPresenters.ts`)                                                                                                                                                              | the same, with the terminal's presenter (`packages/cli/src/runtime/models/subscriptionLogin.ts`); _landed_: its browser launch fails with the app's `HostFailed`                                    |

## Decided on 2026-11-21

The three questions this note left for the owner, each as it was settled.

1. **Which models the launcher's picker lists.** Decided and landed
   2026-11-21: one list for every surface, owned by the harness
   (`listedModels` in `packages/harness/src/model/computeModelOptions.ts`,
   the default of `readModelOptions`). The launcher reads it
   (`loadModelOptions(stores)` in
   `packages/texra/src/controllers/session/hostSnapshotSource.ts`) as the
   terminal's `/model`, `texra models list` and delegation do. What changed,
   and for whom: signed in to ChatGPT, the GUI launcher now also offers the
   models that subscription serves without each being enabled; and on every
   surface a default model a person switched off stays off even when the
   subscription serves it (`disabledDefaults` is the one stored "off"; the
   terminal used to list such a model again). A model that was never a
   default and never enabled has no stored "off", so none was invented: it
   is listed while the subscription serves it.
2. **A model the picker hides.** Decided 2026-11-21: the code's rule
   stays. A delegation may name only a model of the list its prompt told it
   (`selectAvailableDelegationModel`); a person's explicit launch may name
   any catalog model (`chooseLaunchModel`). The two already read the same
   list (item 1), so this rule is their only difference, and it is one of
   authority: a model chooses among what it was offered, and a person who
   types a model's name has decided for themselves. `chooseLaunchModel`
   stays in the app.
3. **Turning a model-access preference on or off.** Landed 2026-11-21:
   `setModelAccessPreference(stores, provider, enabled)` in
   `packages/texra/src/controllers/modelAccess/modelAccessPreference.ts`
   answers `enabled`, `disabled`, `needs-sign-in` or `needs-key`, and each
   host words the outcome. Turned on without its credential, a preference
   is not written: the terminal signs in on the spot, and the settings view
   starts the window's sign-in (which turns the preference on when it
   succeeds). A coding plan's switch reaches the same writer from every
   settings row (`applyStateSettingUpdate` calls `setCodingPlanPreference`),
   so the GUI's Models page, the terminal's `/login` and its `/config` write
   one way, and the GUI no longer turns a plan on with no key set.
   `readModelAccessStatus` is beside it; `updateCliModelAccess` only words,
   and `codingPlanSubscriptionRuntimes` is gone.

## Kept in the terminal, and why

- `assertExplicitModelKnown`, `cliRunModelCandidates`, `selectCliRunModel`
  (`packages/cli/src/runtime/models/runModel.ts`): the `--model` flag's
  usage error (exit 2), the candidates from `TEXRA_MODEL` and the
  `texra.chat` / `texra.run` sections (rows only the terminal reads), and
  the stderr notice.
- `resolveKnownCliModelId` (`packages/cli/src/runtime/platform/cliConfig.ts`):
  reading a model typed on a command line (`grok-4.7`, `Opus 5.5`); every
  GUI picks from a list.
- `packages/cli/src/runtime/models/modelAccessRoute.ts`: the terminal's rows
  for the `/login` form and the account panel (`buildCliModelAccessItems`,
  `buildCliAccountAccessRows`, the `On · …` / `Off · …` descriptions),
  budgeted to one 75-column line.
- `packages/cli/src/runtime/models/browser.ts`: which OS launcher opens a
  URL (`xdg-open`, `open`, `rundll32`, WSL interop); its failure is the
  app's `HostFailed`.

## Kept as llm exports, and why

Checked on 2026-11-19, before the first npm publish of `@texra-ai/llm`,
against the 2026-11-04 model-layer review's list of exports to withdraw.

- `codexBackendModelId` stays. Its one consumer outside llm,
  `packages/texra/src/tools/agentCli/codexConfig.ts`, needs the model id the
  Codex backend uses for a Codex binary that signs in by itself. llm decides
  no route for that launch, so there is no higher-level question to ask it:
  `routeConfig`'s ChatGPT case keeps `config.id`, and only
  `responsesConfiguration` strips the date pin. Withdrawing the export would
  either copy the date-pin pattern into the app or have the app build a
  ChatGPT route it never uses.

Withdrawn the same day: `acceptedEfforts` and `wireEffort` (one
`reasoningOnRoute`, which reads a route's controls once), and the two Kimi
predicates (one `kimiCodeServing`, the three-way fact they spelled in two).
The picker still tests the model, not the decided route: with the plan off a
dual-backend Kimi model's route is a plain Moonshot key route, so reading the
route would drop its "Via Moonshot" badge.
