# O. llm's providers, routes, codecs and sign-in flows: design red-flag audit (read-only)

Scope: `packages/llm/src/` except D's model-call path (the retry loop, the
drivers, `verdict.ts`, `background.ts`, `ModelRetryGate`, `binding`/`ScopedRef`,
`sharedAttempt.ts`, `SubscriptionOAuthCoordinator.ts`'s internals, the helper
model, `ModelInvoker`, `uploadCache.ts`, `anthropicThreads.ts`,
`configuration.ts`/`responsesConfiguration.ts` as tables). Read at HEAD
`73e0225` (after #14774–#14776 landed; #14776 collapsed `ModelError.kind` to
six values, and nothing below reports a kind it removed). Paths are relative
to `/home/user/TeXRA/packages/llm/src` unless they start with `packages/`.
Consumer counts are over `packages/*/src` outside `packages/llm/src` unless
marked; tests are `packages/llm/test`, `src/test-kernel`, `packages/*/test`.

Everything round 1's D found and R9 absorbs is FOUND and not repeated: the
loops and drivers (D1), the verdict re-encoding (D2), background's seven
representations with `backgroundCapable`, `Model.background?`,
`Binding.background` and the Google `store` knob (D3), the gate (D4), the
bearer on the binding and `swapModel` (D5), `SharedAttempt` /
`SerializedWrites` / `sessionGeneration` (D6), the helper request (D7), and
D8. Findings 3 and 7 below border D5/D6 and say so.

## Numbers

Lines per directory (12 248 in all): root 1 778 (`turn.ts` 516,
`message.ts` 335, `errors.ts` 278, `node.ts` 258, `protocol.ts` 229,
`index.ts` 162); `api/` 6 530; `oauth/` 1 743 (`chatgpt/` 399, `xai/` 474);
`models/` 782; `providers/` 542.

Five largest files: `api/googleInteractions.ts` 778, `api/anthropicMessages.ts`
676, `turn.ts` 516, `api/openaiResponsesCodec.ts` 449, `api/verdict.ts` 400 =
`oauth/SubscriptionOAuthCoordinator.ts` 400.

Comment-line share (`grep -cE '^\s*(/\*|\*|//)'` / total) of the worst files
≥ 200 lines in this area: `models/modelRoute.ts` 34 %, `providers/providerPlugins.ts`
29 %, `oauth/xai/xaiProvider.ts` 29 %, `api/transport.ts` 28 %, `node.ts` 25 %,
`oauth/loopbackLogin.ts` 23 %, `models/reasoningChoice.ts` 23 %. (D reported
`errors.ts` 27 % and `uploadCache.ts` 26 %.) `modelRoute.ts`'s share is doc
comments on a pure decision and is not a design signal; `providerPlugins.ts`'s
is a comment explaining a sentinel grammar (finding 9a); `xaiProvider.ts`'s is
constant documentation; `loopbackLogin.ts`'s is a hand-off protocol in prose
(finding 7).

Primitives in `packages/llm/src` (whole package, D's files included):
`uninterruptibleMask` 2, `Effect.uninterruptible` 5, `forkDetach` 2,
`Deferred.doneUnsafe` 5, `*.makeUnsafe` 3, `Effect.callback` 5, `new WeakMap`
1, `addObserver` 0, `interruptUnsafe` 0, `catchDecoding` 10,
`withDecodingDefault` 2, module-level or closure `let` 37, `Ref.make` 5,
`Deferred.make` 3, `Semaphore` 5, `ScopedRef` 6, `Schedule.` 4. Of these, in
this area: `loopbackLogin.ts` (3 `doneUnsafe`, 1 `uninterruptible`, 1
`forkDetach`, 1 `callback`), `authProgram.ts` (2 `makeUnsafe`, 1 `doneUnsafe`,
1 `uninterruptible`; D6), `deviceAuthorization.ts` (1 `uninterruptible`, 2
`Ref.make`), `openaiResponsesWebSocket.ts` (4 `callback`, `ScopedRef`,
`Semaphore`: Effect-native, see "Good modules"), `SubscriptionOAuthCoordinator.ts`
(the `WeakMap`).

Named change, counted (finding 9): "add an API-key provider that serves
Responses on its own endpoint" (MiniMax's shape, the last one added) touches
8 production files today, 9 edits; 4 after.

---

## 1. The route is decided in three pure steps the harness sequences, and the endpoint fact is spelled in three constants

**Red flags:** temporal decomposition (decide, then resolve the endpoint,
then overlay the config, each a separate export called in order); two
representations of one fact (the endpoint a plan's token is accepted at);
information leakage (the harness knows an endpoint can be `undefined`).

**Evidence.**

- `decideModelRoute(config, facts: RouteDecisionFacts)` (`models/modelRoute.ts:189-237`)
  with `RouteDecisionFacts = Omit<RouteFacts, 'endpoints'>` (`:62`): the
  decision is told everything except the endpoints. `resolveRouteEndpoint(config,
  route, facts)` (`models/routeEndpoint.ts:40-52`) then re-asks the route's
  questions: `route.kind === 'chatgpt-subscription'` (`:45`),
  `'xai-subscription'` (`:46`), `route.usageRoute === 'kimi-code-subscription'`
  (`:48`). `routeConfig(config, route)` (`modelRoute.ts:259-302`) is the third
  step; the harness calls it (`packages/harness/src/model/computeModelOptions.ts:251`)
  and `bindModel` calls it again on the same inputs
  (`api/configuration.ts:141`).
- The harness sequences them: `routeDecision.ts:103-115` decides,
  `credentials.ts:70-85` wraps `resolveRouteEndpoint` in `routeEndpoint`,
  which `Effect.die`s on `undefined` ("A provider the catalog states no
  endpoint for is a defect"), and `BindSpec.endpoint` (`node.ts:53`) carries
  the result back in. The README's example spends 4 of its 9 setup lines on
  this (`packages/llm/README.md:57-62`).
- "The API a ChatGPT token is for" is three constants: `OPENAI_DEFAULT_ENDPOINT`
  (`providers/providerPlugins.ts:34`), `CHATGPT_PLAN_BASE_URL`
  (`routeEndpoint.ts:27`) and `CHATGPT_RESOURCE` (`oauth/chatgpt/chatgptProvider.ts:72`),
  all `'https://api.openai.com/v1'`. The Kimi Code endpoint is
  `KIMI_CODE_BASE_URL` in `providers/providers.ts:9`, while the `kimiCode`
  manifest row has no `baseUrl` (`providerPlugins.ts:139-144`) and the
  moonshot row carries a comment explaining why it is never reached for
  those models (`:97-98`).
- Consumers: `resolveRouteEndpoint` 3 refs in 1 harness file (+2 tests);
  `routeConfig` 2 refs in 1 file (+2 tests); `RouteDecisionFacts` 0 outside
  llm; `OWN_KEY_ROUTE_FACTS` 2 refs (+11 tests).

**The design decision behind it.** "What does a route decision decide?"
Today: which credential pays, but not where the request goes nor what the
model runs as, so two more functions and one host wrapper finish the
decision later, and the subscription endpoints are spelled where each later
step needs them.

**The better design.** One decision. `decideModelRoute(config, facts: RouteFacts)`
returns a `CredentialRoute` that carries its `endpoint`: a plan's is its
provider plugin's default (`pluginEndpoint(PLAN_ROUTES[kind].provider)`; the
ChatGPT resource constant reads the same plugin value), an API-key route's is
`config.baseUrl ?? facts.endpoints[route.provider] ?? pluginEndpoint(route.provider)`,
with the `kimiCode` row carrying `baseUrl: 'https://api.kimi.com/coding/v1'`
so the Kimi Code special case is a manifest fact. `RouteFacts.endpoints`
becomes total over `EndpointProviderId` (the type exists,
`providerPlugins.ts:176-179`), so "no endpoint for a regional provider" is
refused once where the host builds the facts (`packages/harness/src/model/modelSettings.ts`)
and never reaches the decision. `BindSpec` takes `route` and drops
`endpoint`. Deleted: `resolveRouteEndpoint` (3), `RouteDecisionFacts` (0),
`CHATGPT_PLAN_BASE_URL`, `CHATGPT_RESOURCE` (→ the plugin constant),
`KIMI_CODE_BASE_URL` and `providers/providers.ts` with it (finding 8),
`BindSpec.endpoint`, the harness's `routeEndpoint` wrapper
(`credentials.ts:70-85`), the `endpoint` parameter of `subscriptionCredential`
(`:97-100`). `routeConfig` stays exported for the picker's one read.

**What we give up.** A caller that wanted a route without an endpoint (none
exists: every `bindModel` needs one). Risk: low; `decideModelRoute` has 15
test refs that gain an `endpoints` field.

**Change amplification.** "A plan whose token is accepted only at its own
surface (a third subscription)": today `PLAN_ROUTES`, the `ModelRoute` union,
`decideModelRoute`, a new `if` in `routeEndpoint.ts`, a new base-URL constant
and the provider module's `resource` (6 edits); after `PLAN_ROUTES`,
`decideModelRoute` and the provider module (3).

**Depends on:** none. It removes `BindSpec.endpoint`, which D2's deletion of
`BindRequest.config` sits beside; the two can land separately.

---

## 2. Which reasoning controls a route accepts is decided in `models/` and again in each `api/` row, and `wireEffort` reads a third source

**Red flags:** two representations of one fact; special and general code
mixed (the MiniMax row restates the choice the general policy made, and the
policy's `note` then describes a level the row discards); a constant column.

**Evidence.**

- `routeControls` (`models/reasoningChoice.ts:44-66`) switches on
  `config.provider`: DashScope → no controls (`:51-52`); Google and Moonshot →
  no `off` (`:53-55`); the ChatGPT route → `CODEX_ROUTE_EFFORTS` (`:57-63`).
  `chooseReasoning` and `acceptedEfforts` read it; the harness's picker reads
  both (`packages/harness/src/model/reasoningLevel.ts:101,153,175`).
- `RESPONSES_ROUTES` (`api/responsesConfiguration.ts:150-214`) says the same
  things again as request fields: DashScope `reasoning: null` (`:198`),
  Moonshot `effortOnly(facts.spec.options.reasoning.effort)` rather than
  `wireEffort` so `none` cannot appear (`:175`), and MiniMax
  `allowedReasoningEfforts: ['high']` with `thinking ? effortOnly('high') : null`
  (`:205,211`). `routeControls` has no MiniMax case, so `chooseReasoning` snaps
  the request to the catalog's nearest level and writes a `note`
  (`reasoningChoice.ts:129-133`) naming an effort the row then replaces with
  `'high'`: the run's log says one thing and the wire another.
- `wireEffort` (`reasoningChoice.ts:248-256`) decides whether `none` is how
  thinking is turned off by reading `config.reasoning?.off`, the catalog's
  switch, not the route's controls that `chooseReasoning` just used.
- The `allowedReasoningEfforts` column is `facts.acceptedEfforts` in five of
  six rows (`:160,172,181,196` and `:89,118`) and `['high']` in one; the
  request-time check (`api/openaiResponsesRequest.ts:81-84`) reads it back
  from the configuration. A column that is constant except where a missing
  `routeControls` case forces it is a special case written as data.
- Google's `thinkingLevel` fallback to `'high'` (`api/configuration.ts:115-121`)
  is a fourth statement of Gemini's controls beside `routeControls`'s Google
  case and `ThinkingLevelSchema` (`turn.ts:93-98`).

**The design decision behind it.** "Who knows what a route's reasoning
request can say?" The policy (so the picker can offer levels) and the wire
row (so the request is well-formed) each answer, and nothing makes them
agree.

**The better design.** `routeControls` is the one owner, as a table keyed by
provider (`MiniMax: { efforts: ['high'], off: catalog's }` added), and the
rows derive: `allowedReasoningEfforts` goes from the configuration
(`turn.ts:163`), the check at `openaiResponsesRequest.ts:81-84` reads
`facts.acceptedEfforts` carried once; a row's `reasoning` is
`controls === undefined ? null : effortOnly(wireEffort(controls, choice))`
with `wireEffort` taking the route's controls, not `config`; a row states
only what is genuinely the vendor's spelling (MiniMax omits the field when
thinking is off). Deleted: the `allowedReasoningEfforts` column (6 values, 1
schema field, 1 reader), four rows' `reasoning` values (`:163-165,175,187-189,198`),
`wireEffort`'s catalog read, the Google fallback's level list (derive from
`ThinkingLevelSchema`'s literals or the controls).

**What we give up.** Nothing observable; MiniMax's `note` becomes true.
Risk: low; `packages/llm/test/model/ReasoningChoice.vitest.ts` (44 lines)
pins the policy.

**Change amplification.** "A vendor gains an off switch": today
`routeControls`, its `RESPONSES_ROUTES` row and `wireEffort`'s catalog read
(3 edits); after the table's one row.

**Depends on:** none.

---

## 3. A subscription provider is a port with one implementation, memoized in a `WeakMap`, with optional policy hooks one provider fills and four spellings of "the account"

**Red flags:** a port with one implementation; a base with hooks one subclass
fills (special and general mixed); a module-level cache that hands out shared
mutable instances; pass-through exports; state machine in optional fields;
exports with no consumer; three enumerations of the providers in two id
vocabularies.

**Evidence.**

- `SubscriptionCoordinator<S>` (`oauth/subscriptionCoordinator.ts:71-112`,
  8 members) is implemented once (`oauth/SubscriptionOAuthCoordinator.ts:69-71`).
  Outside llm, 4 members are called (`getStatus` 3, `getFreshSession` 2,
  `refreshRejected` 2, `signOut` 3); `loadSession`, `buildAuthorizeRequest`,
  `loginWithCode`, `storeTokens` are reached only by llm's own flows.
- `forProvider` keeps a `WeakMap<CredentialStore, SubscriptionCoordinator>`
  (`SubscriptionOAuthCoordinator.ts:77-92`) so that "callers sharing a store
  must share the same refresh attempt and write queue" (`:73-75`): the "one
  instance per store" guarantee written by hand where a `Layer` over
  `Secrets` is that guarantee. Both consumers call it per use:
  `packages/harness/src/agent/runtime/modelAccess/credentials.ts:110,117,125-126`
  and `packages/texra/src/controllers/modelAccess/subscriptionProviders.ts:301-310,317-327`.
- `getChatgptStatus(secrets)` is `chatgptCoordinator(secrets).getStatus()`
  (`oauth/chatgpt/chatgptProvider.ts:385-392`; `getXaiStatus`
  `oauth/xai/xaiProvider.ts:250-257`): pass-throughs with 8 and 4 refs. The
  app's row passes the same object twice, as `coordinator` and as `getStatus`
  (`subscriptionProviders.ts:307-308`).
- The policy's hooks are optional and one provider fills them: `registration?`
  (`subscriptionCoordinator.ts:139-146`), `acceptGrant?` (`:152-160`),
  `endSession?` (`:165-167`); ChatGPT sets all three (`chatgptProvider.ts:338-357`),
  Grok none (`xaiProvider.ts:202-237`). The coordinator branches on each
  (`SubscriptionOAuthCoordinator.ts:149-153, 262-268, 330-335`), and `pkce.ts:52`
  sends the OIDC `nonce` only when `acceptGrant` is defined: a request field
  decided by the presence of another module's hook.
- "The account a session names" has four shapes: `SubscriptionSession = Base & { email?; accountId? }`
  (`subscriptionCoordinator.ts:28-32`), `SubscriptionSessionStatus { signedIn; email?; accountId? }`
  (`:59-63`, where `signedIn: false` means the other two are absent), the app's
  `SubscriptionSessionFields { email?; accountId? }` (`subscriptionProviders.ts:154-157`)
  and `SubscriptionAccount extends SubscriptionSessionStatus { label }` (`:86-89`).
  `signedIn` is read in 10 host and app files.
- The providers are enumerated three times in two vocabularies:
  `PLAN_ROUTES`' session plans `'chatgpt-subscription' | 'xai-subscription'`
  (`errors.ts:34-38`), `SUBSCRIPTION_AUTH_PROVIDERS = ['chatgpt', 'grok']`
  (`packages/harness/src/shared/model/subscriptionAuth.ts:7`), and the app's
  `SUBSCRIPTION_PROVIDERS` rows (`subscriptionProviders.ts:330-335`).
- Exported with no production consumer: `SharedAttempt` (`node.ts:231`, 0
  refs; D6 deletes it), `DeviceLoginOptions` and `LoopbackLoginOptions`
  (`node.ts:233-237`, 0 refs).

**The design decision behind it.** "What is a subscription provider?" Today a
policy object handed to a generic machine, memoized per store, wrapped in a
status function, re-wrapped by the app into a row with a transport fallback.
Nothing in that chain is a thing a caller holds.

**The better design.** Each provider is one Effect service: `ChatgptAccount`
and `GrokAccount` (`Context.Service<Self, Shape>()('llm/ChatgptAccount')`,
`node_modules/effect/dist/Context.d.ts:196`), each built by
`Layer.effect(Tag, Effect.gen(...))` over `Secrets` and `HttpClient`
(`Layer.d.ts:1166`; the effect runs in the layer's scope, which is where the
one `Semaphore.make(1)` of D6 is made), with `{ session: Effect<S | null>, fresh: Effect<S>, signIn(present,
transport): Effect<S>, signOut: Effect<void> }`. The provider module is the
service's implementation: its constants, its session schema, and its own
code for registration, ID-token check and revocation as plain steps of its
`signIn`/`signOut`, sharing `authorizeRequest`, `exchangeAuthorizationCode`,
`refreshOAuthTokens` and the loopback flow as functions (the nonce is always
sent; a provider that does not check it ignores it). The host provides the
two layers once; the harness's `routeCredential` and the app's catalog
`yield*` the tag. With D5's `ModelCredential { accessToken: Effect<string> }`
the harness branch at `credentials.ts:108-126` becomes
`PLAN_ROUTES[route].account`, a tag per plan. Status is `session`: `null` is
signed out, so `signedIn` goes and the app's label is a function of `S`.
Deleted: `SubscriptionCoordinator` and its file (the policy type goes with
it), `forProvider` and the `WeakMap`, `getChatgptStatus` / `getXaiStatus`
(12 refs, 5 files), `SubscriptionSessionStatus` (and the app's two re-spellings),
`registration?` / `acceptGrant?` / `endSession?` and the three branches, the
`acceptGrant`-coupled nonce, `DeviceLoginOptions` / `LoopbackLoginOptions` /
`SharedAttempt` exports, `SUBSCRIPTION_AUTH_PROVIDERS`'s second id vocabulary
(`'grok'`; the plan route's provider id is the one spelling).

**What we give up.** The app's note that each row "calls through rather than
capturing the imported function, so a host suite that swaps `@texra-ai/llm/node`
still intercepts" (`subscriptionProviders.ts:296-298`): a suite provides a
test `Layer` instead, which is what layers are for. Risk: medium; ten host
files read `signedIn`.

**Change amplification.** "A third subscription (an Anthropic plan)", on this
side of the boundary (D5 counted the harness's nine files): today a provider
module, a policy, `PLAN_ROUTES`, `SUBSCRIPTION_AUTH_PROVIDERS`, the app row,
`subscriptionAuth.ts`'s label, three `node.ts` exports, `routeEndpoint.ts`
(finding 1): 8 files; after the provider module (its layer), `PLAN_ROUTES`
and the app row's copy: 3.

**Depends on:** R9 (D6's `Semaphore(1)` coordinator) for the service's
internals; the two change the same file and should land together. Not the
refuted `LLM-subscription-credential-facade`: this proposes no function over
two coordinators for the harness, it deletes the port and the memo.

---

## 4. The Anthropic codec keeps its own position state beside the assembly's, and the three protocols are decomposed three different ways

**Red flags:** two representations of one fact (which output position is
open); a check made at two layers; temporal decomposition (Responses split
by stage, the others not); a comment explaining where a type lives by import
order.

**Evidence.**

- `anthropicWire()` (`api/anthropicMessages.ts:386-568`) is a closure over six
  `let`s (`started`, `stopped`, `next`, `open`, `stop`, `usage`, `:387-392`)
  and refuses, from its own `open`/`next`: a block start while one is open or
  out of order (`:481-484`), a delta to a block that is not open (`:516-517`),
  a `message_delta` or `message_stop` while a block is open (`:418-423, 435-438`).
  `assembleTurn` owns exactly these facts in `slots` and refuses the same
  cases: "reopened an output position" (`api/assembleTurn.ts:115`), "emitted
  progress outside an open output item" (`:143`), "closed an output position
  that is not open" (`:169`), "omitted an output position" (`:234`), "left an
  output item unfinished" (`:239`).
- Google: `googleWire(store)` (`api/googleInteractions.ts:446-519`) refuses a
  missing id when `store` is on, twice (`:463-465, 488-490`), while the model
  tells the assembly the same fact as `allowMissingResponseId: !turn.controls.store`
  (`:629`) and the assembly enforces it (`assembleTurn.ts:81, 100-101`).
- Decomposition: Anthropic is one model file (lowering `:137-305`, usage
  `:315-346`, decoding `:386-568`, client and uploads `:571-676`) plus a Wire
  file; Google the same shape (`:50-212`, `:321-519`, `:699-764`) plus Wire;
  Responses is six files, with the input-part lowering `responsesContent`
  (`api/openaiResponsesCodec.ts:239-296`), `gifFrameCount` (`:196-231`) and
  `DocumentAccess` (`:302-305`) in the *codec* (decoder) file, and a comment
  explaining that `ResponseOrigin` lives there because "the codec is the lowest
  module of this split" (`:37-39`).

**The design decision behind it.** "Who validates a response's structure?"
was answered "the assembly" (`assembleTurn.ts:295-299`: "owns the response
identity, the parts by position, ... terminal validation") and then each
codec kept its own copy. "What is a protocol module?" was never answered
once: two files, or six, with the lowering in the model or in the decoder.

**The better design.** One rule for every protocol: `<p>Wire.ts` (the shapes,
as now), `<p>Codec.ts` (the two directions of the vocabulary mapping: canonical
parts → wire input, wire events → `PartEvent`, no position state), `<p>.ts` (the
`Model`: client, transport, background, uploads). The Anthropic decoder keeps
only the framing it alone knows (`message_start`/`message_delta`/`message_stop`
→ identity, cumulative usage, finish; a thinking block must end signed) and
emits `open`/`append`/`close`; `next` and `open` go, and disorder is the
assembly's refusal. The Google id rule has one owner: the assembly's option
exists, so the wire's two checks go. `ResponseOrigin` sits with
`ResolvedTurn`'s types. Deleted: `next`, `open` and four checks in
`anthropicWire`; two checks in `googleWire`; the codec-file comment.

**What we give up.** A misordered Anthropic stream fails at the end of the
turn instead of at the event (same `provider-rejection`); nothing else.
Risk: low; `packages/llm/test/api/AnthropicMessages.vitest.ts` (636 lines)
and `src/test-kernel/llm/GoogleInteractions.vitest.ts` pin decoding.

**Change amplification.** "A fourth protocol": today no template (two files
or six; lowering in the codec or the model); after, three files by one rule.

**Depends on:** none.

---

## 5. `ResolvedTurn.transport` and the WebSocket `connectionId`: a synthetic identity on the turn, patched back in by the harness

**Red flags:** information leakage (a harness module writes a Responses-only
field); a synthetic id; two representations of "prepared on this binding";
parameters constant per caller.

**Evidence.**

- A Responses turn carries `transport: { kind: 'http' } | { kind: 'websocket', connectionId: UUID }`
  (`turn.ts:225-238, 252`); the WebSocket model mints `connectionId: randomUUID()`
  (`api/openaiResponsesWebSocket.ts:357`); `responseParameters` refuses a turn
  whose `transport` deep-differs from the model's (`api/openaiResponsesRequest.ts:75`).
- `boundTurn` already pins a turn to its origin and mode (`api/turnInput.ts:91-112`),
  so the only thing `transport` distinguishes is two `Model` instances of
  one origin (an HTTP and a WebSocket model). Between those, the request is
  the same bytes: the one difference, uploads, is read at lowering time from
  the model's own `uploads` (`api/openaiResponsesLower.ts:25-35`), which the
  WebSocket model passes as `null` (`openaiResponsesWebSocket.ts:363`).
- The harness rebuilds a background turn from rows and must add
  `transport: { kind: 'http' }` when `origin.protocol === 'openai-responses'`
  (`packages/harness/src/agent/runtime/run/requestContext.ts:288-290`): the
  field is not stored, so the harness knows which protocol needs it patched.
  D3 counted this line as amplification; the field itself is the leak.
- `prepareResponsesTurn(config, origin, transport, request, null, undefined)`
  (`openaiResponsesWebSocket.ts:363`) against
  `prepareResponsesTurn(config, origin, http, request, uploads, background)`
  (`api/openaiResponses.ts:101`): `transport` is a constant per caller.

**The design decision behind it.** "May a turn prepared on one `Model` be
streamed on another of the same origin?" The code says no and carries a
token to enforce it; nothing observable depends on the answer.

**The better design.** Delete `transport` from both `ResolvedTurn` unions,
`HttpTransportSchema`, `ResponsesTransport`, the `transport` parameter of
`prepareResponsesTurn` and `responseParameters`, the deep-equal check,
`connectionId`, and the harness patch. `uploads` and `background` stay as the
model's own facts passed to its `prepareTurn` (the WebSocket model has
neither). Deleted refs: `turn.ts` 2, `openaiResponsesRequest.ts` 7,
`openaiResponsesWebSocket.ts` 3, `openaiResponses.ts` 1, `requestContext.ts` 1.

**What we give up.** Refusing an HTTP-prepared turn on a WebSocket model of
the same origin, which would send the same request. No stored format changes
(the field was never stored). Risk: low.

**Change amplification.** "A third Responses transport": today a new
`transport` literal, a new patch branch in the harness, a new constant at the
model (3 files); after, a model.

**Depends on:** none.

---

## 6. "This route takes a document" is decided by the harness from the catalog and by llm from the route, and the two can disagree

**Red flags:** two owners of one fact; a capability as an optional member;
seven representations.

**Evidence.** The fact "a document part may be sent on this binding" lives in:

1. the catalog's `capabilities.supportsNativePdf`;
2. `routeConfig`'s overlay `supportsNativePdf: false` for the ChatGPT plan
   (`models/modelRoute.ts:277-282`), "so the binding's PDF admission degrades
   a PDF instead of sending a shape the backend rejects";
3. the harness's validation-model overlay (`packages/harness/src/agent/runtime/modelAccess/binding.ts:118-124`);
4. the harness's `mediaInput` reading (2) to send a `document` part or
   rasterize (`packages/harness/src/agent/runtime/run/mediaInput.ts:47,136,252`);
5. llm's `supportsDocumentInput` on the Responses configuration
   (`turn.ts:162`), which `vendorRoute` sets `false` whatever the catalog says
   (`api/responsesConfiguration.ts:43`) and the first-party case sets from the
   catalog (`:88, 117`);
6. `DocumentAccess.accepted` (`api/openaiResponsesCodec.ts:302-305`), read to
   refuse a document at lowering (`:270-276`);
7. `Model.uploadFile?` present iff the credential is an API key
   (`api/openaiResponses.ts:70-99`, `turn.ts:473,479`), which the harness tests
   for presence (`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts:972-974`).

(2) exists because (1) and (5) disagree for the ChatGPT plan; nothing does the
same for a vendor route: a vendor model whose catalog entry says
`supportsNativePdf: true` would have the harness send a `document` (4) that
llm refuses at (6) with `invalid-request`, failing the turn. Whether a current
llm-zoo row does say so, this audit did not check; the seam admits it.

**The design decision behind it.** "Who decides what media a route takes?"
The harness, from the catalog; and llm, from the row; with one hand-patched
overlay where they were known to differ.

**The better design.** One fact on the bound config. llm's configuration
(the row that knows the endpoint takes no files) writes
`capabilities.supportsNativePdf` on the `config` it returns (as `routeConfig`
already does for the plan), and `Binding.config` is what the harness reads
(it already is, `node.ts:84`). Then `supportsDocumentInput` (5) and
`DocumentAccess.accepted` (6) go: the lowering trusts the harness, which read
the same config. `Model.uploadFile` stays optional but is present iff the
route has a files API, the same rule D3 gives `background`. Deleted:
`supportsDocumentInput` (schema field, three row values, one reader at
`openaiResponsesLower.ts:31`), `DocumentAccess.accepted` and the refusal at
`codec.ts:270-276`.

**What we give up.** Nothing. Risk: low.

**Change amplification.** "A vendor Responses endpoint gains input files":
today `vendorRoute`'s constant, the row, and the harness's reading of the
catalog (which may already say yes) must agree; after, the row sets one
capability.

**Depends on:** none.

---

## 7. The sign-in flows fight the fiber model with an uninterruptible prefix, a detached launcher and prose, and the two flows disagree on whether the presenter outlives the sign-in

**Red flags:** reinvented primitives (uninterruptible setup, `forkDetach`,
a hand-rolled deadline beside `Effect.retry`); comments substituting for
design; a single-caller extraction that doubles a guarantee; two
representations of one policy.

**Evidence.**

- `loginWithOAuthLoopback` (`oauth/loopbackLogin.ts:209-322`): a 13-line
  comment (`:214-220, 289-292`) explains that the setup is
  `Effect.uninterruptible` (`:221`) so the browser launcher starts before the
  first interruption check, that the launcher is `forkDetach`ed
  (`:293-296`) so "interruption of the login abandons the join but never the
  launcher, and a late launch failure dies on that fiber — observed and
  inert" (`:217-219`), then `Fiber.join`ed (`:305`). A launch failure after
  the login was interrupted is dropped: a swallowed failure by design. The
  three `Deferred.doneUnsafe` calls (`:246, 260, 271`) are in the Node `http`
  request handler and are the right tool there.
- The app's device-code presenter is the opposite policy: "A child fiber, so
  cancelling the sign-in closes it with the flow"
  (`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts:221-226`,
  `Effect.forkChild`). One product, two answers to "does the prompt outlive
  the sign-in".
- `completeDeviceSession` (`oauth/deviceAuthorization.ts:185-190`) has one
  caller (`oauth/xai/xaiDeviceLogin.ts:63-65`) and wraps `storeTokens` in
  `Effect.uninterruptible`, while `storeTokens` already runs its write under
  `SerializedWrites.run`'s `Effect.uninterruptible(write)`
  (`oauth/authProgram.ts:39-41`; D6 keeps that guarantee in its
  `Semaphore(1)` design).
- `pollDeviceAuthorization` (`deviceAuthorization.ts:92-177`) uses
  `Effect.retry` with `Schedule.spaced` plus `addDelay` (`:150-166`), which is
  right, but keeps the deadline by hand: a `Clock` reading, `beforeDeadline`
  and a `guardedPoll` that re-checks it before each poll (`:95-120`), and a
  `Ref<{ count, last }>` (`:105-108`) to carry the last transient out of the
  retry, which `Effect.retry` already fails with when `while` returns false
  (`:172-176` unwraps it).

**The design decision behind it.** "What may an interrupted sign-in leave
running?" Answered "the browser launcher, always" in one flow and "nothing"
in the other, and the first answer needed an uninterruptible region and a
detached fiber to hold.

**The better design.** The login is `Effect.scoped(gen)`: the server is
`acquireRelease`, the callback a `Deferred` completed from the Node handler,
`openBrowser` forked into the scope (`Effect.forkScoped`) and joined, nothing
uninterruptible; interrupting the sign-in interrupts the presenter, as the
device flow already does, and a launch failure is the flow's failure.
`completeDeviceSession` goes (the store's write is uninterruptible by the
coordinator's design). The poll's deadline is the schedule's:
`Schedule.spaced(interval).pipe(Schedule.addDelay(() => Ref.get(extra)), Schedule.upTo({ duration: expiresIn }))`
(`upTo` "limits an existing schedule by elapsed duration",
`node_modules/effect/dist/Schedule.d.ts:1212`; `during` at `:679` is the
alternative), and `Effect.retry`'s own last-failure rule
(`Effect.d.ts:7132-7146`: "the last failure is propagated") replaces
`transients.last`; the consecutive-transient budget stays the one `Ref` it
is. Deleted: the uninterruptible prefix, `forkDetach` + `Fiber.join`, 13
comment lines, `completeDeviceSession`, `beforeDeadline` / `guardedPoll` /
`deadline`, `transients.last`.

**What we give up.** A browser launcher that keeps running after the user
cancels the sign-in. Risk: low; `packages/llm/test/auth/ChatgptLoopbackLogin.vitest.ts`
(90 lines) and `DeviceAuthorization.vitest.ts` (52) cover both flows.

**Change amplification.** "A host presents the consent URL with a dialog
that must close on cancel": today only the device flow closes it; after both.

**Depends on:** R9 (D6) for the coordinator's uninterruptible write; the
loopback and deadline changes can land alone.

---

## 8. The API-key lookup is four one-line projections over one private function, and the key's origin is re-spelled as a status

**Red flags:** shallow module; two representations of one fact; a vague file
name.

**Evidence.**

- `providers/apiProviders.ts`: `resolveApiKey` is private (`:74-90`) and four
  exports each `Effect.map` it once: `lookupApiKey` (`:98-106`, 9 refs in 4
  files), `lookupApiKeyOrigin` (`:109-117`, 4 in 2), `hasUsableApiKey`
  (`:153-161`, 15 in 6), `loadApiKeyStatusMap` (`:126-146`, 10 in 5).
- `ApiKeyStatus = 'set' | 'env' | 'not-set'` (`:44`) is `CredentialOrigin = 'secret' | 'env' | 'none'`
  (`providers/credentials.ts:52`) through `STATUS_BY_ORIGIN` (`:119-123`); the
  two literal sets are read in 17 host and app files between them
  (`packages/cli/src/chat/tui/forms/ProviderApiKeyForm.tsx` alone 16 refs).
- `providers/providers.ts` (38 lines) is a vague name for three unrelated
  things: the Kimi Code URL (`:9`, finding 1), `providerDisplayName` (`:15-17`,
  33 refs) and the env-name derivation (`:24-38`), all reads of the manifest
  in `providerPlugins.ts`.

**The design decision behind it.** "What does a caller ask about a key?"
Four separate questions were exported instead of the one answer
(`{ value, origin }`) they are all read off.

**The better design.** `apiKey(secrets, provider): Effect<{ value: Redacted | undefined; origin: CredentialOrigin }>`
(today's `resolveApiKey`, exported) and `apiKeyOrigins(secrets): Effect<Record<ApiKeyProviderId, CredentialOrigin>>`
for the status surfaces; `ApiKeyStatus` goes and the UI reads
`CredentialOrigin` (`'not-set'` is `'none'`, `'set'` is `'secret'`);
`hasUsableApiKey` becomes `origin !== 'none'` at its callers, or stays as the
one derived predicate if 15 rewrites are judged churn. `providers.ts` folds
into `providerPlugins.ts` (its two functions are manifest reads) and the URL
into the `kimiCode` row. Deleted: three exports, `ApiKeyStatus`,
`STATUS_BY_ORIGIN`, `providers.ts`.

**What we give up.** Nothing. Risk: low, mechanical across 17 files.

**Change amplification.** "A key may also come from a host keychain (a
fourth origin)": today `CredentialOrigin`, `ApiKeyStatus`, `STATUS_BY_ORIGIN`
and every UI switch on both; after `CredentialOrigin` and the UI.

**Depends on:** none.

---

## 9. Smaller red flags (batched)

a. **The provider manifest's row kinds are a sentinel grammar, and its id
   list is restated twice outside llm.** `ModelProviderPlugin` encodes four
   row kinds in `apiKey?: true` and `baseUrl` absent / `null` / string /
   object (`providers/providerPlugins.ts:43-59`), with a comment explaining
   what absent and `null` mean (`:52-57`) and four id types extracted by field
   presence (`:161-185, 207`); three `AssertNever` checks (`:216-249`) hold
   the coverage of llm-zoo, which is good and stays. The harness restates the
   backend ids as `MODEL_PROVIDERS` (`packages/harness/src/shared/schemas/runInput.ts:102-113`,
   the same ten as `BACKEND_PROTOCOLS`, `providerPlugins.ts:191-204`, under a
   comment saying "a new provider is added once", `:96-100`) and the
   endpoint rows with display names as `PROVIDER_ENDPOINT_STATE_ENTRIES`
   (`packages/harness/src/shared/state/providerSettings.ts:25-36`, a third
   spelling of `providerDisplayName`). **Change amplification, the named
   change:** "add an API-key provider that serves Responses on its own
   endpoint" (MiniMax's shape) touches today `providerPlugins.ts` (manifest
   row and `BACKEND_PROTOCOLS` row), `responsesConfiguration.ts`
   (`RESPONSES_ROUTES` row), `runInput.ts:102-113`, `providerSettings.ts:25-36`
   (and `:57-62` for a region toggle), `packages/harness/src/logger/redaction.ts:27-39`
   (compile-forced, keep), `packages/texra/src/shared/settingsView/settingSurfaces.ts:194-198`,
   `packages/texra/src/model/providerPresentation.ts:53-56`,
   `packages/texra/src/model/setupModelDefaults.ts:22`: 8 production files, 9
   edits, plus `reasoningChoice.ts` when its controls differ (finding 2) and
   a live suite. After (`MODEL_PROVIDERS` = `keyof BACKEND_PROTOCOLS`, the
   endpoint and region rows derived from `EndpointProviderId` /
   `RegionalProviderId` + `providerDisplayName`, a discriminated row
   `kind: 'backend' | 'alias' | 'unserved'` in place of the sentinels): the
   manifest row, the route row, the redaction pattern and the app's
   presentation (dashboard URLs, probe model: product copy): 4.
b. **`protocol.ts` is a conjoined file** named for one of five things it
   holds: binding identity (`:23-96`), background capability (`:104-115`, D3),
   JSON materialization (`:117-137`), the prepared-history grammar
   (`:139-194`, which `message.ts:230-233` applies and `index.ts:48` exports
   for the harness's store check) and the usage schema (`:196-229`). It is the
   bottom of the import order (`README.md:244-246`), so whatever must be
   lowest lands there. The grammar belongs with `message.ts`'s schema, the
   usage schema with `turn.ts`, and the file becomes `origin.ts`.
c. **`EVIDENCE_PROTOCOL`** (`message.ts:113-124`) keys reasoning-evidence
   kinds, `providerUsage` kinds (`anthropic`, `xai`) and finish-evidence kinds
   (`google-interactions`, `openai-responses`) in one map, read for three
   different fields (`message.ts:139`, `turn.ts:348-350`): three vocabularies
   in one table because their values happen to be strings.
d. **A plan is spelled as `kind` for session plans and as `usageRoute` for
   key plans** (`models/modelRoute.ts:71-86`: `{ kind: 'chatgpt-subscription' }`,
   `{ kind: 'xai-subscription' }`, `{ kind: 'api-key', usageRoute }`), and
   `bindModel` re-joins them into `BillingRoute`
   (`node.ts:214`: `route.kind === 'api-key' ? route.usageRoute : route.kind`);
   `PLAN_ROUTES[...].credential: 'session' | 'key'` (`errors.ts:33-55`)
   states the same split as data. Route-kind literals appear in 5 llm files
   (25 refs) and 10 harness/app files (35 refs). One shape,
   `{ kind: 'api-key' | 'session', provider, plan: PlanRoute | null }`, would
   let `billing` be `route.plan ?? 'api-key'` and remove the `usageRoute`
   branch from every reader; it is a wider change and sits beside D2's
   `'personal'` work, so it is recorded, not ranked.
e. **`xaiProvider.ts` states a token's expiry three times:** the schema
   defaults `expires_in` through both `catchDecoding` and `withDecodingDefault`
   to the same constant (`oauth/xai/xaiProvider.ts:109-119`), and
   `buildSession` prefers the access JWT's `exp` over it (`:225-228`). One
   reading (JWT `exp`, else `expires_in`, else the default) in `buildSession`
   would leave the schema a plain decode.
f. **Signature lies and re-derivations in `models/`:** `isKimiSubscriptionEligible`
   takes `baseUrl` it never reads (`modelRoute.ts:140-146`);
   `resolveModelSource` (`:161-165`) is "the provider the route bills" spelled
   for the picker, and the harness re-derives it from the route it already
   holds (`packages/harness/src/model/computeModelOptions.ts:578`:
   `route.kind === 'api-key' ? route.provider : resolveModelSource(config)`).
   With finding 1's route carrying its provider, `resolveModelSource` is
   `decideModelRoute(config, OWN_KEY_ROUTE_FACTS).provider`.

---

## Good modules in this area

- `api/assembleTurn.ts`: one reducer over `PartEvent`, every provider
  difference outside it, failures enriched with the identity in one place
  (`:301-324`). Finding 4 asks the codecs to lean on it, not to change it.
- `api/parts.ts`'s `GROW` table (`:141-169`): how each channel grows the one
  part kind it belongs to, as data; `restates` (`:118-127`) states the
  restatement rule once.
- `api/transport.ts`: `rejoin` (`:173-193`) and `ownedAbortSafeRequest`
  (`:229-265`) state abort-safety once for three SDKs; `pullStream` (`:45-57`)
  is the one `Stream.fromPull` ladder.
- `api/openaiResponsesWebSocket.ts`: the connection's lifetime is
  `ScopedRef.fromAcquire` + `ScopedRef.set` (`:359-370`) and its turns a
  `Semaphore(1)` (`:360, 367`): the Effect-native shape D5 asks the harness's
  `swapModel` to take.
- `oauth/oauthRequest.ts`: one request is one fiber under one timeout
  (`:85-125`), typed failures, and the HTTP wrapper dropped so the request
  body (credentials) never rides on the cause (`:104-106`).
- `oauth/formTokenClient.ts`: two grants over a data-only endpoint
  (`:24-33, 49-92`), no client object. `oauth/idToken.ts`: ID-token
  verification as one function over `effect/jose` (`:36-73`).
- `providers/credentials.ts`'s `resolveCredential` (`:64-86`): the one
  secret-then-env ladder, read through Effect's `ConfigProvider`.
- `providers/providerPlugins.ts`'s compile-time coverage of llm-zoo
  (`:216-249`): a provider llm-zoo adds fails the build until the manifest
  says what it is. Keep that, whatever the row shape becomes (finding 9a).
- `models/turnCost.ts`: pure, one owner of the billing arithmetic, the
  vendor facts named in two private functions.
- `models/reasoningChoice.ts`'s `chooseReasoning` as the one policy for every
  route and agent; finding 2 makes its `routeControls` the only owner.

---

## Already settled, left alone

- **`ModelError.kind` is six values** (#14776, HEAD`^`; storage note "Done
  2026-11-06"): `unsupported`, `malformed-output`, `rate-limited`,
  `quota-exhausted` and `observation-deadline` are gone with their readers;
  nothing above reports them. `SecretsFailed.reason` went in the same commit
  (`providers/credentials.ts` now has no `reason`).
- **`SubscriptionOAuthError.kind` and `needsReauth`**: kept with a reader
  (storage note, same entry). **`toErrorMessage` in `oauth/support.ts`**: the
  storage note (line 158) already lists the duplicate.
- **The seven wire knobs and the constant Responses columns**
  (`2026-11-03-fewer-processing-options.md` §1–2): `BindSpec.options` defaults
  that never run, the two `startsWith('gpt')` tests
  (`responsesConfiguration.ts:110`), `useGoogleBackgroundResponses`,
  `fastTier` kept on the owner's word. Not re-listed.
- **`SharedAttempt`, `SerializedWrites`, `sessionGeneration`,
  `stableSession`, `supersedeInFlightRefresh`**: D6 / R9. Finding 3 only adds
  the instance's ownership and the port.
- **Background's representations, `backgroundCapable`, Google's `store`
  requirement** (`protocol.ts:104-115`, `googleInteractions.ts:576-593, 765`):
  D3 and its "Already settled" entry.
- **`LLM-subscription-credential-facade`** (`refuted-candidates.json`, PR
  14504): a facade over two coordinators for the harness hid nothing. Finding
  3 proposes no such facade; it deletes the port and the memo and makes each
  account a layer.
- **`ModelRetryGate` onto `Schedule` / `CircuitBreaker`**: refuted; out of
  scope here in any case.
- **`Deferred.doneUnsafe` in the loopback request handler**
  (`loopbackLogin.ts:246, 260, 271`): a Node `http` callback cannot return an
  Effect; completing a `Deferred` from it is the foreign-edge pattern, not a
  reinvention. Finding 7 keeps it.
- **`catchDecoding` on JWT display claims** (`oauth/jwtDecode.ts:11-13`,
  `chatgptProvider.ts:116-119`, `xaiProvider.ts:157-160`): display-only,
  non-authoritative (the ID token's signature is checked once at sign-in by
  `verifyIdToken`); AGENTS.md allows it there.
- **`verdict.ts`'s vendor phrase tables**: "per-provider by nature, already
  the single owner" (storage note); D's area.
- **`modelConfig` / `modelRefOf`** (`models/modelSelection.ts:33-43`): one-line
  projections of `selectModel` with 26 and 10 consumers; a stable convenience
  over a stable fact, not worth the churn of inlining.
- **The ambient-header refusals** (`anthropicMessages.ts:582-589`,
  `openaiResponsesRequest.ts:216-221`): refusing a vendor SDK's environment
  override at the boundary is the right place.
- **`KIMI_CODE_SUBSCRIPTION_CONTEXT_WINDOW`** and the Kimi wire-id map
  (`modelRoute.ts:241-253`): product facts of one route, with one reader.
- **`api/uploadCache.ts` and `api/anthropicThreads.ts`**: D's "Good modules".

---

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

`corepack pnpm install` finished during this audit, so every primitive below
was read in `node_modules/effect/dist/*.d.ts` at the line cited; the repo's
own uses are named where it already writes the same shape. Findings whose
subject is pure computation or data name no fiber primitive on purpose:
AGENTS.md "Effect" keeps pure computation plain TypeScript, and a `Schema`
is the Effect-native form of a refused case.

| Finding | Hand-rolled today                                                                                                                                                                      | Effect primitive that is the thing                                                                                                                                                                                                                                                                                                                                | Note                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `decideModelRoute` → `resolveRouteEndpoint` → `routeConfig`, the harness's `routeEndpoint` wrapper that `Effect.die`s on `undefined`, three endpoint constants                        | none at run time: one pure decision over `RouteFacts`. The refused case ("no endpoint for a regional provider") is a `Schema.Record(EndpointProviderIdSchema, Schema.String)` on the facts the host decodes once (`Schema.decodeUnknownSync`), so the decision never sees `undefined`                                                                           | AGENTS.md "Design guardrails": refuse at a boundary over handling everywhere; the harness already decodes host facts with `Schema` in `modelSettings.ts`                            |
| 2       | `routeControls` switch + six `RESPONSES_ROUTES` row values + `wireEffort`'s catalog read + Google's level fallback                                                                      | none: one table keyed by provider, `ReasoningEffortSchema`'s literals (`turn.ts:60-69`) as the one effort vocabulary                                                                                                                                                                                                                                              | pure                                                                                                                                                                                |
| 3       | `SubscriptionOAuthCoordinator.forProvider`'s `WeakMap<CredentialStore, …>` memo; `SubscriptionCoordinator` port; `getChatgptStatus`/`getXaiStatus` wrappers; `SubscriptionSessionStatus` | `Context.Service<ChatgptAccount, Shape>()('llm/ChatgptAccount')` (`Context.d.ts:196`) provided by `Layer.effect(ChatgptAccount, …)` (`Layer.d.ts:1166`, "executed in the scope of the layer"); a host provides it once beside `Secrets`; a suite provides `Layer.succeed` (`Layer.d.ts:839`). Inside, D6's `Semaphore.make(1)` (`Semaphore.d.ts:253`). `session: Effect<S \| null>` replaces `signedIn` | `RcMap.make` (`RcMap.d.ts:215`) would be the primitive only if instances were keyed by store at run time; there is one `Secrets` per process, so a layer is the thing. Repo: `Layer.effect` in `packages/harness/src/controllers/session/sessionLayer.ts` |
| 4       | `anthropicWire`'s `next`/`open` closure state; `googleWire`'s two `store && !id` checks beside the assembly's `allowMissingResponseId`                                                 | the one reducer already there: `Stream.mapEffect(assembly.step)` + `Stream.takeUntil` (`assembleTurn.ts:331-344`); the codec is a pure `(raw) => PartEvent[]` with only the framing state the assembly cannot know                                                                                                                                              | no new primitive; deletes state                                                                                                                                                     |
| 5       | `ResolvedTurn.transport` + `connectionId: randomUUID()` + `isDeepStrictEqual` + the harness patch                                                                                      | none: the binding identity is already `sameModelOrigin` (data) checked by `boundTurn`; the WebSocket model's lifetime is already `ScopedRef.fromAcquire` + `ScopedRef.set` (`ScopedRef.d.ts:53,130`) and `Semaphore.takeScoped` (`Semaphore.d.ts:628`) at `openaiResponsesWebSocket.ts:359-370`                                                                  | deletion only                                                                                                                                                                       |
| 6       | `supportsDocumentInput` + `DocumentAccess.accepted` + `uploads === null` + `Model.uploadFile?` presence, beside the catalog's `supportsNativePdf`                                      | none: one field on `Binding.config.capabilities`, written by the route's configuration; `uploadFile` present iff the route has a files API (D3's rule for `background`)                                                                                                                                                                                             | data                                                                                                                                                                                |
| 7       | `Effect.uninterruptible(setup)` + `Effect.forkDetach(openBrowser, { startImmediately })` + `Fiber.join` + 13 comment lines                                                             | `Effect.scoped` (`Effect.d.ts:12567`) over `Effect.acquireRelease` (`:12676`, kept), `Deferred.make` (`Deferred.d.ts:152`) completed by `Deferred.doneUnsafe` (`:1604`) from the Node handler (kept), `Effect.forkScoped(openBrowser(url))` (`Effect.d.ts:17216`: `Fiber` in the caller's `Scope`) then `Fiber.join`; `Effect.timeoutOrElse` (`:8471`, kept) | interrupting the sign-in interrupts the presenter, as the device flow already does with `Effect.forkChild` (`subscriptionProviders.ts:224-225`)                                  |
| 7       | `completeDeviceSession`'s `Effect.yieldNow` + `Effect.uninterruptible(complete())`                                                                                                     | the coordinator's own `Effect.uninterruptible` (`Effect.d.ts:14415`) inside `Semaphore.withPermits(1)` (`Semaphore.d.ts:344`), D6                                                                                                                                                                                                                                | single-caller extraction deleted                                                                                                                                                    |
| 7       | `pollDeviceAuthorization`'s `Clock` deadline, `beforeDeadline`, `guardedPoll`, `transients.last`                                                                                       | `Effect.retry({ while, schedule })` (`Effect.d.ts:7132`, "the last failure is propagated") with `Schedule.spaced(interval).pipe(Schedule.addDelay(…), Schedule.upTo({ duration }))` (`Schedule.d.ts:1070, 353, 1212`; `Schedule.during` `:679` is the elapsed-time schedule on its own)                                                                        | the file already writes `Effect.retry` + `Schedule.spaced` + `addDelay` (`deviceAuthorization.ts:150-166`); `chatgptProvider.ts:282-289` writes `Effect.retry({ times, schedule: Schedule.exponential })` |
| 8       | four `Effect.map` projections over `resolveApiKey`; `ApiKeyStatus` ↔ `CredentialOrigin` table                                                                                          | none: one `Effect<{ value, origin }>`; the ladder already reads the environment through `Config.String` + `Config.option` (`Config.d.ts:769`) as `resolveCredential` does (`providers/credentials.ts:55-60`)                                                                                                                                                       | "no copy of it is cached here" (`apiProviders.ts:70-71`) is deliberate, so no `Effect.cached` (`Effect.d.ts:13539`)                                                                 |
| 9a      | `MODEL_PROVIDERS` and `PROVIDER_ENDPOINT_STATE_ENTRIES` restating the manifest; sentinel row kinds                                                                                      | `Schema.Literals(Struct.keys(BACKEND_PROTOCOLS))` (the pattern `errors.ts:61` already uses for `PlanRouteSchema`) and a discriminated `Schema.Union` of row kinds                                                                                                                                                                                                 | data                                                                                                                                                                                |

What stays as it is because it is already the primitive: `Effect.callback`
for the `ws` socket's `open`/`error`/`unexpected-response` and the `http`
server's `listening`/`error` events (`openaiResponsesWebSocket.ts:144-183`,
`loopbackLogin.ts:110-124`: a foreign event emitter resumed once);
`Effect.abortSignal` (`Effect.d.ts:14507`) under `Stream.fromPull`
(`Stream.d.ts:487`) in `transport.ts:45-57, 205-220`; `Effect.acquireRelease`
for the Anthropic iterator and the loopback server; `Effect.timeoutOrElse`
for the OAuth request (`oauthRequest.ts:112-123`) and the callback wait;
`Effect.retry` for revocation and the device poll.
