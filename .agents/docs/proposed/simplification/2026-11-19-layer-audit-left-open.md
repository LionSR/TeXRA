# Logic in the wrong layer: what the 2026-11-19 audit left open

Date: 2026-11-19
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`ceebb96`. Three read-only passes covered host packages holding app logic,
renderers computing run facts, and misplacement between `packages/llm`, the
harness and the app. Each candidate was checked against
`.agents/docs/refuted-candidates.json` and the other notes in this directory.
No harness module imports from a higher layer than the layer order allows.

The same PR implements the findings that fit a reviewable diff. It moves the
"does this model batch tool calls" fact into `packages/llm` and drops
`IS_ANTHROPIC_MODEL`. In the terminal, the status bar and `/status` now count
live agents from the view's rollup, and a child scrollback header takes
`runNoun`. One function now paints a script call that waits on the user, and
a tool card's feedback has one label. The context-management row now carries
only the event the run writes. Two host strings are read from the app (the clone copy is left to #15055). What
follows is left open, in the order worth taking.

## 1. Tool-use turns go out as background work (a behaviour question)

The setting that reached nothing is deleted:
`model.useGoogleBackgroundResponses`, its reader and the harness's
`backgroundOn` are gone, and nothing sent to a provider changed. What is left
is the behaviour the old comment denied.

The bind option `background` (`request.textOnly`, in
`packages/harness/src/agent/runtime/modelAccess/binding.ts`) is read in one
place in `packages/llm`, `servesWebSocket`
(`packages/llm/src/api/configuration.ts`): it only gives up the persistent
WebSocket. Whether a turn goes out as background work is decided separately:
`ModelInvoker` sends it in the background whenever the bound model carries a
`background` member, and a protocol model carries one exactly when
`backgroundCapable(configuration)` holds (`packages/llm/src/turn.ts`). That is
a GPT-family Responses route, or Google with server-side state on. So every
turn on those routes goes out as background work, a tool-use turn included.

The open question: should a tool-use turn stream in the foreground instead?
If so, the change is in `packages/llm`: a protocol model carries `background`
only when the bind asked for it and the route can carry it, and the harness
keeps passing `background: request.textOnly`. It changes what is sent to
OpenAI and Google, so it needs a live run with a key before it lands.

## 2. Image size limits are one provider's, applied to all

`MANY_IMAGE_MAX_DIMENSION = 2000` (`packages/harness/src/tools/attachments.ts`)
is Anthropic's multi-image limit. It drops the bytes of any tool-attachment
image over 2000px for every provider, even a single image to GPT or Gemini.
`API_MAX_IMAGE_DIMENSION = 8000` (`agent/runtime/run/img.ts`) caps the
`maxImageDimension` setting below the 10,000 its schema allows. Both are wire
limits, and `packages/llm` should state them per protocol, e.g.
`imageLimits(config)`. Decision needed: does llm-zoo gain the field, or does
llm keep a protocol table?

## 3. The GLM Coding Plan's precedence is decided in two packages

`readModelSettings` (`packages/harness/src/model/modelSettings.ts`) drops the
plan when a dashboard GLM endpoint is set. `decideModelRoute`
(`packages/llm/src/models/modelRoute.ts`) drops it when the model has its own
base URL. Today `RouteFacts.endpoints` mixes dashboard URLs with region
defaults, so llm cannot tell a dashboard URL from a default. The fix is a
`RouteFacts` field for the user-set endpoints, after which llm owns the rule.

## 4. A user row does not say who sent it

`logFollowUps` (`packages/harness/src/agent/runtime/FollowUps.ts`) has the
input's `from` but logs only the text. As a result the web labels every
user row "You", including a child's delivery and a host notice
(`UserMessage.ts`). (The terminal's guess at an inquiry continuation from
its wording went with the external inquiry on 2026-11-19.)

The fix is a sender on `UserRow`, so the renderers branch on it. It changes a stored payload, so it needs a row-version decision.

## 5. Request nouns and the "waiting on you" source differ per renderer

The terminal child list keeps its own noun table
(`SubagentListDisplay.ts`), sourced from `attentionRequests`, which includes
requests that do not block their run. The web row reads `run.approval`
(blocking only). One noun table keyed by `RequestPayload['kind']` belongs in
`packages/texra/src/ui/copy/requestCards.ts`, and the badge should read
`run.approval`. Decision needed: should a non-blocking request mark the row?

Landed 2026-11-19: the nouns are one table, `REQUEST_NOUN` in
`packages/texra/src/ui/copy/requestCards.ts`, total over
`RequestPayload['kind']`; the terminal child list and the script-stage call
line read it. Every renderer already used the same word, so nothing a person
reads changed. The badge's source is still the open decision.

## 6. Copy the hosts word separately

These need a decision on which wording wins:

- **Subscription sign-in prompts.** `subscriptionSignIn.ts` (extension),
  `desktopSignInPresenters.ts` and `subscriptionLogin.ts` / `signInUrl.ts`
  (CLI) each word the device-code steps and the open-elsewhere hint. The
  extension names the provider's session; the others don't.
- **Queued follow-ups.** The count reads "N unread messages" (web tab),
  "Queued messages (N)" (composer), `queued N` in the warning colour
  (terminal bar) and "queued messages: N" (`/status`).
- **Why an ended run takes no message.** The web words it in
  `BaseRunContent.ts`; the terminal hides the input and says nothing.

Landed since: **what usage logging sends** is one sentence,
`USAGE_LOGGING_SENDS` in `packages/texra/src/shared/settings/texraSettings.ts`,
built from a wording table that is total over the fields of the usage record
(`UsageLogEntrySchema`). The setting, the first-run notice and
`texra doctor` show it, and the last two take the opt-out variables from
`TELEMETRY_OPT_OUT_ENV_VARS`. The Privacy section's heading no longer words
it a second time above the setting's row.

## 7. Two launcher requests only the extension answers

`useCurrentFile` (its latexdiff-vc handling) and `addOpenedFiles` in
`packages/extension/src/progressView/extensionHostRequests.ts` are
host-neutral. The second restates `attachDroppedPaths`' extension filter. The
desktop refuses both. They can move into `openGuiWindow` behind two host
bindings, `currentFile` and `openedFiles`. Decision needed: does the desktop
offer these buttons?

## 8. TeXRA's name in the harness

The harness still carries TeXRA's name and LaTeX in a few places:

- `databaseLayer.ts` says "Another TeXRA process holds this project".
- `mcpServer.ts` sends `clientInfo.name: 'texra'`.
- `sessionDescription.ts` gives a TikZ prompt example.
- The glob and grep tool descriptions use `**/*.tex` examples.

The first two can take the product name from the catalog namespace. The
examples can be neutral, which changes the tool descriptions a run records.

## Checked and left alone

- **The JSON Schema provider rules in `convertToolSchema`**
  (`stripDollarSchema`, `withArrayItems`). They are vendor rules, but the
  harness records the converted schema as the run's tool definition
  (`toolDigests`). Lowering it in llm would make the recorded schema differ
  from what the model saw.
- **The coding-plan catalog's `apiProvider` against `PLAN_ROUTES`.** It is
  small and belongs with open question 1 of the 2026-11-18 model-access
  note. (The settings rows that repeated provider key-page URLs now read
  `KEY_PAGES` from `packages/texra/src/shared/model/providerKeyPages.ts`.)
