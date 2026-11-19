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

## 1. The Google background toggle reaches nothing (a defect)

`backgroundOn` (`packages/harness/src/agent/runtime/modelAccess/binding.ts`)
feeds the bind option `background`, which `packages/llm` reads in one place,
`servesWebSocket` (`packages/llm/src/api/configuration.ts`). Whether a turn
goes out as background work is decided differently: `ModelInvoker` sends it
in the background whenever the bound model carries a `background` member, and
a protocol model carries one exactly when `backgroundCapable(configuration)`
holds (`packages/llm/src/turn.ts`). That is a GPT-family Responses route, or
Google with server-side state on. So:

- `model.useGoogleBackgroundResponses` changes nothing. Google turns go out
  as background Interactions whenever server-side state is on, the toggle off
  by default notwithstanding.
- The text-only condition (`turn.textOnly`) changes nothing either, so
  tool-use turns on those routes go out as background work too, against the
  harness comment that says they don't.

The fix is in `packages/llm`. A protocol model carries `background` only when
the bind asked for it and the route can carry it. Google's toggle becomes a
bind option beside `serverState`, read in `CONFIGURE['google-interactions']`,
so the harness passes `background: request.textOnly` and stops testing
`turn.protocol`. It changes when GPT tool-use turns stream in the foreground,
so it needs a live check before it lands.

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
input's `from` but logs only the text. As a result:

- The terminal guesses an inquiry continuation from its wording
  (`INQUIRY_CONTINUATION_RE`, `packages/cli/src/chat/tui/panes/transcriptEntries.ts`).
- The web labels every user row "You", including a child's delivery and a
  host notice (`UserMessage.ts`).

The fix is a sender on `UserRow`, so both renderers branch on it and the
regex goes. It changes a stored payload, so it needs a row-version decision.

## 5. Request nouns and the "waiting on you" source differ per renderer

The terminal child list keeps its own noun table
(`SubagentListDisplay.ts`), sourced from `attentionRequests`, which includes
requests that do not block their run. The web row reads `run.approval`
(blocking only). One noun table keyed by `RequestPayload['kind']` belongs in
`packages/texra/src/ui/copy/requestCards.ts`, and the badge should read
`run.approval`. Decision needed: should a non-blocking request mark the row?

## 6. Copy the hosts word separately

These need a decision on which wording wins:

- **Subscription sign-in prompts.** `subscriptionSignIn.ts` (extension),
  `desktopSignInPresenters.ts` and `subscriptionLogin.ts` / `signInUrl.ts`
  (CLI) each word the device-code steps and the open-elsewhere hint. The
  extension names the provider's session; the others don't.
- **What usage logging sends.** `doctor.ts` (CLI), `telemetryNotice.ts`, the
  setting's description and `PrivacyTab.ts` disagree on whether host, version
  and error text are covered. The doctor also hard-codes the opt-out variables
  that `TELEMETRY_OPT_OUT_ENV_VARS` holds.
- **Queued follow-ups.** The count reads "N unread messages" (web tab),
  "Queued messages (N)" (composer), `queued N` in the warning colour
  (terminal bar) and "queued messages: N" (`/status`).
- **Why an ended run takes no message.** The web words it in
  `BaseRunContent.ts`; the terminal hides the input and says nothing.

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
- **App settings rows that repeat provider console URLs**
  (`settingSurfaces.ts` against `KEY_PAGES`), and the coding-plan catalog's
  `apiProvider` against `PLAN_ROUTES`. Both are small. They belong with
  open question 1 of the 2026-11-18 model-access note.
