# LM: `packages/llm` (model access)

Read at `cb22acd`. Covered: `packages/llm/src/` (`api/`, `models/`,
`providers/`, `node.ts`, `index.ts`, `turn.ts`, `protocol.ts`, `errors.ts`)
and the harness callers of `bindModel`
(`packages/harness/src/agent/runtime/modelAccess/binding.ts`,
`credentials.ts`). Not read in this pass: `packages/llm/src/oauth/`,
`message.ts`, `models/turnCost.ts`, the three `*Wire.ts` schema files, and
lines 120-230 of `api/openaiResponsesLower.ts`. Nothing below is claimed
about them.

Earlier work on this package is large (round 2's `O1`-`O9`, `D6`, `V-R3`,
`V-R4`, `V-R13`, `TC6`, the options note
`.agents/docs/proposed/simplification/2026-11-03-fewer-processing-options.md`,
the open note
`.agents/docs/proposed/simplification/2026-11-14-llm-history-lowering-and-reply-document-recovery.md`).
Most of what the task asked to look for (one structure per provider,
constant columns, per-call options) is already recorded or landed. Five
findings survive; three are remainders of landed rows and say so.

Open PR #14953 (`claude/optimistic-cori-q0n270`) changes sixteen files here.
Its llm diff is only `Schema.String.check(Schema.isMinLength(1))` to
`Schema.NonEmptyString` (84 added, 94 removed); it fixes none of the findings
below and conflicts with none of the proposed fixes beyond line context.

### LM-1: The ChatGPT plan is named twice on one bind, and the WebSocket decision is split across the two names

- **Package:** llm (one line in harness)
- **Flags:** repetition (a fact with two owners); an option for a special
  case; a comment that is false; special and general code mixed
- **Evidence:**
  - `BindSpec` carries `route: CredentialRoute` and
    `credential: ModelCredential` (`packages/llm/src/node.ts:61-65`). The
    route already says `plan: 'chatgpt-subscription'`; the credential says it
    again as `kind: 'chatgpt'` (`node.ts:51-53`). The one producer maps one
    into the other: `chatgpt ? { kind: 'chatgpt', accessToken } : { kind: 'api-key', apiKey }`
    (`packages/harness/src/agent/runtime/modelAccess/binding.ts:192-194`).
  - Readers split between the two names. By credential kind:
    `responsesConfiguration.ts:84` (the plan's request rules),
    `openaiResponses.ts:86` (uploads), `openaiResponsesRequest.ts:207`,
    `node.ts:123`, `node.ts:196`. By route: `configuration.ts:182-185`
    (`credentialScope`), `reasoningChoice.ts:60` (`CODEX_ROUTE_EFFORTS`),
    `modelRoute.ts:320` (`routeConfig`), `node.ts:205` (`billing`). A bind
    with `kind: 'chatgpt'` on an `api-key` route is representable and yields
    the plan's dialect under the scope `openai:api-key`, priced per token.
  - "Serves the WebSocket" is decided in two places:
    `servesWebSocket(options, configuration)` (`configuration.ts:243-253`)
    and `spec.credential.kind === 'api-key' &&` in front of it
    (`node.ts:195-197`). The first one's comment says "on OpenAI's own
    endpoint (the ChatGPT subscription or the API ...)"
    (`configuration.ts:239-240`) and its `onOpenAiEndpoint` accepts
    `requestDialect === 'chatgpt'` (`responsesConfiguration.ts:26`); the
    second one's comment says "A ChatGPT plan's token is served over HTTP"
    (`node.ts:193-194`). The first comment is false as the code runs.
  - The WebSocket model still carries the session-token path:
    `authorized(bearer, ...)` around `connect`
    (`openaiResponsesWebSocket.ts:351`), the `token` kept on the connection
    (`:315-316`), and the hand-back-and-resend block (`:365-387`, 23
    lines). In the harness no bind reaches it: an OpenAI key route's bearer
    is a `string` (`credentials.ts:273`), the Grok session is `kind: 'api-key'`
    with a `SessionToken` but on `https://api.x.ai/v1`, which
    `onOpenAiEndpoint` refuses, and the ChatGPT session is excluded at
    `node.ts:196`. Only an SDK caller passing a `SessionToken` as an OpenAI
    API key reaches it.
  - The options note lists the double name
    (`2026-11-03-fewer-processing-options.md` section 2, "The ChatGPT route
    is named two ways"); its "Landed 2026-11-04" paragraph does not say it
    was done, and it is still in the tree. New here: the split WebSocket
    decision, the false comment and the unreached WebSocket path.
- **Better design:** the route is the owner. `BindSpec.credential` becomes
  the bearer alone (`string | SessionToken`); `Facts` already holds
  `spec.route`, so `firstPartyResponses` tests
  `route.kind === 'session' && route.plan === 'chatgpt-subscription'`, and
  `servesWebSocket` takes the route and holds the whole rule. The WebSocket
  model takes a fixed key (`string`) and loses the renewal block. The
  harness writes `credential: credential.bearer`.
- **Deleted:** `ModelCredential`'s two cases and its `kind` (5 readers),
  the mapping at `binding.ts:192-194`, the `node.ts:196` half of the
  WebSocket rule, `bearerOf`, about 30 lines of
  `openaiResponsesWebSocket.ts`, one false comment.
- **Size:** about 90 changed lines, 7 files (6 llm, 1 harness), plus
  `packages/llm/docs/api/` regenerated and `packages/harness/example/01-llm-turn.ts`.
- **Risk / owner decision:** **owner decision.** `ModelCredential` and
  `BindSpec` are published names of `@texra-ai/llm/node`. Also decides that
  a session token on OpenAI's endpoint is served over HTTP, never the
  socket.

### LM-2: `allowedReasoningEfforts` is one value in all three producers (remainder of O2)

- **Package:** llm
- **Flags:** a table column that is constant; repetition
- **Evidence:** O2 (catalogue: landed, #14785 via #14787) made
  `routeControls` the owner and listed "the `allowedReasoningEfforts` column
  (6 values, 1 schema field, 1 reader)" as deleted. The column is still a
  field of `ModelConfiguration` (`packages/llm/src/turn.ts:171-173`) and its
  three producers now write the same expression:
  `allowedReasoningEfforts: acceptedEfforts` (`responsesConfiguration.ts:54`),
  `facts.acceptedEfforts` (`:97`, `:121`). One production reader,
  `openaiResponsesRequest.ts:70-73`; one test fixture,
  `packages/llm/test/api/OpenaiResponses.vitest.ts:20`. The reader checks
  `turn.controls.reasoning.effort`, whose only producer is
  `config.defaults.reasoning` (`openaiResponsesRequest.ts:44`), built by the
  same row from `facts.effort`, which `chooseReasoning` already limited to
  those levels. The check can fail only for a `ResolvedTurn` built by hand.
  Same remainder: Google's `thinkingLevel` falls back to a literal `'high'`
  when the chosen effort is not one of its levels (`configuration.ts:125-127`),
  the fourth statement of Gemini's controls O2 named.
- **Better design:** delete the column and its check; the bind is the one
  place a level is validated. For Google, `routeControls`' Google case names
  the levels the request takes, so `chooseReasoning` returns one of them and
  the row writes `effort` without a fallback (a Gemini 2.5 model with no
  levels keeps `'high'` as that case's stated default, in one place).
- **Deleted:** `allowedReasoningEfforts` (1 type field, 3 row values, 1
  check, 1 fixture entry), `Facts.acceptedEfforts` and its computation at
  `configuration.ts:201` if no other reader remains (it has none today
  outside the three rows), the `'high'` literal.
- **Size:** about 35 lines, 5 files.
- **Risk / owner decision:** none for the column. The Google part changes
  nothing on the wire if the default is kept; confirm with
  `packages/llm/test-live/googleInteractions.live.ts`.

### LM-3: Two route facts are decided inside protocol modules, beside the configuration table that claims every vendor rule (remainder of O6)

- **Package:** llm
- **Flags:** information leakage; repetition; a comment that is false
- **Evidence:** `api/configuration.ts:1-7` says "Every vendor quirk the
  package knows lives in this table and the Responses vendors'". Two do not.
  - Uploads. `openaiResponsesModel` builds the Files cache when
    `transport.authentication.kind === 'api-key'` (`openaiResponses.ts:83-86`),
    not when the route takes files. Every vendor row sets
    `supportsDocumentInput: false` (`responsesConfiguration.ts:53`), yet a
    DeepSeek, Kimi, GLM, DashScope or MiniMax binding gets a cache, a scope
    finalizer and a `uploadFile` member. `Model.uploadFile`'s contract says
    "Present only where the binding serves a files endpoint"
    (`turn.ts:489`), and the harness acts on presence
    (`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts:898-900`).
    The ChatGPT row says "takes no input files" twice: as
    `supportsDocumentInput: false` (`responsesConfiguration.ts:95-96`) and
    as the credential test. O6 asked for "present iff the route has a files
    API"; that half did not land.
  - Message threads. `messageThreads` decides "Anthropic's own API" with
    `URL.parse(options.endpoint)?.hostname === 'api.anthropic.com'`
    (`anthropicThreads.ts:154`), a second spelling of the manifest's
    `baseUrl: 'https://api.anthropic.com'` (`providerPlugins.ts:79`). The
    Responses side asks the same question of its endpoint through the
    manifest constant (`onOpenAiEndpoint`, `responsesConfiguration.ts:23-28`).
    The Anthropic configuration has one capability field
    (`supportsSystemMessages`, `turn.ts:197`); threads is not one.
- **Better design:** the row states both. Uploads follow
  `config.supportsDocumentInput` (the WebSocket model keeps passing no
  cache and sends bytes). The Anthropic case of `CONFIGURE` sets
  `threads: base.deployment.endpoint === <the plugin's baseUrl>`, read by
  `messageThreads` in place of `endpoint`; the plugin's URL is the one
  spelling of each vendor's own endpoint.
- **Deleted:** the credential test and its comment at
  `openaiResponses.ts:83-86`, `uploadFile` on five vendor bindings, the
  hostname literal and `messageThreads`' `endpoint` option.
- **Size:** about 25 lines, 5 files.
- **Risk / owner decision:** an Anthropic endpoint override on the same host
  with a path would stop taking threads under an exact-URL test; keep the
  hostname comparison but against the plugin's URL if that matters. No
  owner decision.

### LM-4: The pure configuration decision throws, and `bindModel` keeps an adapter to turn the throws back into failures

- **Package:** llm
- **Flags:** a single-purpose adapter (two callers, both for one cause);
  repetition (one rule checked three ways); non-obvious code
- **Evidence:**
  - `configurationFor` is documented as a decision over data and throws:
    `throw new ModelError({ kind: 'invalid-request', ... })`
    (`configuration.ts:149-154`) and `Result.getOrThrowWith(chooseReasoning(...))`
    (`:159-162`). `chooseReasoning` returns a `Result`; the throw discards
    that shape one line later.
  - `googleInteractionsModel` is the one protocol constructor that is a
    plain function and throws (`throw new TypeError('Google Interactions requires an explicit API key.')`,
    `googleInteractions.ts:560`); the Anthropic and Responses constructors
    are `Effect.fn` and fail with `ModelError`
    (`anthropicMessages.ts:575-579`).
  - `constructed` (`node.ts:107-119`) exists for those two callers
    (`node.ts:152`, `:190`): `Effect.try` that keeps a `ModelError` and
    rewraps anything else as `invalid-request`.
  - "The key is not empty" has three owners: Anthropic's constructor
    (`anthropicMessages.ts:575-579`), Google's throw, and the Responses
    `BearerTokenSchema` per request (`openaiResponsesRequest.ts:186-203`).
    `bearer` in `node.ts:122-130` already narrows the credential for the two
    non-Responses protocols and is where the check belongs.
- **Better design:** `configurationFor` returns
  `Result<{ config, options, configuration }, ModelError>` (both failures
  are already values), and `bindModel` yields it with `Effect.fromResult`.
  `bearer` refuses an empty key once; the two constructors drop their own
  check and Google's becomes total, called without a wrapper.
- **Deleted:** `constructed`, two `throw`s, two empty-key checks.
- **Size:** about 40 lines, 4 files.
- **Risk / owner decision:** none. The message for an empty Google key
  changes from a `TypeError` text to the shared one.

### LM-5: Small items of one species: the same thing under two names or written twice

- **Package:** llm
- **Flags:** repetition; a comment that is false; pass-through variable
- **Evidence:**
  - One type, three names. `ConfigurationOf` is declared in `turn.ts:222`
    (file-local) and again, exported, in `configuration.ts:32-35`; the
    Responses case is then `OpenAIResponsesConfiguration` (`turn.ts:225`),
    `ResponsesConfiguration` (`responsesConfiguration.ts:17`) and
    `ConfigurationOf<'openai-responses'>`. 26 references to the three
    `*Configuration` aliases across `packages/llm/src`, its tests and the
    harness.
  - The Stainless SDK failure reading is written twice with the same body:
    `openaiFailure` (`api/openaiError.ts:8-21`) and Anthropic's `sdkFailure`
    (`anthropicMessages.ts:91-103`) both pass
    `cause instanceof APIError && !(cause instanceof APIConnectionError) ? { status, headers, requestId: cause.requestID } : undefined`
    to `sdkModelError`. 17 call sites between them. Google's differs for a
    stated reason (`googleInteractions.ts:222-230`) and stays.
  - `openaiError.ts:7` says "Classifies failures shared by the two direct
    OpenAI protocols". `TurnProtocolSchema` has one OpenAI protocol
    (`protocol.ts:32-36`); the second went with Chat Completions. The file
    now holds one 14-line function with one protocol's callers.
  - `PROTOCOL_OF` (`configuration.ts:134-135`) is `BACKEND_PROTOCOLS` under
    a second name, kept only to widen the key type for one lookup at `:148`.
- **Better design:** export `ConfigurationOf` once from `turn.ts` and use it
  everywhere; drop the three aliases or keep only them. One
  `stainlessFailure(cause, { APIError, APIConnectionError }, message)` in
  `api/transport.ts`, called by both codecs, and `openaiError.ts` goes.
  Index `BACKEND_PROTOCOLS` through `Object.hasOwn` at the one lookup.
- **Deleted:** one `ConfigurationOf`, up to three aliases, `openaiError.ts`,
  one of the two classifier bodies, `PROTOCOL_OF`, one false comment.
- **Size:** about 60 lines, 9 files (mostly import lines).
- **Risk / owner decision:** none; the aliases are not entry exports
  (`index.ts`, `node.ts` do not name them).

## Good modules here

- `api/assembleTurn.ts` and `api/parts.ts`: one reducer over `PartEvent`;
  the three codecs differ only in the events they feed it.
- `api/background.ts` `backgroundLifecycle`: one shape over two wires, and
  the poll is `Effect.repeat` with `Schedule.spaced` and `until`, not a
  hand-written loop (`:603-606`).
- `api/verdict.ts` with `api/failureReply.ts`: the one reading of a vendor
  reply; callers read `ModelError` fields only.
- `models/modelRoute.ts` `decideModelRoute`: pure, one precedence order,
  the endpoint named by the decision.
- `providers/providerPlugins.ts`: the compile-time check that every llm-zoo
  provider is decided, and `RESPONSES_ROUTES` keyed by it.
- `api/uploadCache.ts`: one cache for two Files APIs, release under one
  deadline with every unconfirmed delete logged.

## Considered and left alone

- The three history-lowering walks: the open note
  `2026-11-14-llm-history-lowering-and-reply-document-recovery.md` chooses
  to leave them.
- `forcedToolChoice` (`configuration.ts:223-235`), a per-protocol switch
  beside the Responses column: moving it into the rows adds a column to two
  protocols and deletes nothing. `supportsForcedToolChoice` as a constant
  per `vendorRoute` call is `D-model-call.md`'s recorded nit.
- `AssemblyOptions.allowMissingResponseId`: checked and left in lens 2
  (`2026-11-08-design-red-flags-lenses-2/README.md`, "callers vary").
- The `*_CUSTOM_HEADERS` guards (`openaiResponsesRequest.ts:239-250`,
  `anthropicMessages.ts:582`): recorded in lens 2.
- The two `startsWith('gpt')` tests, `fastTier`, `serverState`,
  `webSocket` and `background` on `BindSpec.options`, and the harness's
  `backgroundOn`: `2026-11-03-fewer-processing-options.md` sections 1-2 and
  its Rejected list (kept on the owner's word or waiting on an llm-zoo
  capability).
- Google's three "background needs `store`" checks
  (`googleInteractions.ts:575-583`, `:686-691`, `turnInput.ts:49-53`):
  settled by D3 (round 2, "Already settled").
- `completedTurn` and the two other "no completed result" checks: refused,
  `LLM-one-no-completed-turn` in `refuted-candidates.json`.
- `api/openaiResponsesWebSocket.ts` onto `Socket.fromWebSocket`: row 18 of
  `.agents/docs/proposed/architecture/2026-11-14-nothing-held-across-a-wait.md`.
- `pullStream`, `rejoin`, `readerAbortSignal`, `ownedAbortSafeRequest`
  (`api/transport.ts`): they exist for the rejoin-before-complete rule a
  plain `Stream.fromReadableStream` does not state; round 2 lists them as
  good modules. Not re-checked against the v4 sources in this pass.
- `apiKeyEnvName`'s `plan-key` column for one row
  (`providers/providers.ts:24-29`): `'kimiCode'.toUpperCase()` gives
  `KIMICODE_API_KEY`, not the released `KIMI_CODE_API_KEY`, so it is not
  derivable; the manifest shape is O9's.

## Summary

| Id   | Title                                                                                                        | Package        | Flags                                                                       | Size                 | Owner decision?                                   |
| ---- | ------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| LM-1 | The ChatGPT plan named twice on one bind (`route.plan` and `credential.kind`); WebSocket rule split over both | llm, harness   | repetition, option for a special case, false comment, special-general mixed | ~90 lines, 7 files   | yes: `ModelCredential` / `BindSpec` are published |
| LM-2 | `allowedReasoningEfforts` is one value in all three producers; Google `'high'` fallback (remainder of O2)    | llm            | constant column, repetition                                                 | ~35 lines, 5 files   | no                                                |
| LM-3 | Upload cache and message threads decided in protocol modules, not the configuration rows (remainder of O6)   | llm            | information leakage, repetition, false comment                              | ~25 lines, 5 files   | no                                                |
| LM-4 | `configurationFor` and the Google constructor throw; `constructed` adapter; empty-key check in three places  | llm            | single-purpose adapter, repetition, non-obvious code                        | ~40 lines, 4 files   | no                                                |
| LM-5 | Batched: `ConfigurationOf` twice and three aliases, Stainless failure reader twice, `PROTOCOL_OF`, stale comment | llm        | repetition, false comment, pass-through variable                            | ~60 lines, 9 files   | no                                                |
