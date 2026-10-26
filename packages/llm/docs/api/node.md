# `@texra-ai/llm/node`

<!-- Generated from `packages/llm/src/node.ts` by `npm run docgen`; do not edit. -->

## Binding

A bound model and the facts its configuration fixed.

```ts
interface Binding {
  readonly model: Model;
  readonly origin: ModelOrigin;
  /** Turns can run as background work (submit and observe). */
  readonly background: boolean;
  /** One connection a failed turn invalidates (the Responses WebSocket). */
  readonly persistentConnection: boolean;
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

One model on one route, and what the caller asks of it.

```ts
interface BindSpec {
  readonly protocol: Exclude<ModelOrigin['protocol'], 'vscode-lm'>;
  /** The llm-zoo entry after `routeConfig`. */
  readonly model: ModelConfig;
  readonly endpoint: string;
  /** A non-secret name of the credential route, stamped on the origin. */
  readonly credentialScope: string;
  readonly credential: ModelCredential;
  /** The route the binding bills through. */
  readonly billing: BillingRoute;
  readonly options: {
    /** The output ceiling, before the model's own rules. */
    readonly maxOutputTokens: number;
    /** The sampling temperature, applied where the model takes one. */
    readonly temperature: number;
    readonly reasoning: ReasoningChoice;
    readonly parallelToolCalls: boolean;
    /** GPT-5 sends a reasoning summary only when asked. */
    readonly reasoningSummary: boolean;
    /** Google keeps the conversation server-side. */
    readonly serverState: boolean;
    /** OpenAI's fast service tier, where the model offers it. */
    readonly fastTier: boolean;
    /** The caller would serve Responses over its WebSocket. */
    readonly webSocket: boolean;
    /** The caller would deliver turns as background work; it wins over the socket. */
    readonly background: boolean;
    /** The fetch every HTTP request goes through. */
    readonly fetch?: typeof fetch;
  };
}
```

## codexCoordinator

The coordinator for the caller's secret store: one coordinator per store
instance, so distinct stores never share session state.

```ts
const codexCoordinator: (
  secrets: CredentialStore,
) => SubscriptionCoordinator<CodexSession>
```

## codexLoginWithDeviceCode

Run the device-code flow end to end and persist the session. Succeeds with
the stored session once the user approves; fails on timeout or a hard
failure with a tagged error whose `message` is the user-facing text.

```ts
const codexLoginWithDeviceCode: (options: DeviceLoginOptions<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly planType?: string | undefined; readonly idToken?: string | undefined; readonly accountId?: string | undefined; readonly email?: string | undefined; }>) => Effect<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly planType?: string | undefined; readonly idToken?: string | undefined; readonly accountId?: string | undefined; readonly email?: string | undefined; }, Error, HttpClient>
```

## codexLoginWithLoopback

The browser sign-in, bound to the registered ChatGPT callback.

```ts
const codexLoginWithLoopback: (options: LoopbackLoginOptions<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly planType?: string | undefined; readonly idToken?: string | undefined; readonly accountId?: string | undefined; readonly email?: string | undefined; }>) => Effect<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly planType?: string | undefined; readonly idToken?: string | undefined; readonly accountId?: string | undefined; readonly email?: string | undefined; }, Error, HttpClient>
```

## CodexSession

A stored ChatGPT (Codex) session.

```ts
type CodexSession = typeof CodexSessionSchema.Type;
```

## DeviceLoginOptions

What a provider's device-code sign-in takes from its host.

```ts
interface DeviceLoginOptions<S extends SubscriptionSession> {
  /** The coordinator that stores the session the sign-in grants. */
  readonly coordinator: Pick<
    SubscriptionCoordinator<S>,
    'loginWithCode' | 'storeTokens'
  >;
  /** Show the user the verification URL + one-time code. */
  readonly onPrompt: (
    prompt: SubscriptionDeviceCodePrompt,
  ) => Effect.Effect<void>;
}
```

## getCodexStatus

Signed-in status, read from the caller's secret store. A store that
cannot be read, or a stored session that does not parse, fails.

```ts
function getCodexStatus(
  secrets: CredentialStore,
): Effect.Effect<
  SubscriptionSessionStatus,
  SecretsFailed | SubscriptionOAuthError
>
```

## getXaiStatus

Signed-in status, read from the caller's secret store. A store that
cannot be read, or a stored session that does not parse, fails.

```ts
function getXaiStatus(
  secrets: CredentialStore,
): Effect.Effect<
  SubscriptionSessionStatus,
  SecretsFailed | SubscriptionOAuthError
>
```

## LoopbackLoginOptions

What a provider's loopback sign-in takes from its host.

```ts
interface LoopbackLoginOptions<S extends SubscriptionSession> {
  /**
   * The coordinator that builds the authorize URL and exchanges the code.
   * The exchange is a program, so it runs on this flow's own fiber:
   * interrupting the login reaches the token exchange and the session store.
   */
  readonly coordinator: Pick<
    SubscriptionCoordinator<S>,
    'buildAuthorizeRequest' | 'loginWithCode'
  >;
  /**
   * Show (and normally open) the consent URL. A program, so the host's own
   * presentation runs on this flow's fibers and its failure — typically a
   * {@link LoopbackTransportUnavailableError} — reaches the caller through
   * the error channel instead of a rejection this flow has to re-wrap.
   */
  readonly openBrowser: (url: string) => Effect.Effect<void, Error>;
}
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

## ModelCredential

The credential a binding sends: an API key (or any bearer token the
endpoint takes as one), or a ChatGPT (Codex) session token, which also
names its account and is served on the Responses protocol only.

```ts
type ModelCredential =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | {
      readonly kind: 'codex';
      readonly accessToken: string;
      readonly accountId: string | null;
    };
```

## SharedAttempt

Single-flight for an Effect program: concurrent callers of {@link run}
share one attempt of the work, and each caller's interruption abandons only
its own wait.

The work runs on a detached fiber, never on the first caller's. Were it run
on the caller's fiber, stopping that caller would interrupt the attempt
every joiner is waiting on, and an interrupt landing mid-work (after a
provider rotated a single-use refresh token, before it was stored) would
drop the result nobody else can recreate. A detached attempt with no caller
left still completes, and no caller's interrupt can end it, so the work
must carry its own deadline: a stalled attempt holds the slot, and every
caller joining it, until the work gives up by itself.

The check, the claim and the fork run under one uninterruptible mask and
share one synchronous segment, so a second caller can never mint a second
attempt and an interrupt can never land between claiming the slot and
starting the fiber that settles it.

```ts
class SharedAttempt<A, E>
```

## SubscriptionAuthorizeRequest

The authorize URL a loopback login opens, and what its callback checks.

```ts
interface SubscriptionAuthorizeRequest {
  url: string;
  /** The high-entropy secret carried through the loopback round-trip. */
  verifier: string;
  state: string;
  redirectUri: string;
}
```

## SubscriptionCoordinator

One provider's subscription session over the caller's secret store:
reading it, keeping it fresh, signing in and out. The mutating and
refreshing programs fail with {@link SubscriptionOAuthError}, or with the
secret store's own {@link SecretsFailed} when it rejects.

```ts
interface SubscriptionCoordinator<S extends SubscriptionSession> {
  /** The stored session, or null when none is stored; a stored one that
   *  does not parse fails `fatal`. */
  loadSession(): Effect.Effect<
    S | null,
    SecretsFailed | SubscriptionOAuthError
  >;
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
  /** Forget the stored session. */
  signOut(): Effect.Effect<void, SecretsFailed>;
  /** The PKCE authorize URL for a loopback callback on `port`. */
  buildAuthorizeRequest(port: number): SubscriptionAuthorizeRequest;
  /** Exchange an authorization code and store the session it grants. */
  loginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Effect.Effect<S, Error, HttpClient.HttpClient>;
  /** Store the session a completed token grant returned. */
  storeTokens(tokens: SubscriptionTokenResponse): Effect.Effect<S, Error>;
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

## SubscriptionOAuthErrorKind

{@link SubscriptionOAuthErrorKindSchema}'s value.

```ts
type SubscriptionOAuthErrorKind =
  typeof SubscriptionOAuthErrorKindSchema.Type;
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

## SubscriptionTokenResponse

Raw token-endpoint shape shared by authorization-code and refresh grants.

```ts
type SubscriptionTokenResponse =
  (typeof SubscriptionTokenResponseSchema)['Type'];
```

## xaiCoordinator

The coordinator for the caller's secret store: one coordinator per store
instance, so distinct stores never share session state.

```ts
const xaiCoordinator: (
  secrets: CredentialStore,
) => SubscriptionCoordinator<XaiSession>
```

## xaiLoginWithDeviceCode

Run the device-code flow end to end and persist the session. Succeeds with
the stored session once the user approves; fails with a tagged error whose
`message` is the user-facing text.

```ts
const xaiLoginWithDeviceCode: (options: DeviceLoginOptions<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly idToken?: string | undefined; readonly email?: string | undefined; }>) => Effect<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly idToken?: string | undefined; readonly email?: string | undefined; }, Error, HttpClient>
```

## xaiLoginWithLoopback

The browser sign-in, bound to the registered Grok callback.

```ts
const xaiLoginWithLoopback: (options: LoopbackLoginOptions<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly idToken?: string | undefined; readonly email?: string | undefined; }>) => Effect<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAtMs: number; readonly idToken?: string | undefined; readonly email?: string | undefined; }, Error, HttpClient>
```

## XaiSession

A stored xAI (Grok) session.

```ts
type XaiSession = typeof XaiSessionSchema.Type;
```
