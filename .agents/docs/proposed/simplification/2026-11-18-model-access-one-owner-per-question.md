# Model access: one owner per question, and the questions left open

Date: 2026-11-18
Status: proposed (four questions landed with this note; three are open)
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

## Open

1. **Which models the launcher's picker lists.** The progress view's
   launcher reads the enabled models alone
   (`packages/texra/src/controllers/session/hostSnapshotSource.ts` passes
   `getEnabledModels`); the terminal's `/model`, `texra models list` and
   delegation read the harness's default list, which adds every model the
   ChatGPT subscription serves once signed in (`visibleModelsForAccess`).
   Signed in to ChatGPT, the terminal offers models the launcher does not.
   Either is defensible: the harness's list saves enabling each Codex model,
   while the launcher's honours a model switched off in the Models tab. It
   is a product-visible default, so the owner decides; the change is one
   argument in `hostSnapshotSource.ts`, or the ChatGPT branch of
   `visibleModelsForAccess`.
2. **A model the picker hides.** `chooseLaunchModel` runs a catalog model a
   launch names even when it is not enabled; delegation refuses it with
   "not currently available for delegation", because it checks a launch
   against the list it told the model. Making delegation call the app's
   rule is not possible (the harness imports no app); moving
   `chooseLaunchModel` into the harness beside `decideRunModel` would let
   delegation use it, at the cost of the delegation prompt listing models a
   launch accepts beyond them. Decide whether a delegation may name an
   unlisted model first.
3. **Turning a model-access preference on or off.** `updateCliModelAccess`
   (`packages/cli/src/runtime/models/modelAccessSelection.ts`) toggles a
   subscription (signing in first when the account is signed out) or a
   coding plan (refusing without its key). The GUI has no such operation:
   its Models page writes the subscription preference directly and the
   coding-plan rows through `applyStateSettingUpdate`, which the terminal's
   own `/config` form also uses, so the terminal writes one coding-plan row
   two ways. One app operation, `setModelAccessPreference(stores,
   provider, state)` in `packages/texra/src/controllers/modelAccess/`,
   returning a typed outcome (`enabled`, `disabled`, `needs-sign-in`,
   `needs-key`) that each host words, would replace both; it needs the
   GUI's answer to "turned on while signed out" decided first, since the
   terminal signs in on the spot. `readCliModelAccessStatus`'s coding-plan half (key set,
   preference) moves with it.

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
