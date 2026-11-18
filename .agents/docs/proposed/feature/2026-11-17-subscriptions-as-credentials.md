# A subscription is a credential, not a switch

Date: 2026-11-17
Status: proposed

A user who pays for a model plan should be able to sign in and work, with no
API key and no setting to find. Today a plan is reached through a
per-provider preference that is off by default and labelled experimental,
beside the API-key path that every surface treats as the normal one. This
note compares TeXRA with two peer agents, says what TeXRA already does
better, and lists the changes that make a plan an ordinary credential.

Read at `main` `c78e9f9`. The peer material is their published docs (links
at the end); the docs sites of one peer and of OpenAI were not reachable
from the session that wrote this note, so the items marked "not verified"
need a second read before they are built on.

## What exists

| Plan                           | Credential         | Sign-in                                                                         | Usage readout                        |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------- | ------------------------------------ |
| `chatgpt-subscription`         | OAuth session      | loopback PKCE; OpenAI's "Sign in with ChatGPT", a client registered per machine | none; plan tier from the token       |
| `xai-subscription`             | OAuth session      | loopback or device code, on the Grok CLI's public client id                     | none                                 |
| `kimi-code-subscription`       | API key `kimiCode` | paste the key, turn the plan on                                                 | yes, settings and the CLI status bar |
| `glm-coding-plan-subscription` | API key `glm`      | turn the plan on                                                                | yes                                  |

- The four plans are one table, `PLAN_ROUTES`
  (`packages/llm/src/errors.ts`), and one pure decision picks the route for
  a model, `decideModelRoute` (`packages/llm/src/models/modelRoute.ts`). A
  plan turn costs 0 and keeps the price it would have had on a key
  (`packages/llm/src/models/turnCost.ts`).
- Accounts are `SubscriptionAccounts`
  (`packages/llm/src/oauth/subscriptionAccounts.ts`): one session per plan,
  in the process secret store, renewed once when a request is rejected.
- A plan is used when its per-provider preference is on and the session is
  signed in (`packages/harness/src/model/modelSettings.ts`). Signing in turns
  the preference on and signing out turns it off
  (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts`).
- GitHub Copilot was removed (#14296) and the Claude plan route waits on
  Anthropic's written answer
  ([Claude Agent model route](./2026-10-31-claude-agent-model-route.md)).

## What the peers do

Hermes Agent and pi both treat a plan login as one kind of credential a
provider holds.

- **One store, one shape.** A provider has a list of credentials, each an
  OAuth login or an API key, with a priority. The command that picks a model
  starts by picking a provider and signing in.
- **A plan limit is a known state, not only an error.** A limit response
  that names its reset time takes that credential out of use until then; a
  usage-limit 429 is not retried; a dead refresh token is reported once with
  the command that repairs it, and is not retried on a timer.
- **No silent change of who pays.** Hermes states the rule: an expired plan
  session must not fall through to another provider the user happens to be
  signed in to.
- **Helper calls follow the main provider** unless the user configured
  another one.
- **Sign-in works without a local browser:** a device code, or pasting the
  redirect URL back into the prompt.
- **Claude plans are not really reached by either.** Hermes documents its
  Anthropic login as working only on a Max plan with purchased extra usage,
  and as spending only that extra usage; pi documents the same billing.
  Anthropic's published rule is that a third party may not offer Claude.ai
  login in its own application or route requests through plan credentials
  on a user's behalf; a user signing in to the unmodified Claude Code
  binary is allowed.

Where TeXRA is ahead: the ChatGPT route uses OpenAI's own sign-in for
open-source agents (a client registered for the user, the plan scope on the
consent page, the public Responses API), where the peers reuse the Codex
CLI's login. TeXRA also reads plan usage for two plans and keeps the list
price of a plan turn.

## What is second class today

1. **The plan is a preference.** `preferSubscription` per provider, off by
   default, written by sign-in and sign-out. Its value follows from two
   facts the code holds (a session exists; the model is eligible), so it is
   an option for a decision the code can make.
2. **Two catalogs.** OAuth plans are described in
   `packages/texra/src/controllers/modelAccess/subscriptionProviders.ts` and
   key plans in `packages/texra/src/shared/model/codingPlans.ts`, beside
   `PLAN_ROUTES`.
3. **"Experimental" on both OAuth plans**
   (`packages/harness/src/shared/state/stateSettings.ts`). That is accurate
   for Grok, which depends on another product's client id, and no longer
   for ChatGPT.
4. **A limit is learned by failing.** ChatGPT and Grok have no usage
   readout, and the reset time in a limit response is not kept.
5. **Helper calls.** The default helper model is a per-token model on
   another provider (`packages/texra/src/shared/settings/texraSettings.ts`).
   A user with only a plan gets every title and summary on the run's own
   model, with a logged warning
   (`packages/harness/src/agent/runtime/helperModel.ts`), which spends plan
   quota on the most expensive model available.
6. **First run.** The welcome card
   (`packages/texra/src/ui/progress/components/OnboardingWelcomeCard.ts`)
   and the setup probe
   (`packages/texra/src/tools/setup/ProbeEnvironmentTool.ts`) know one plan;
   the other three are reachable only from Settings.
7. **No sign-in without a local browser for ChatGPT**, and none for a
   process that embeds the harness: the SDK's default secret store holds
   nothing (`packages/harness/src/platform/defaults/nodePlatform.ts`).
8. **Transcription takes an OpenAI key only**
   (`packages/texra/src/controllers/session/hostDraftRequests.ts`).

Not a gap of ours: the ChatGPT route has no background mode, no WebSocket,
no document input and no forced tool choice
(`packages/llm/src/api/responsesConfiguration.ts`). Those are limits of the
plan route as OpenAI serves it.

## Proposed

In the order they should land. Each is its own PR.

1. **Delete the preference; the route follows from the facts.** A model is
   served by a plan when the plan's credential is present and the model is
   eligible. `decideModelRoute` already takes those as `RouteFacts`; the
   preference is one more input that sign-in sets to the same value. The
   run's own opt-out (`declinedRoutes`) stays, because it is a decision a
   person made for that run. A user who wants a signed-in plan left unused
   signs out. This removes two settings keys and their rows in the settings
   view.
2. **One plan table.** The sign-in description, the usage adapter and the
   settings copy for a plan become columns of the row `PLAN_ROUTES` already
   has, in `packages/llm`. The two app catalogs go. This takes
   [layer misplacements](../simplification/2026-11-15-layer-misplacements-left-open.md)
   item 3 (the Kimi and GLM usage endpoints move to llm) with it.
3. **ChatGPT is no longer experimental.** Change the copy and the label.
   Grok keeps its warning, and the note about the borrowed client id stays
   where a user reads it before signing in.
4. **A limit is a fact with a reset time.** Keep the reset time a limit
   response names, on the account. While it is in the future: the status
   bar and the settings row show it, and a request on that plan is not
   sent. The question the run asks stays as it is (switch this run to the
   key, or wait), and gains the time. Nothing switches to a paid key
   without that answer. The comment on `PLAN_ROUTES` says a key plan falls
   back "without asking"; check it against
   `packages/harness/src/agent/runtime/modelAccess/routeDecision.ts` and
   make the two agree.
5. **The helper model follows the route.** When the run is served by a
   plan and the configured helper model cannot be served, the helper is the
   cheapest model the same plan serves, not the run's model. The table in
   step 2 names it per plan.
6. **First run starts with sign-in.** The welcome card and the setup probe
   list every plan from the table, before the API-key rows.
7. **Sign-in without a local browser.** The CLI already chooses a device
   code when it has no terminal or runs over SSH
   (`packages/cli/src/runtime/models/subscriptionLogin.ts`); ChatGPT has no
   such transport today. Add pasting the redirect URL back into the prompt,
   which needs nothing from the provider. Whether OpenAI's sign-in offers a
   device code is not verified.

## Not proposed

- **Reading another tool's login** (the Codex CLI's or Claude Code's
  credential files). TeXRA has its own registration with OpenAI; using a
  credential issued to another client is a step back, and for Claude it is
  what Anthropic's rule excludes.
- **Several accounts per plan with rotation.** Nobody has asked, and two
  logins of one OpenAI account share a token family, so they would not
  rotate anyway.
- **An automatic fallback chain.** It changes who pays without a person
  deciding.
- **Copilot.** The rulings ledger records the undocumented API route as not
  approved; the peers' Copilot login is that route.
- **A Claude plan login.** The existing note's design (run the user's own
  `claude` binary) is the only shape the published rule leaves room for,
  and it stays blocked on the written answer.

## Open questions

1. Does a signed-in plan with no preference to turn off surprise anyone who
   holds both a plan and a key for the same provider? The proposal says the
   plan serves, as it does today once signed in.
2. Does OpenAI's sign-in report plan usage or a per-application cap that a
   readout can show? Not verified.
3. Can the xAI plan token serve transcription? One peer documents reusing
   it for speech; this ties to the transcription-credential question in
   [layer misplacements](../simplification/2026-11-15-layer-misplacements-left-open.md)
   item 1.
4. Should the SDK ship a file secret store, so a process that embeds the
   harness can use a plan the user signed in to with `texra`?

## Sources

- Hermes Agent providers, credential pools and fallback providers:
  <https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/integrations/providers.md>,
  <https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/credential-pools.md>,
  <https://github.com/NousResearch/hermes-agent/blob/v2026.9.24/website/docs/user-guide/features/fallback-providers.md>
- pi providers:
  <https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/providers.md>
- Anthropic, authentication and credential use:
  <https://code.claude.com/docs/en/legal-and-compliance>
- OpenAI, token sharing for open-source agents (cited by
  `packages/llm/src/oauth/chatgpt/chatgptProvider.ts`; not re-read for this
  note): <https://developers.openai.com/siwc/token-sharing-open-source>
