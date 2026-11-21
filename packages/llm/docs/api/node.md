# `@texra-ai/llm/node`

<!-- Generated from `packages/llm/src/node.ts` by `npm run docgen`; do not edit. -->

Node.js entry of `@texra-ai/llm`: binding a catalog model to its wire
protocol (`bindModel`) and running subscription OAuth sign-in flows.

> **Guide:** Read [Model Layer (`@texra-ai/llm`)](/api/model-layer) for a
> complete `selectModel` $\to$ `bindModel` $\to$ `prepareTurn` $\to$
> `streamTurn` example.

### Key exports by role

- **Protocol binding**: [`bindModel`](#bindmodel), [`BindSpec`](#bindspec),
  [`Binding`](#binding) dynamically load only the requested protocol
  (`anthropic-messages`, `openai-responses`, `google-interactions`), manage
  scoped connections and file uploads in the caller's `Scope`, and classify
  provider failures into `ModelError`.
- **Subscription sign-in (`chatgpt`, `xai`)**: each subscription's
  account, keyed by its route
  ([`SubscriptionAccounts`](#subscriptionaccounts)), which runs its own
  browser and (Grok's) device-code sign-in.
- **Provider endpoints outside a turn**: how each plan states its quota
  ([`PLAN_QUOTA_SOURCES`](#plan_quota_sources)), read at its endpoint
  ([`fetchPlanUsage`](#fetchplanusage)) or off a reply's headers
  ([`replyPlanUsage`](#replyplanusage)), and
  [`transcribeAudio`](#transcribeaudio) a recording's text.

## Binding

A bound model and the facts its configuration fixed.

```ts
interface Binding {
  readonly model: Model;
  readonly origin: ModelOrigin;
  /**
   * The config the model runs and bills with on its route: its window, its
   * prices, and the media its route carries (`capabilities`).
   */
  readonly config: ModelConfig;
  /** The route the binding bills through. */
  readonly billing: BillingRoute;
  /** The output limit a turn takes unless it asks for less; null where the route takes none. */
  readonly maxOutputTokens: number | null;
  readonly serviceTier: 'fast' | null;
  /** The route takes a tool choice naming one function. */
  readonly forcedToolChoice: boolean;
}
```

## bindModel

Bind one model. The vendor rules and the failure verdicts load on demand,
like the protocol modules. The connection, and the files the model
uploads, live in the caller's scope: an upload the provider will not
confirm deleted is logged and left to its own expiry.

```ts
const bindModel: (spec: BindSpec) => Effect<Binding, ModelError, Scope>
```

## BindSpec

One model on one decided route, and what the caller asks of it. The
protocol is the model's provider's, and the route fixes the config it runs
(`routeConfig`), the endpoint it sends to, the credential scope stamped on
its origin and the plan it bills.

```ts
interface BindSpec {
  /** The llm-zoo entry, before its route's overrides. */
  readonly model: ModelConfig;
  readonly route: CredentialRoute;
  /**
   * The token the binding sends: an API key (or any bearer token the
   * endpoint takes as one), or a subscription plan's session token. Which
   * plan's request rules apply is the route's `plan`.
   */
  readonly bearer: string | SessionToken;
  /** The app the requests are sent for (a ChatGPT plan's tools sit in its namespace). */
  readonly client: ClientIdentity;
  /** Each option has a default; the booleans default to `false`. */
  readonly options?: {
    /** The output ceiling, before the model's own rules; the catalog's by default. */
    readonly maxOutputTokens?: number;
    /** The sampling temperature where the model takes one; the provider's own by default. */
    readonly temperature?: number;
    /** The model's default reasoning (`chooseReasoning`) unless given. */
    readonly reasoning?: ReasoningChoice;
    /** Google keeps the conversation server-side. */
    readonly serverState?: boolean;
    /** OpenAI's fast service tier, where the model offers it. */
    readonly fastTier?: boolean;
    /** The caller would serve Responses over its WebSocket. */
    readonly webSocket?: boolean;
    /** The caller gives up the WebSocket where the route takes background work. */
    readonly background?: boolean;
    /** The fetch every HTTP request goes through. */
    readonly fetch?: typeof fetch;
  };
}
```

## ChatgptSession

A stored ChatGPT session.

```ts
type ChatgptSession = typeof ChatgptSessionSchema.Type;
```

## ClientIdentity

The app llm signs in and sends for, as the providers name it. llm has no
default: the app supplies its own.

```ts
interface ClientIdentity {
  /** What OpenAI shows the person for the client a ChatGPT sign-in registers. */
  readonly name: string;
  /**
   * A lowercase token: xAI's sign-in referrer, and the namespace a ChatGPT
   * plan's function tools sit in.
   */
  readonly id: string;
}
```

## EndpointPlanRoute

A plan with a quota endpoint.

```ts
type EndpointPlanRoute = {
  [K in PlanRoute]: (typeof PLAN_QUOTA_SOURCES)[K] extends 'endpoint'
    ? K
    : never;
}[PlanRoute];
```

## fetchPlanUsage

Fetch and read a plan's usage at its quota endpoint with its API key, on
the platform `region` names.

```ts
function fetchPlanUsage(
  route: EndpointPlanRoute,
  region: ProviderRegion,
  apiKey: Redacted.Redacted<string>,
): Effect.Effect<
  PlanUsage,
  HttpClientError.HttpClientError | Cause.TimeoutError,
  HttpClient.HttpClient
>
```

## LoopbackTransportUnavailableError

The loopback route could never be established — the registered callback
port(s) could not be bound, or the host could not reach a browser at all.
Distinct from every other sign-in failure because nothing was asked of the
user yet: a host with a device-code transport can retry on that instead.

```ts
class LoopbackTransportUnavailableError extends Schema.TaggedError<LoopbackTransportUnavailableError>()(
  'LoopbackTransportUnavailableError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
)
```

## PLAN_QUOTA_SOURCES

How each plan states its quota: asked at its endpoint with its key, read
off its replies' headers, or nowhere this package reads. A plan added to
`PLAN_ROUTES` does not compile until it says which.

```ts
const PLAN_QUOTA_SOURCES: Readonly<{ readonly 'chatgpt-subscription': "reply"; readonly 'xai-subscription': null; readonly 'kimi-code-subscription': "endpoint"; readonly 'glm-coding-plan-subscription': "endpoint"; }>
```

## PlanUsage

A plan's reported usage. No window means the body named none it reads.

```ts
interface PlanUsage {
  /** The plan's tier as the provider names it, when the body says. */
  readonly planName?: string;
  readonly windows: readonly PlanUsageWindow[];
}
```

## PlanUsageWindow

One quota window of a plan, as a share of its limit.

```ts
interface PlanUsageWindow {
  /** The provider's own name for the window (`five_hour`, `glm-4.6:weekly`). */
  readonly name: string;
  readonly percentUsed: number;
  readonly percentRemaining: number;
  /** When the window resets, in epoch milliseconds. */
  readonly resetAt?: number;
  /** How long the window is, in minutes, when the provider says. */
  readonly windowMinutes?: number;
}
```

## ProviderRegion

The platform a two-platform provider's key belongs to.

```ts
type ProviderRegion = keyof RegionalBaseUrl;
```

## ReplyPlanRoute

A plan whose replies state its quota.

```ts
type ReplyPlanRoute = {
  [K in PlanRoute]: (typeof PLAN_QUOTA_SOURCES)[K] extends 'reply' ? K : never;
}[PlanRoute];
```

## replyPlanUsage

The quota windows a reply on `route` states in its headers; `receivedAt`
(epoch milliseconds) dates a reset given as seconds from the reply. Null
when the headers state no window.

```ts
function replyPlanUsage(
  route: ReplyPlanRoute,
  headers: Headers,
  receivedAt: number,
): PlanUsage | null
```

## SessionToken

A subscription session's token, which the caller renews: read before
every request, and, when the provider rejects the one sent (a 401 before
its stored expiry), handed back as `rejected` once, after which the
request goes again on the next `current`. A rejected request was not
billed. The Responses protocol alone takes one.

```ts
interface SessionToken {
  readonly current: Effect.Effect<string, ModelError>;
  readonly rejected: (token: string) => Effect.Effect<void, ModelError>;
}
```

## SubscriptionAccounts

Each subscription's account (its stored session: status, refresh, sign-in
and sign-out), named by the route that bills it. Built once over the store
that holds the sessions, so every caller of one session shares its lock and
a rotated refresh token is spent once; another store is another set of
accounts, built with it. They sign in as `client`, the app they are built
for, which the binding of a subscription route reads too.

```ts
class SubscriptionAccounts extends Context.Service<
  SubscriptionAccounts,
  {
    readonly 'chatgpt-subscription': SubscriptionCoordinator<ChatgptSession>;
    readonly 'xai-subscription': SubscriptionCoordinator<XaiSession>;
    /** The app the accounts sign in as. */
    readonly client: ClientIdentity;
  }
>()('@texra-ai/llm/SubscriptionAccounts')
```

## SubscriptionCoordinator

One provider's subscription session over the caller's secret store:
reading it, keeping it fresh, signing in and out. The account runs the
provider's sign-in protocol itself; the caller supplies only the
presentation. The mutating and refreshing programs fail with
{@link SubscriptionOAuthError}, or with the secret store's own
{@link SecretsFailed} when it rejects.

```ts
interface SubscriptionCoordinator<S extends SubscriptionSession> {
  /** Signed-in status of the stored session. */
  getStatus(): Effect.Effect<
    SubscriptionSessionStatus,
    SecretsFailed | SubscriptionOAuthError
  >;
  /** The stored session, refreshed when it expires soon. */
  getFreshSession(): Effect.Effect<S, Error, HttpClient.HttpClient>;
  /** Refresh now, while the stored session still holds `accessToken`: the
   *  provider rejected it before its expiry. */
  refreshRejected(
    accessToken: string,
  ): Effect.Effect<void, Error, HttpClient.HttpClient>;
  /** End the stored session at the provider, then forget it either way; a
   *  provider that could not confirm the end fails after the local sign-out. */
  signOut(): Effect.Effect<
    void,
    SecretsFailed | SubscriptionOAuthError,
    HttpClient.HttpClient
  >;
  /**
   * Sign in through a browser: bind the provider's loopback callback, show
   * the consent URL with `openBrowser`, and store the session the callback's
   * code grants. A callback that cannot be bound, or a browser that cannot
   * be reached, fails with `LoopbackTransportUnavailableError` before
   * anything is asked of the user.
   */
  readonly signInWithBrowser: (
    openBrowser: (url: string) => Effect.Effect<void, Error>,
  ) => Effect.Effect<S, Error, HttpClient.HttpClient>;
  /**
   * Sign in with a one-time device code (RFC 8628): `onPrompt` shows the
   * code, and the session is stored once the user approves. Absent where
   * the provider has no device-code sign-in.
   */
  readonly signInWithDeviceCode?: (
    onPrompt: (prompt: SubscriptionDeviceCodePrompt) => Effect.Effect<void>,
  ) => Effect.Effect<S, Error, HttpClient.HttpClient>;
}
```

## SubscriptionDeviceCodePrompt

The device-code prompt a host renders while polling for approval.

```ts
interface SubscriptionDeviceCodePrompt {
  /** The one-time code the user types at the verification URL. */
  readonly userCode: string;
  /** Where the user enters the code. */
  readonly verificationUrl: string;
  /** Prefilled verification URL when the provider supplies one (xAI). */
  readonly verificationUrlComplete?: string;
}
```

## SubscriptionOAuthError

A subscription sign-in or refresh failed; `kind` says what to do next.

```ts
class SubscriptionOAuthError extends Schema.TaggedError<SubscriptionOAuthError>()(
  'SubscriptionOAuthError',
  {
    message: Schema.String,
    kind: SubscriptionOAuthErrorKindSchema,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
)
```

## SubscriptionSession

Canonical stored session: the persisted base schema's shape (its single
source of truth) plus the two optional identity fields the status read
reports. Providers may add fields via intersection types.

```ts
type SubscriptionSession =
  (typeof SubscriptionSessionBaseSchema)['Type'] & {
    email?: string;
    accountId?: string;
  };
```

## SubscriptionSessionStatus

Whether a session is stored, and the account it names.

```ts
interface SubscriptionSessionStatus {
  signedIn: boolean;
  email?: string;
  accountId?: string;
}
```

## transcribeAudio

The text of an audio file, from OpenAI's transcription model with an
OpenAI key at `endpoint`. The SDK loads on the first call.

```ts
const transcribeAudio: (audioPath: string, credential: { readonly bearer: string; readonly endpoint: string; }) => Effect<string, ModelError, never>
```

## XaiSession

A stored xAI (Grok) session.

```ts
type XaiSession = typeof XaiSessionSchema.Type;
```
