# LM: `packages/llm/src` design red-flag audit, 2026-11-15

Commit: `d70ad92` (read at `f88c2cfa3f`, which changes no file under
`packages/llm`). Area auditor, prefix LM.

## Numbers

55 files, 12,094 lines.

| Directory                         | Files | Lines |
| --------------------------------- | ----: | ----: |
| `src/` (entries and the contract) |     6 | 1,811 |
| `src/api/`                        |    24 | 6,551 |
| `src/oauth/` (top level)          |    13 | 1,569 |
| `src/oauth/chatgpt/`              |     1 |   380 |
| `src/oauth/xai/`                  |     3 |   441 |
| `src/models/`                     |     4 |   842 |
| `src/providers/`                  |     4 |   500 |

Five largest: `api/googleInteractions.ts` 776, `api/anthropicMessages.ts` 692,
`turn.ts` 526, `message.ts` 451, `api/openaiResponsesCodec.ts` 449.

Open PR touching the area: #14953 (`claude/optimistic-cori-q0n270`):
`Schema.NonEmptyString` for `String.check(isMinLength(1))`, `Num.sumAll`,
`Order.String`. It changes no structure this report names; where it touches
a cited file, the finding says what it leaves.

The area is in good shape after rounds 2 to 7: the route, reasoning, upload
and verdict owners landed and hold. What is left is mostly a second
statement of a fact the first owner already decides (LM-1, LM-2), the
public surface of the sign-in (LM-3), and per-codec copies of codec-neutral
rules (LM-4).

## LM-1: "This binding is on the ChatGPT plan" is said by the route and again by the credential's kind, and the files endpoint follows the credential

- flags: information leakage, conjoined methods, comment restates code (a false contract)
- package: llm (touches harness `agent/runtime/modelAccess/binding.ts`, the harness example)
- kind: refactor
- size: S
- earlier: remainder of `2026-11-03-fewer-processing-options.md` §2 ("The ChatGPT route is named two ways, `route.kind === 'chatgpt-subscription'` and `credential.kind === 'chatgpt'`"). Its "Landed 2026-11-04" paragraph made `requestDialect` the one discriminator inside the configuration, and O9 9d (#14876) gave the route one `plan`; neither touched `ModelCredential.kind`, which still restates the route.
- open PR: none (#14953 touches no line here)

**Evidence.** `BindSpec` carries both `route: CredentialRoute` and
`credential: ModelCredential` (`packages/llm/src/node.ts:61-65`). The credential
is `{ kind: 'api-key', apiKey } | { kind: 'chatgpt', accessToken }`
(`node.ts:51-53`), but the two cases hold the same thing, a
`string | SessionToken`; `bearerOf` exists only to undo the split
(`api/openaiResponsesRequest.ts:206-207`: `credential.kind === 'api-key' ?
credential.apiKey : credential.accessToken`). The plan is then read off the
credential's kind in three places, and off the route in the others:

- `api/responsesConfiguration.ts:84` `if (credential.kind === 'chatgpt')`
  picks the Codex request rules (model id, `requestDialect: 'chatgpt'`, no
  store, no files);
- `node.ts:195-197` `spec.credential.kind === 'api-key' && servesWebSocket(...)`
  keeps the plan off the socket;
- `api/openaiResponses.ts:85-86` `transport.authentication.kind === 'api-key'`
  decides whether the model gets an upload cache and `uploadFile`;
- billing reads `route.plan` (`node.ts:205`), the credential scope reads
  `route.plan` (`api/configuration.ts:182-185`).

The one production caller derives the credential's kind from the route it
passes beside it: `packages/harness/src/agent/runtime/modelAccess/binding.ts:181`
`const chatgpt = credential.route === 'chatgpt-subscription'` and `:192-194`
`credential: chatgpt ? { kind: 'chatgpt', accessToken } : { kind: 'api-key', apiKey }`.
Nothing checks the two agree: a `chatgpt-subscription` route with an
`api-key` credential binds as an OpenAI API request (store on, files on, the
dated model id) to the plan's endpoint and bills as the plan.

The upload decision is also wrong against its own contract. `Model.uploadFile`
is "Present only where the binding serves a files endpoint" (`turn.ts:482-489`),
but every `compatible` vendor route (DeepSeek, Kimi, GLM, DashScope, MiniMax)
binds with an `api-key` credential, so it gets an upload cache and
`uploadFile` (`openaiResponses.ts:85-120`, `:364`) although its configuration
says `supportsDocumentInput: false` (`responsesConfiguration.ts:53`) and no
document ever reaches it (`documentAccess` reads `supportsDocumentInput`,
`api/openaiResponsesLower.ts:28-38`; the harness offers uploads only for
delivered documents, `packages/harness/src/agent/runtime/loop/toolUseDispatch.ts:895-899`).
No request fails today only because of that far-away harness filter.

Consumers: `ModelCredential` kinds are written at `binding.ts:192-194`,
`packages/harness/example/01-llm-turn.ts:92,129`, and
`packages/llm/test/api/OpenaiResponses.vitest.ts:130`; read at the four
llm sites above.

**The design decision behind it.** Which plan's request rules a binding
follows is a fact of the decided route. The credential is only the bearer.

**The better design.** `BindSpec.credential` is the bearer,
`string | SessionToken` (rename the field `bearer`). `responsesConfiguration`
reads `spec.route.plan === 'chatgpt-subscription'`; `bindModel`'s socket test
reads `configuration.requestDialect !== 'chatgpt'` (the configuration already
holds it); the upload cache is built when `config.supportsDocumentInput`, so
`uploadFile` exists exactly where a document can be sent. Deleted: the
`ModelCredential` union and its name, `bearerOf` (2 callers), the harness's
`chatgpt` ternary; `bearer()` in `node.ts:122-130` keeps its "only a fixed
key" check on `typeof credential === 'string'`. Callers write
`credential: credential.bearer`.

**What we give up, and risk.** A public type changes (0.x, `config/api-reports/llm.api.md`
regenerates). An embedder that bound the ChatGPT plan with a hand-written
route must now name the plan in the route, which it already had to.

**How I tried to refute it.** Looked for a caller that passes a `chatgpt`
credential on a non-plan route or the reverse (none: one production caller);
for a reason the socket test reads the credential rather than the
configuration (`servesWebSocket` already reads `onOpenAiEndpoint`, which is
true for `requestDialect: 'chatgpt'`, so the credential test is the only thing
keeping the plan off the socket, and the dialect says the same); for a vendor
route with a files endpoint the cache serves (none: every `vendorRoute`
sets `supportsDocumentInput: false`).

## LM-2: "A plan route costs nothing" has two owners that disagree on two of the four plans

- flags: information leakage (one fact, two owners), repetition, non-obvious code
- package: llm (touches harness `agent/runtime/run/pricing.ts`)
- kind: bug
- size: S
- earlier: none (`zeroCostAccessOverrides`, `PLAN_RATES`, `costAt` appear in no evidence, proposal or refusal)
- open PR: none

**Evidence.** Two modules decide that a subscription pays for a request.

1. `routeConfig` (`packages/llm/src/models/modelRoute.ts:314-352`) zeroes the
   config's prices, long-context pricing and tiers
   (`zeroCostAccessOverrides`, `:200-214`) for a `session` route (ChatGPT,
   Grok) and for a dual-backend Kimi model on Kimi Code (`:336-347`), but
   returns the config unchanged for the other `api-key` plan routes: the GLM
   Coding Plan (`plan: 'glm-coding-plan-subscription'`, `:280-289`) and a
   Kimi Code exclusive model (`:337`, `isKimiCodeExclusiveModel(config)`
   returns `config`).
2. `turnCost` (`models/turnCost.ts:89-99`) zeroes again on
   `billing.plan`, which the harness sets for every plan
   (`packages/harness/src/agent/runtime/run/pricing.ts:38-41`,
   `plan: usageRoute !== 'api-key'`). Its doc names all four plans
   (`turnCost.ts:79-88`: "ChatGPT/Codex, Grok, the GLM coding plan, Kimi
   Code ... every rate is zero"). It computes the zero the long way:
   `costAt(model, usage, PLAN_RATES)` with `PLAN_RATES = { inputPrice: 0,
   outputPrice: 0, cacheDiscountFactor: 1 }` (`:118-122`) runs the Anthropic
   or standard accounting (`:125-158`) over all-zero rates, which is `0` by
   arithmetic on every branch.

The two disagree where the user sees it. The model picker prices a row
from the routed config (`packages/harness/src/model/computeModelOptions.ts:184`
`config: routeConfig(rawConfig, route)`, rendered at
`packages/texra/src/model/modelOptions.ts:94` `cost: formatCost(config.inputPrice, config.outputPrice)`
and `ModelSelectionList.ts:251`): a ChatGPT-plan row reads `$0/$0`, a GLM
Coding Plan row reads the per-token price, and the turns it runs bill `0`.
The same fact also gates a request field by accident: erasing `tiers` on a
plan route is what turns the fast service tier off there
(`api/responsesConfiguration.ts:135` `options.fastTier && config.tiers?.fast`),
a decision nobody wrote down.

**The design decision behind it.** Whether a route bills per token is a
fact of the decided route (`route.plan`), and it is decided once.

**The better design.** `routeConfig` applies the zero-price overrides for
every route with a plan (`route.kind === 'session' || route.plan !== null`),
keeping the window rules it has (ChatGPT's granted window, Kimi Code's tier
cap and wire id). `turnCost` keeps its `plan` input only for what the
config cannot say, that an xAI receipt's own cost does not apply, and
returns `0` for a plan in one line. Deleted: `PLAN_RATES` and the
`costAt(..., PLAN_RATES)` call (1 site); the doc's list of plans becomes the
rule. If the fast tier is meant to be off on a plan, `firstPartyResponses`
says so beside its other plan rules instead of relying on erased prices.

**What we give up, and risk.** A GLM Coding Plan row in the picker stops
showing list prices; if the owner wants plan rows to show what an API key
would cost, the opposite fix applies (no route zeroes the config, and the
picker reads the published config, as its tooltip already does,
`modelOptions.ts:95-97`). Either way one rule.

**How I tried to refute it.** Checked whether the GLM plan is billed per
token on purpose (no: `turnCost`'s doc and `pricing.ts:19-20` "A plan route
bills nothing" both cover it); whether the routed config's prices are read
anywhere but the picker and `turnCost` (grep `.inputPrice`/`.outputPrice`
in `packages/*/src`: only the picker rows and hints); whether
`costAt(PLAN_RATES)` can be non-zero (every term multiplies a zero rate; the
`Math.max(0, ...)` floor keeps it at 0). I could not read llm-zoo's data (no
`node_modules` in this checkout), so whether Kimi Code exclusive entries
already carry zero prices is unverified; the GLM case does not depend on it.

## LM-3: The subscription account hands its sign-in steps to every caller, and the app passes the account back into llm's own login functions

- flags: overexposure, pass-through, temporal decomposition
- package: llm (touches texra `controllers/modelAccess/subscriptionProviders.ts`)
- kind: refactor
- size: M
- earlier: O3 / V-R3 (#14829) replaced the per-provider port and its `WeakMap` with the `SubscriptionAccounts` service and deleted the status pass-throughs; the interface each account is typed by (`SubscriptionCoordinator`) kept its sign-in internals. Not the refused `LLM-subscription-credential-facade` (a credential call over the accounts; this finding adds no call and moves the login flows onto the account). Not G11f (the descriptor columns stay).
- open PR: none

**Evidence.** Each entry of `SubscriptionAccounts`
(`packages/llm/src/oauth/subscriptionAccounts.ts:23-45`) is a
`SubscriptionCoordinator<S>` (`oauth/subscriptionCoordinator.ts:71-112`),
eight methods. Outside llm only four are called: `getStatus`
(`packages/harness/src/model/modelSettings.ts:175`,
`packages/texra/src/controllers/modelAccess/subscriptionProviders.ts:313`),
`getFreshSession` and `refreshRejected`
(`packages/harness/src/agent/runtime/modelAccess/credentials.ts:91-102`), and
`signOut` (`subscriptionProviders.ts:300`). The other four, `loadSession`,
`buildAuthorizeRequest`, `loginWithCode` and `storeTokens`, have no production
caller outside llm (grep over `packages/{harness,texra,cli,desktop,extension}/src`:
0, 0, 0, 0); they are the steps of llm's own sign-in flows, which must call
them in order: `buildAuthorizeRequest(port)`, wait for the loopback callback,
then `loginWithCode(request, callback)` (`oauth/loopbackLogin.ts:224`, `:300`),
or poll and then `storeTokens(tokens)` (`oauth/xai/xaiDeviceLogin.ts:63`).

The app closes the loop: it reads the account out of the service and passes
it straight back into llm's exported flows as `coordinator`
(`subscriptionProviders.ts:203-210` reads `accounts[route]`; `:217-229` and
`:243-248` pass it to `loginWithDeviceCode({ coordinator, ... })` and
`loginWithLoopback({ coordinator, ... })`), bound per provider at
`:336` and `:350-351` (`chatgptLoginWithLoopback`, `xaiLoginWithDeviceCode`,
`xaiLoginWithLoopback`), with a comment that the bindings call through only so
a host suite can swap the module (`:322-325`). To carry that hand-off, the
`./node` entry exports `LoopbackLoginOptions`, `DeviceLoginOptions` (whose
only field beyond the prompt is that `coordinator: Pick<..., 'storeTokens'>`,
`oauth/deviceAuthorization.ts:34-41`), `SubscriptionAuthorizeRequest`,
`SubscriptionCallback`, `SubscriptionTokenResponse` and `SubscriptionSession`
(`node.ts:222-235`); production consumers outside llm: 0 for all six
(tests: `SubscriptionAuthorizeRequest` 1, `SubscriptionTokenResponse` 1).
Whether a provider has a device-code sign-in is also decided twice: by
which login functions llm exports, and by the app's optional
`loginWithDeviceCode` column (`subscriptionProviders.ts:181-185`, `:212-216`).

**The design decision behind it.** Who runs a provider's sign-in protocol:
the account that owns the session it stores. The caller supplies only the
presentation (open a browser, show a code).

**The better design.** Each account carries its sign-in as methods:
`signInWithBrowser(openBrowser)` on both, `signInWithDeviceCode(onPrompt)` on
the xAI account alone (its type says so). The coordinator's protocol steps
become private members of `SubscriptionOAuthCoordinator`, and
`SubscriptionCoordinator` shrinks to status, fresh session, rejected token,
sign-out and the two sign-ins. The app's `signIn` reads
`account.signInWithDeviceCode` instead of its own column. Deleted: the three
exported login functions and `defineLoopbackLogin`'s public use, six exported
types, the `coordinator` option on both option types, the app's
`loginWithLoopback` / `loginWithDeviceCode` binding columns and their
call-through comment (about 40 lines in the app, 30 in llm exports and docs).

**What we give up, and risk.** A test that swaps `@texra-ai/llm/node` to
intercept a login must provide a fake account instead (the
`SubscriptionAccounts` layer is already the seam the app's tests use). The
public API changes (0.x).

**How I tried to refute it.** Looked for an outside caller of the four
protocol steps (none); for an embedder need in the harness example
(`packages/harness/example/` uses no sign-in); for a host that drives
`buildAuthorizeRequest` itself to show its own consent page (none: every host
goes through the app's `signIn`); checked the refusal record's reason (the
facade "hides nothing" because the coordinators keep consumers in two
packages; here the consumers keep exactly the methods they call).

## LM-4: The rules around a codec's lowering (a model switch's replay, a stored continuation) are written per codec, and Google's copy differs

- flags: repetition, special-general mixed, comment restates code (a false comment), overexposure (an unread parameter)
- package: llm
- kind: refactor (it also fixes a behavior difference: a cross-protocol thought is dropped by Google and refused by the other two codecs)
- size: M
- earlier: none for these symbols (`replayableHistory`, `googleContinuation`, `withResponsesContinuation` appear in no evidence; `LLM-one-no-completed-turn-check` refused the codec _layout_ move and the completed-turn check, not these rules)
- open PR: #14953 replaces `loweredItemCount` with `coveredItemCount` (`Num.sumAll`) in `openaiResponsesLower.ts`; it leaves everything below.

**Evidence.**

1. _A model switch's replay._ `replayableHistory`
   (`packages/llm/src/message.ts:352-407`) is documented as "The history every
   codec lowers for a turn bound to `turn`": same-protocol content another
   model wrote loses its reasoning and evidence, and another protocol's
   evidence "passes through for the codec to refuse". Anthropic
   (`api/anthropicMessages.ts:165`) and Responses
   (`api/openaiResponsesLower.ts:73`) call it. Google does not
   (`api/googleInteractions.ts:102-212`); it writes its own rule inline,
   `case 'reasoning': // Omit another model's thoughts, as the Anthropic and
   Chat codecs do. if (!sameModelOrigin(message.origin, origin)) break;`
   (`:168-170`). The comment is false twice: there is no Chat codec, and
   Anthropic does not omit another protocol's thoughts, it refuses them (its
   reasoning branch requires `sameModelOrigin`, `anthropicMessages.ts:220-222`,
   and anything else falls to "Anthropic cannot replay foreign content
   evidence", `:246-250`; Responses refuses reasoning without its own
   evidence, `openaiResponsesLower.ts:163-169`). So a turn carrying an
   Anthropic thinking signature is refused by Responses and Anthropic and
   silently stripped by Google, while Google refuses the same turn's foreign
   message evidence (`googleInteractions.ts:152-160`). Today the harness
   refuses a foreign-protocol resume before any codec sees it
   (`packages/harness/src/agent/runtime/loop/runProgram.ts:46-67`), so the
   difference reaches an embedder only.
2. _A stored continuation._ Each chaining protocol builds its anchor and
   checks an incoming one by hand: Responses in `withResponsesContinuation`
   (`openaiResponsesLower.ts:239-283`) and `responseInput` (`:286-334`),
   Google in `googleContinuation` (`googleInteractions.ts:524-551`) and
   `invocationInput` (`:252-280`). The shared part (prefix = messages plus
   the new assistant entry; `prefixFingerprint` under a protocol domain;
   `coveredMessages`; the incoming check of origin, length, fingerprint and a
   covered count) is written twice with different covered counts and
   different self-checks: Responses counts items without lowering, "so the
   bytes it covers are never materialized again" (`openaiResponsesLower.ts:40-55`),
   while Google lowers the covered prefix to count its steps, on every
   prepare and stream (`invocationInput` lowers the whole history, then the
   prefix again, `:256-263`, and `prepareTurn` and `streamTurn` each call it,
   `:597-606`) and once more at completion (`:535`), re-parsing every past
   call's arguments each time (`parseOutboundToolArguments`, `:199`).
   Responses re-decodes the continuation it just built
   (`Schema.decodeUnknownSync(ContinuationSchema)`, `:267`); Google re-decodes
   the whole result (`Schema.decodeUnknownSync(TurnResultSchema)`, `:687-691`).
   `withResponsesContinuation` takes a `config` it never reads
   (`:242`; its three callers pass it, `openaiResponses.ts:164`, `:357`,
   `openaiResponsesWebSocket.ts:277`), and its doc still says "The
   configuration was parsed at bind" (`:236-237`).
3. _Paired calls._ Every codec builds `answeredCalls(history)` and then
   asks `callsAnsweredBy(answered, message)` per tool message
   (`message.ts:310-350`; `anthropicMessages.ts:166`, `:189`;
   `googleInteractions.ts:108`, `:125`; `openaiResponsesLower.ts:75`, `:301`,
   `:329`). The map is keyed by message object identity, which works only
   because `replayableHistory` returns tool messages unchanged (`message.ts:306-307`
   says so), a far-away fact each caller relies on.

**The design decision behind it.** What history a codec may lower for a
bound turn, and whether a stored anchor still covers it, are protocol-neutral
rules over the canonical history; only the covered count and the request
field are a protocol's.

**The better design.** `replayableHistory` returns the lowering-ready
history: each tool entry carries its answered calls (`{ role: 'tool',
answered: AnsweredCall[] }`), so `answeredCalls`, `callsAnsweredBy` and the
identity keying go, and Google calls it like the others (its inline origin
test and false comment go; a foreign thought is refused everywhere). One
`api/continuation.ts` owns the anchor: `anchorAfter(domain, turn, result,
count)` and `uncoveredSuffix(domain, turn, count)` (the suffix to lower, or
the `invalid-request`), each protocol passing its domain, its count and its
own extra rule (Google: no assistant in the suffix; Responses: chain only
after `stop` or `tool-calls`). Google lowers prefix and suffix once each and
counts the prefix's steps from that one pass. Deleted: `answeredCalls`,
`callsAnsweredBy` (3 callers each), the unread `config` parameter, one of the
two hand-written checks, and the two different self-decodes (code we control
builds the value).

**What we give up, and risk.** An embedder that relied on Google dropping a
foreign thought gets a refusal, as on the other protocols. The count each
protocol passes must still match its lowering; the Responses
`coveredItems` check stays the loud guard for that.

**How I tried to refute it.** Checked whether Google's inline rule is
equivalent to `replayableHistory` for same-protocol switches (it is: Google
writes no message or call evidence, so only the thoughts differ, and both
drop them), so the difference is the cross-protocol case alone; whether the
double lowering is needed for Google's step merge (no: an anchor whose last
covered step is `user_input` is never written, `googleInteractions.ts:536-537`,
so prefix and suffix lowerings concatenate exactly); whether `config` is read
through a closure (no).

## LM-5: Constant fields on the turn contract, two of them stored on every turn row

- flags: overexposure (a column that is constant), comment restates code
- package: llm (touches harness `shared/schemas/storedTurn.ts`, the row version of `model.message`, and the CLI's validation model)
- kind: refactor
- size: S
- earlier: O5 (#14785) removed `ResolvedTurn.transport`; its leftover in the CLI is item 4 below. The constants themselves are in no earlier report.
- open PR: none

**Evidence.**

1. `TurnResult.kind: Schema.Literal('http')` (`packages/llm/src/turn.ts:311`).
   One value, written by the one assembly (`api/assembleTurn.ts:276`) and the
   CLI's scripted model (`packages/cli/src/runtime/models/validationModel.ts:539`);
   no reader branches on it (grep `kind === 'http'` / `.kind` on a turn
   result in `packages/*/src`: none). It is stored on every turn
   (`packages/harness/src/shared/schemas/storedTurn.ts:118`).
2. `TurnResult.modelFingerprint: Schema.NullOr(Schema.String)`
   (`turn.ts:315`). Every producer writes `null` (`assembleTurn.ts:280`,
   `validationModel.ts:543`); nothing reads it (grep `modelFingerprint` in
   `packages/*/src`: the two schemas and the two writers). Stored at
   `storedTurn.ts:122`.
3. `ResponsesContinuation.anchor.kind: Schema.Literal('stored')`
   (`message.ts:436-442`), with a comment about a connection-scoped anchor
   that no schema, producer or reader has; written once
   (`api/openaiResponsesLower.ts:277`), never read.
4. The CLI's scripted model still prepares turns with the `transport: { kind:
   'http' }` that O5 removed from `ResolvedTurn`
   (`validationModel.ts:564`); it compiles only because `Effect.succeed`
   infers the literal's type before the assignment, so the excess property
   is never checked.

**The design decision behind it.** None: each is a slot for a variant that
does not exist.

**The better design.** Delete the three fields and the CLI's stray
`transport`. `StoredTurnSchema` drops `kind` and `modelFingerprint`; a stored
row from an earlier build still decodes (a struct ignores the undeclared
keys), and a row this build writes lacks two fields an earlier build
requires, so `model.message` takes a version bump under the storage rules.
The continuation anchor is evidence bytes the store does not interpret, so
dropping `anchor.kind` needs no bump. The golden store regenerates.

**What we give up, and risk.** A row-version bump (Needs your eye). A
future transport or fingerprint would add its field back with its first
producer.

**How I tried to refute it.** Searched every package for a reader of each
field and for a second producer value (none); checked that the harness's
evidence mapping does not key on `anchor.kind` (`providerMessages.ts:84-90`
keys on `continuation` and stores it whole).

## LM-6: Refused words and false comments in the turn assembly, the Responses request and the OAuth coordinator

- flags: vague name, comment restates code (false comments)
- package: llm
- kind: docs (two strings are user-visible error text)
- size: S
- earlier: none for these sites (the lens catalogue's naming rows covered the harness and app)
- open PR: #14953 rewrites the `loweredItemCount` doc ("one admitted message") in `openaiResponsesLower.ts:40-46`; it leaves every site below.

**Evidence.** Words the root guide's "Plain names" table refuses:

- `admit` (`packages/llm/src/api/assembleTurn.ts:96`, called four times at
  `:204-210`), the check that content follows an identity and precedes the
  finish: it is `requireOpen` / `checkOrder`.
- `settle` (`assembleTurn.ts:227`, span name `'llm.settleTurn'`, caller
  `:265`, referenced from `api/parts.ts:83`), which picks the finished
  content from the streamed items and the snapshot: `finishedContent`.
- `type Folded` (`assembleTurn.ts:53`, ten uses): the events one part emits,
  `StepEvents`.
- "before admission" and "the admitted binding" in the Responses request
  docs (`api/openaiResponsesRequest.ts:21`, `:54`); "admits background work"
  (`turn.ts:205`); "the API admits it" (`api/anthropicMessages.ts:169`).
- Two error messages a user can read: "Continuation requires the original
  admitted input and matching completed output." and "Continuation does not
  cover the exact admitted prefix." (`api/openaiResponsesLower.ts:250`, `:319`).

False or stale comments:

- `SubscriptionOAuthCoordinator` is "Pure state machine over injected secret
  storage" (`oauth/SubscriptionOAuthCoordinator.ts:4`); every method reads or
  writes the secret store and most call the network.
- `grantFailure` keeps "the same message, kind and status the grant's Promise
  API always threw" (`:47-48`); there is no Promise API, and the reason the
  mapping exists (a token-grant error becomes the coordinator's one error
  type) is unsaid.
- `completedTurn`'s span is named `'llm.generateTurn'` (`turn.ts:512`), a
  function that no longer exists, so a trace names neither.
- The Google codec's "as the Anthropic and Chat codecs do" (`googleInteractions.ts:169`)
  is LM-4's.

**The better design.** Rename the three assembly symbols and the span; reword
the docs and the two messages ("the exact prefix the request sent"); state
the coordinator as "the one lock around a provider's stored session"; give
`grantFailure` its reason. No behavior change.

**What we give up, and risk.** Nothing; a test that matches the two message
strings changes with them (grep found none in `packages/llm/test`).

**How I tried to refute it.** Checked that none of the names is a persisted
or wire string (they are local functions, a type and log text); checked that
the coordinator has no pure core the comment could mean (its only pure step,
`isExpiringSoon`, is two lines).

## LM-7: The package README and the model-layer guide describe members and options that were deleted

- flags: comment restates code (false documentation)
- package: llm (touches `docs/api/model-layer.md`)
- kind: docs
- size: S
- earlier: the deletions themselves landed (TC6 #14813 moved upload release to the scope; `2026-11-03-fewer-processing-options.md` §2 "Landed 2026-11-04" deleted `ChooseReasoningOptions.strict`; O3 / V-R3 #14829 made the accounts one service). The docs were not updated with them.
- open PR: #14953 regenerates `packages/llm/docs/api/index.md` only.

**Evidence.**

- `packages/llm/README.md:171-174`: "Three optional members ... `uploadFile`
  / `releaseUploads`". `Model` has two optional members, `uploadFile` and
  `background` (`src/turn.ts:477-509`); `releaseUploads` exists nowhere in
  `packages/*/src` (the binding's `Scope` releases uploads,
  `api/uploadCache.ts:183-241`).
- `README.md:118`: "`ReasoningChoiceError` from a strict `chooseReasoning`".
  There is no strict mode; `chooseReasoning` always returns
  `Result<ReasoningChoice, ReasoningChoiceError>` (`models/reasoningChoice.ts:170-174`).
- `README.md:133` and `docs/api/model-layer.md:17`: the `./node` entry holds
  "their `SubscriptionCoordinator`s" (the guide also names a `codex` module).
  Every caller reaches an account through the `SubscriptionAccounts` service
  (`src/node.ts:244`), which neither document names; `SubscriptionCoordinator`
  survives only as the type of the service's entries (`node.ts:231`), and the
  provider modules are `oauth/chatgpt/` and `oauth/xai/`.
- `README.md:247-249` and `docs/api/model-layer.md:10`: no protocol
  "silently discards reasoning ... it cannot represent". The Google codec
  drops another protocol's thoughts without an error
  (`api/googleInteractions.ts:168-170`, LM-4).
- `README.md:117`: "`SecretsFailed` ... Its `reason` is `store-unavailable`
  or `io`", and the class's own doc, "Callers match on `reason` rather than
  on a message" (`providers/credentials.ts:22-27`). `reason` went in #14776
  (round-2 O report, "Already settled"); the class carries `operation`, which
  no caller reads (grep `.operation` on a `SecretsFailed` in `packages/*/src`:
  only the harness's own message wording, `fileSecrets.ts:58`), and whose
  literal set names a member llm's `CredentialStore` does not have
  (`'listStoredKeys'`, `credentials.ts:13-18`, a method of the harness's
  `Secrets` port, `packages/harness/src/platform/secrets.ts:40`).
- The tree table (`README.md:196-222`) calls `api/prefixFingerprint.ts` "the
  accepted-history fingerprint a background completion anchors on" (every
  stored continuation, foreground included, uses it:
  `api/openaiResponsesLower.ts:269-274`, `api/googleInteractions.ts:542-547`),
  calls `api/openaiError.ts` "SDK error classification into `ModelError`"
  (the classification is `sdkModelError` in `errors.ts:252-276`; the file only
  extracts OpenAI's HTTP facts), and omits seven modules a reader needs to
  find the contract's parts: `api/background.ts`, `api/turnInput.ts`,
  `api/anthropicThreads.ts`, `api/failureReply.ts` and the three `*Wire.ts`
  schema files.

**The better design.** Correct the six statements (and the `SecretsFailed`
class doc, whose `operation` either gets a reader or goes); let the tree table list
directories with their owners rather than files, so a moved file does not
make it false again (the generated `docs/api/` pages already list every
export).

**What we give up, and risk.** Nothing.

**How I tried to refute it.** Grepped for `releaseUploads` and a `strict`
option (none); checked the `./node` exports for `SubscriptionCoordinator`
(a type export remains, so that bullet is an omission of the service, not a
missing name); read the Google codec's reasoning branch against the README's
promise.

## LM-8: Small instances, batched: a binder that throws and catches its own errors, a verdict rule that restates the error's default, and three hand-written helpers

- flags: non-obvious code, repetition, shallow module, overexposure
- package: llm
- kind: refactor
- size: S
- earlier: P8 d (#14873) made `chooseReasoning` return a `Result` instead of throwing; (a) is the same shape left in `configurationFor`. (b) is a remainder of `2026-11-03-storage-errors-and-stop-paths.md` §4 ("Is this retryable" lists `notRetryable`), whose "Done 2026-11-06" paragraph did not reach it. (d) is not the cross-package merge that note kept ("llm's own `causeChain` and `toErrorMessage`" stay); it only folds llm's own copies into one place inside llm.
- open PR: #14953 touches `prefixFingerprint.ts` (`Order.String` for the key comparison); (c) still stands after it.

**Evidence and the better design, per instance.**

a. _The binder throws and catches its own typed errors._ `configurationFor`
(`packages/llm/src/api/configuration.ts:141-220`) is a pure function that
`throw`s a `ModelError` (`:149-154`) and turns `chooseReasoning`'s
`Result` back into a throw (`Result.getOrThrowWith`, `:157-162`);
`bindModel` catches both through `constructed` (`node.ts:107-119`, `:190`),
whose second user is `googleInteractionsModel`, the one protocol
constructor that is synchronous and throws a `TypeError` for an empty key
(`api/googleInteractions.ts:555-561`) where Anthropic's returns the same
refusal as a `ModelError` (`api/anthropicMessages.ts:575-580`). Better:
`configurationFor` returns `Result<..., ModelError>`, Google's
constructor is an `Effect` like the other two, and `constructed` (2
callers) goes. `node.ts:157` also aliases `const authentication =
   credential;` for no reason.
b. _A verdict rule that restates the constructor's default._ `judgeFailure`
sets `retryable` from `notRetryable(reply, overflow)` (`api/verdict.ts:270-275`,
`:357-360`), which returns `false` for an overflow or a non-retryable
status and `undefined` otherwise, so the `ModelError` constructor then
applies `retryableByDefault(kind, status)` (`errors.ts:133-148`,
`:168`). For every kind a reply can carry a status on, that default
already says `false` for a non-retryable status (`provider-rejection`
reads `isRetryableStatus`; the other kinds are `false`; `transport`
failures carry no status in any producer, grep `kind: 'transport'`).
So the status half of `notRetryable` repeats the constructor. Better:
`retryable: quota !== undefined || overflow || !error.retryable ? false : undefined`;
`notRetryable` and its doc go.
c. _Two sorted-key JSON serializers._ `canonical` (`api/failureReply.ts:95-103`)
and the replacer in `prefixFingerprint` (`api/prefixFingerprint.ts:18-28`)
each write key-sorted JSON by hand. Better: one `sortedJson` in
`prefixFingerprint.ts` that `failureReply` imports. The fingerprint's
bytes must not change (stored continuations compare them), so the shared
function is the fingerprint's current replacer.
d. _A one-function file and its inline copies._ `oauth/support.ts` holds
`toErrorMessage` alone (4 callers, one of them `node.ts`, outside
`oauth/`); `oauth/loopbackLogin.ts:197` and `errors.ts:270` inline the same
expression. Better: move it into `errors.ts`, where `sdkModelError`
already needs it, and delete the file.
e. _An over-wide helper signature._ `authOrRejectionKind(...statuses:
   ReadonlyArray<number | string | undefined>)` (`errors.ts:202-214`) explains
in its doc why a string never matches; its three callers pass one
`number | undefined` (`errors.ts:267`, `api/openaiResponsesWebSocket.ts:162`,
`:266`). Better: `(status: number | undefined)`, and the doc's string
clause goes.
f. _A public method that only forwards._ `getFreshSession()` returns
`this.freshSession()` (`oauth/SubscriptionOAuthCoordinator.ts:155-158`).
Better: name the private program `getFreshSession` and give it the
optional `rejected` parameter `refreshRejected` already passes.

**What we give up, and risk.** (c) must keep the fingerprint byte-identical;
the existing continuation suites check that.

**How I tried to refute it.** For (a), checked that no caller of
`configurationFor` other than `bindModel` exists (one); for (b), traced every
`ModelError` producer that sets `status` (all are HTTP rejections, never
`transport`) and the `retryable: undefined` override of the spread (it does
reach the constructor's default); for (d), checked browser-safety (both
`errors.ts` and `support.ts` import nothing Node-specific).

## Good modules in this area

- `api/assembleTurn.ts` (with `api/parts.ts`): one reducer every codec feeds
  part events into; identity, positions, deltas, call arguments, finish
  agreement and terminal validation live in one place behind
  `assembleTurn(batches, options)`. A small interface over much behavior.
- `api/uploadCache.ts`: the files cache's whole lifetime (digest keys, the
  in-flight claim, expiry margin, release under one deadline in the caller's
  scope) behind `fileIdFor` and `uploadFile`; each provider supplies only its
  SDK calls and expiry decoding.
- `api/transport.ts` `ownedAbortSafeRequest` / `rejoin` / `readerAbortSignal`:
  foreign promise cleanup written once, with the finalizer order stated.
- `models/modelRoute.ts` `decideModelRoute`: one pure decision over
  `RouteFacts`, read by the picker, the binding and the run (apart from
  LM-2's price half).
- `api/anthropicThreads.ts`: the thread cache, its recovery table and its
  degradation to whole requests behind one `send`.
- `providers/providerPlugins.ts`: the manifest with its `AssertNever` gate
  over llm-zoo's providers.

## Already settled, left alone

- The codec file layout and the three "no completed turn" checks: refused,
  `LLM-one-no-completed-turn-check` (`.agents/docs/refuted-candidates.json`).
- A credential facade over the subscription accounts: refused,
  `LLM-subscription-credential-facade`; LM-3 moves the login flows onto the
  account instead and adds no call.
- xAI token expiry read three ways: refused, `LLM-xai-token-expiry-one-reading`.
- `SubscriptionProvider.sessionName` / `.copyTarget`: refused, G11f (both read
  by the extension).
- llm's own `toErrorMessage` and `causeChain` beside the harness's: kept with
  reasons, `2026-11-03-storage-errors-and-stop-paths.md` §4 "Done 2026-11-06".
- The fast-tier option and the two `startsWith('gpt')` tests: kept on the
  owner's word, `2026-11-03-fewer-processing-options.md` §1 and §2.
- Per-provider reasoning rules in `routeControls` beside the Responses vendor
  rows: O2 landed (#14785) with `routeControls` as the owner; the rows'
  remaining `reasoning` fields are request shape (null versus an effort-only
  object), not a second decision.
- OpenAI's `parallel_tool_calls: true` against sequential prompting: held for
  the owner (I-C4).
- A plan's facts spread across `PLAN_ROUTES`, the route, `routeConfig` and the
  verdict's plan readers: not reported. A table row carrying each plan's
  quota reader would pull the verdict (loaded on demand, Node side) into the
  browser-safe entry that holds `PLAN_ROUTES`.
