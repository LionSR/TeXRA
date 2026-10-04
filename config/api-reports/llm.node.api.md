# `@texra-ai/llm/node` API report

Generated from `packages/llm/src/node.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 20

- `AuthPortError` — `class AuthPortError { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `bindModel` — `const bindModel: (configuration: HttpModelConfiguration, credential: ModelCredential, transport?: ModelTransport | undefined) => Effect<...>`
- `CODEX_BACKEND_BASE_URL` — `const CODEX_BACKEND_BASE_URL: "https://chatgpt.com/backend-api/codex"`
- `codexCoordinator` — `function codexCoordinator: (secrets: CredentialStore) => CodexSessionCoordinator`
- `codexLoginWithDeviceCode` — `const codexLoginWithDeviceCode: (options: CodexDeviceLoginOptions) => Effect<{ accessToken: string; refreshToken: string; expiresAtMs: number; idToken?: string | undefined; accountId?: string | undefined; email?: string | undefined; planType?: string | undefined; }, DeviceCodeMissing | ... 1 more ... | DeviceAuthorizationFailure<...>, HttpClient>`
- `codexLoginWithLoopback` — `const codexLoginWithLoopback: (options: Pick<OAuthLoopbackLoginOptions<{ accessToken: string; refreshToken: string; expiresAtMs: number; idToken?: string | undefined; accountId?: string | undefined; email?: string | undefined; planType?: string | undefined; }>, "coordinator" | "openBrowser">) => Effect<...>`
- `getCodexStatus` — `function getCodexStatus: (secrets: CredentialStore) => Effect<SubscriptionSessionStatus, never, never>`
- `getXaiStatus` — `function getXaiStatus: (secrets: CredentialStore) => Effect<SubscriptionSessionStatus, never, never>`
- `HttpModelConfiguration` — `type HttpModelConfiguration = Exclude<ModelConfiguration, { protocol: 'vscode-lm'; }>;`
- `LoopbackTransportUnavailableError` — `class LoopbackTransportUnavailableError { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `ModelCredential` — `type ModelCredential = { readonly kind: 'api-key'; readonly apiKey: string; } | { readonly kind: 'codex'; readonly accessToken: string; readonly accountId: string | null; };`
- `ModelTransport` — `interface ModelTransport { readonly fetch?: typeof fetch; readonly webSocket?: boolean; }`
- `settleFailure` — `function settleFailure: <E>(cause: Cause<E>) => unknown`
- `SharedAttempt` — `class SharedAttempt { static: ; instance: clear, inFlight, run, slot }`
- `SubscriptionDeviceCodePrompt` — `interface SubscriptionDeviceCodePrompt { readonly userCode: string; readonly verificationUrl: string; readonly verificationUrlComplete?: string; }`
- `SubscriptionOAuthError` — `class SubscriptionOAuthError { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, kind, message, name, needsReauth, pipe, stack, status, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `SubscriptionSessionStatus` — `interface SubscriptionSessionStatus { signedIn: boolean; email?: string; accountId?: string; }`
- `xaiCoordinator` — `function xaiCoordinator: (secrets: CredentialStore) => SubscriptionOAuthCoordinator<{ accessToken: string; refreshToken: string; expiresAtMs: number; idToken?: string | undefined; email?: string | undefined; }>`
- `xaiLoginWithDeviceCode` — `const xaiLoginWithDeviceCode: (options: XaiDeviceLoginOptions) => Effect<{ accessToken: string; refreshToken: string; expiresAtMs: number; idToken?: string | undefined; email?: string | undefined; }, SessionCompletionFailed | DeviceAuthorizationFailure<...>, HttpClient>`
- `xaiLoginWithLoopback` — `const xaiLoginWithLoopback: (options: Pick<OAuthLoopbackLoginOptions<{ accessToken: string; refreshToken: string; expiresAtMs: number; idToken?: string | undefined; email?: string | undefined; }>, "coordinator" | "openBrowser">) => Effect<...>`
