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
  /** Turns can run as background work (submit and observe). */
  readonly background: boolean;
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
    /** The caller would deliver turns as background work; it wins over the socket. */
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
accounts, built with it.

```ts
class SubscriptionAccounts extends Context.Service<
  SubscriptionAccounts,
  {
    readonly 'chatgpt-subscription': SubscriptionCoordinator<ChatgptSession>;
    readonly 'xai-subscription': SubscriptionCoordinator<XaiSession>;
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

## XaiSession

A stored xAI (Grok) session.

```ts
type XaiSession = typeof XaiSessionSchema.Type;
```
