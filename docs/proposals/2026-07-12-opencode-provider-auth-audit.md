# OpenCode provider and subscription-authentication audit (2026-07-12)

> **Status:** Design audit. OpenCode was inspected at
> [`4dcfd9182`](https://github.com/anomalyco/opencode/tree/4dcfd9182c59245b372e682dec02802b7285f69f).
> The community Gemini authentication plugin was inspected separately at
> [`f14da107`](https://github.com/jenslys/opencode-gemini-auth/tree/f14da1073222f9047d1e5aadbcb6b0db853201b1).
> Source links are pinned to these revisions and should be rechecked before implementation.
>
> **Scope:** Provider discovery, API-key and OAuth credential ownership, request routing, token refresh, custom
> endpoints, and the applicability of these designs to TeXRA. This audit does not authorize use of unpublished
> provider interfaces or settle the providers' terms-of-service questions.

## Executive finding

OpenCode supports GitHub Copilot, Gemini, and many other model endpoints, but the word _supports_ describes
three different mechanisms:

1. ordinary providers authenticate with an API key or cloud credential;
2. built-in authentication plugins adapt a particular account or subscription protocol; and
3. community plugins add protocols that OpenCode does not own or maintain.

These mechanisms should not be combined into one generic "subscription" feature. A consumer subscription does
not ordinarily grant access to the provider's public API, and an OAuth token obtained for one service must not be
sent to an arbitrary compatible endpoint.

TeXRA can adopt the same broad architecture while preserving stronger credential boundaries. The recommended
decisions are:

- retain the existing ChatGPT-subscription route and its proactive refresh policy;
- retain Google Gemini API-key support as an ordinary billed provider;
- keep cross-host GitHub Copilot subscription access parked until the maintainer explicitly accepts the use of
  unpublished interfaces and the associated account risk;
- treat Gemini CLI or consumer-plan OAuth as a separate research item, not as an extension of Gemini API-key
  support;
- add user-defined OpenAI-compatible API-key endpoints independently of subscription authentication; and
- require every future subscription adapter to declare its trusted origins, scopes, request transformation,
  model-discovery policy, refresh semantics, and credential-deletion behavior.

## Support matrix

| Route                                                        | OpenCode mechanism                                         | Present TeXRA state                                      | Recommendation                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| ChatGPT subscription                                         | Built-in Codex OAuth plugin                                | Implemented, experimental                                | Retain; improve expiry visibility                  |
| GitHub Copilot subscription                                  | Built-in GitHub device-auth plugin                         | Provider slot and two proposals; cross-host route parked | No implementation without explicit policy decision |
| Google Gemini API                                            | First-party API-key provider                               | Implemented                                              | Retain as ordinary API access                      |
| Google Vertex AI                                             | First-party cloud provider                                 | Not assessed as a TeXRA credential route here            | Consider separately for institutional users        |
| Gemini CLI or consumer OAuth                                 | Community plugin                                           | Not implemented                                          | Research only; require terms and ownership review  |
| Custom OpenAI-compatible API                                 | Configured provider with API key, URL, headers, and models | Several named compatible providers exist                 | Add a bounded user-defined provider if demanded    |
| GitLab, Poe, Azure, Cloudflare, DigitalOcean, Snowflake, xAI | Mixture of built-in auth plugins                           | Provider-dependent                                       | Evaluate one adapter at a time                     |

The matrix distinguishes transport compatibility from credential authority. For example, a server may accept an
OpenAI-shaped request without being entitled to receive an OpenAI, ChatGPT, or Copilot bearer token.

## OpenCode architecture

### Provider transport and authentication are separate

OpenCode assembles its model catalog from Models.dev, configuration, environment credentials, and provider-specific
discovery. A plugin may then filter models and supply transport options, including a request wrapper. The relevant
assembly and plugin hooks are in
[`provider.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/provider/provider.ts#L1205-L1568)
and the
[`plugin authentication contract`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/plugin/src/index.ts#L88-L217).

This separation is valuable. Model metadata, request transport, and credential acquisition change for different
reasons. A provider can use a standard SDK while a narrowly scoped plugin supplies an unusual credential or rewrites
requests to a provider-specific interface.

OpenCode stores three credential forms: OAuth credentials, API keys, and well-known tokens. OAuth records contain
access, refresh, expiry, and optional account or enterprise identifiers. The credential file is protected with mode
`0600`, but remains plaintext data accessible to processes running as the same operating-system user. See
[`auth/index.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/auth/index.ts#L8-L89).
TeXRA's host secret stores are preferable for long-lived subscription credentials.

### Built-in authentication adapters

At the audited revision, OpenCode directly registers adapters for ChatGPT/Codex, GitHub Copilot, GitLab, Poe,
Cloudflare Workers, Cloudflare AI Gateway, Azure, DigitalOcean, Snowflake Cortex, and xAI. The registry is visible in
[`plugin/index.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/plugin/index.ts#L12-L81).

This list does not mean that every adapter provides OAuth or consumer-subscription access. Some adapters merely
collect API credentials or cloud configuration. OpenCode's general provider documentation reports more than 75
providers, using Models.dev and several bundled SDK families; this breadth is principally API-provider breadth, not
subscription breadth. See the
[`provider documentation`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/web/src/content/docs/providers.mdx#L9-L47)
and the
[`bundled provider adapters`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/provider/provider.ts#L107-L134).

## Subscription routes

### ChatGPT and Codex

OpenCode's built-in Codex adapter supports browser PKCE and headless device authorization. It requests offline
access and stores the access token, refresh token, expiry, and ChatGPT account identifier. It rewrites OpenAI
Responses or Chat Completions requests to `https://chatgpt.com/backend-api/codex/responses`, then supplies the bearer
and account headers. Its OAuth flow and request transformation are in
[`openai/codex.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/plugin/openai/codex.ts#L78-L544).

The adapter exposes a filtered Codex model set, applies route-specific context limits, and reports zero monetary
cost. It therefore does not present the subscription as arbitrary OpenAI API access.

OpenCode refreshes only when a model request observes an expired token. It collapses concurrent refreshes within one
loaded provider into a single promise, but it neither refreshes proactively nor distinguishes a revoked refresh token
from a transient refresh failure. TeXRA's existing five-minute refresh window and terminal-versus-transient error
classification are stronger. TeXRA cannot predict revocation before contacting the token endpoint, but it can
distinguish a token known to be valid, a refresh that is due, a transient refresh failure, and a terminal failure that
requires sign-in. The status table below gives the corresponding user presentation.

### GitHub Copilot

OpenCode includes GitHub.com and GitHub Enterprise device authorization. It stores the returned GitHub token in its
OAuth record with `expires: 0` and uses the token for requests to `api.githubcopilot.com` or an enterprise-derived
host. The flow and request wrapper are in
[`github-copilot/copilot.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/plugin/github-copilot/copilot.ts#L9-L338).

The adapter discovers models dynamically from `/models`, excludes disabled or incomplete entries, honors picker
eligibility, and routes each advertised model through Chat Completions, Responses, or Anthropic Messages according
to the returned endpoint metadata. See
[`github-copilot/models.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/plugin/github-copilot/models.ts#L68-L255).
Dynamic discovery is preferable to a static model list, although falling back to catalog metadata after discovery
failure can expose stale capabilities.

Technical feasibility is not sufficient authorization. TeXRA's existing
[`Copilot OAuth proposal`](./2026-06-22-copilot-oauth-handler-prd.md) records that the cross-host route uses unpublished Copilot
interfaces, borrowed client identity, and editor-identifying headers. It is parked pending an explicit decision on
terms and account-suspension risk. OpenCode's implementation demonstrates that the route is practical; it does not
remove that policy question.

TeXRA also has an official, VS Code-only route through the language-model API. That route has a narrower host surface
but a materially better policy basis. The two routes must have separate provider identities if both are ever enabled.

### Google Gemini

OpenCode's ordinary Gemini route uses the first-party Google SDK and accepts `GOOGLE_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, or `GEMINI_API_KEY`. This is developer API access with API terms and billing, not use
of a consumer Gemini subscription. The bundled adapter is registered in
[`provider.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/provider/provider.ts#L107-L118).

Vertex AI is independently supported through Google Cloud Application Default Credentials or service accounts. Its
identity, billing, quotas, and endpoint ownership differ from both Gemini API keys and consumer Gemini plans. See the
[`Vertex provider documentation`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/web/src/content/docs/providers.mdx#L1138-L1160).

Gemini CLI OAuth is absent from OpenCode's built-in plugin registry. OpenCode instead lists community Gemini and
Antigravity authentication plugins in its
[`ecosystem page`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/web/src/content/docs/ecosystem.mdx#L16-L30).

The audited community Gemini plugin borrows the Gemini CLI OAuth client, requests Google Cloud and profile scopes,
uses a loopback callback, and sends traffic to `https://cloudcode-pa.googleapis.com`. Its constants and scopes are in
[`constants.ts`](https://github.com/jenslys/opencode-gemini-auth/blob/f14da1073222f9047d1e5aadbcb6b0db853201b1/src/constants.ts#L1-L33),
and its OAuth flow is in
[`oauth.ts`](https://github.com/jenslys/opencode-gemini-auth/blob/f14da1073222f9047d1e5aadbcb6b0db853201b1/src/gemini/oauth.ts#L58-L83).

The plugin intercepts Google Generative Language requests and rewrites them into internal Cloud Code Assist methods.
It refreshes within 60 seconds of expiry, deduplicates refreshes by refresh-token value, retries transient token
failures, and deletes refresh material after `invalid_grant`. See its
[`plugin entry point`](https://github.com/jenslys/opencode-gemini-auth/blob/f14da1073222f9047d1e5aadbcb6b0db853201b1/src/plugin.ts#L82-L189),
[`token coordinator`](https://github.com/jenslys/opencode-gemini-auth/blob/f14da1073222f9047d1e5aadbcb6b0db853201b1/src/plugin/token.ts#L77-L205),
and
[`request transformation`](https://github.com/jenslys/opencode-gemini-auth/blob/f14da1073222f9047d1e5aadbcb6b0db853201b1/src/plugin/request/prepare.ts#L18-L100).

This is a substantial protocol adapter, not a small OAuth addition. It depends on a borrowed client, broad scopes,
an internal service interface, and ongoing request-and-response normalization. TeXRA should not present this as
ordinary "Gemini subscription" access. Any experiment requires a terms review, named maintenance owner, pinned
protocol fixtures, a revocation test, and explicit notice that the integration is community-derived and unsupported
by Google for TeXRA.

## Custom endpoints

OpenCode permits a base-URL override for a known provider and also permits explicit custom providers. A custom
provider may define an API key, URL, headers, models, and model metadata. OpenAI-compatible Chat Completions uses an
OpenAI-compatible SDK adapter, while Responses uses the OpenAI adapter. See the
[`custom provider configuration`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/web/src/content/docs/providers.mdx#L2359-L2438)
and
[`provider package selection`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/provider/provider.ts#L1411-L1443).

This is the lowest-risk extension for TeXRA if it remains an API-key feature. A bounded design would ask for:

- a provider name and explicit base URL;
- an API key stored through the existing secret abstraction;
- an explicit protocol choice, initially Chat Completions or Responses;
- a user-maintained model list and context metadata;
- optional static headers, with secret values stored separately; and
- a conspicuous statement that the configured server receives prompts, files, tool schemas, and the configured key.

Subscription credentials must never enter this path. A ChatGPT, Copilot, Gemini CLI, or other account bearer must be
restricted to the exact trusted inference origins declared by its adapter. Redirects to a different origin should
drop authorization and fail unless that origin was explicitly included in the adapter's audited trust set.

## Security and reliability findings

### Credential storage

OpenCode's `0600` credential file prevents access by other operating-system users under ordinary permissions, but it
does not protect against another process running as the same user, accidental inclusion in a backup, or plaintext
inspection after host compromise. TeXRA should continue storing OAuth material through `platform().secrets` and must
not copy OpenCode's plaintext storage solely for CLI parity.

### Plugin and package supply boundary

Community plugins and dynamically installed provider packages execute code at the same trust level as the host that
holds credentials. OpenCode can dynamically install non-bundled provider packages in
[`provider.ts`](https://github.com/anomalyco/opencode/blob/4dcfd9182c59245b372e682dec02802b7285f69f/packages/opencode/src/provider/provider.ts#L1753-L1783).
TeXRA should prefer built-in, reviewed, pinned adapters for subscription credentials. A general plugin must not gain
ambient access to every provider's stored token.

### Refresh semantics are provider-specific

The audited adapters do not share one token lifecycle. ChatGPT refreshes after expiry; the community Gemini plugin
refreshes early and classifies revocation; Copilot stores a token as non-expiring; and other OpenCode adapters have
their own rules. A shared TeXRA UI may display a common account state, but the provider coordinator must retain the
actual expiry, refresh, revocation, and reconnection semantics.

Single-process promise deduplication does not prevent the extension, desktop application, and CLI from refreshing a
rotating token simultaneously. Before TeXRA adds another rotating-refresh provider, it should either add an
inter-process refresh lock or designate one host process as refresh owner. The stored result must be compared before
and after acquiring the lock so a waiting process does not repeat an already completed refresh.

### Expiry and reauthentication display

Known access-token expiry is observable; future refresh-token revocation is not. The settings view should not claim
that a session is valid merely because a record exists locally. A truthful status model is:

| State                     | Meaning                                                      | User presentation                  |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------- |
| Ready                     | Access token is valid and not near expiry                    | Signed in; refreshes automatically |
| Refresh due               | Access token is near expiry                                  | Checking sign-in                   |
| Transient failure         | Refresh could not be verified because of a temporary failure | Still signed in; retrying          |
| Reauthentication required | Refresh was rejected terminally or credentials are absent    | Sign in again                      |

A settings load may perform a refresh probe only when the token is near expiry. It should not add a network request
for every ordinary view opening.

## TeXRA design requirements

Every subscription adapter should be a deep provider-specific module exposing a small common surface, rather than a
generic OAuth callback followed by arbitrary endpoint configuration. The common session record may contain:

```ts
interface SubscriptionSession {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  accountIdentity?: string;
}
```

The adapter itself must own:

1. authorization and token origins;
2. allowed scopes and callback forms;
3. trusted inference and discovery origins;
4. request path, header, and body transformation;
5. model discovery, filtering, and fallback;
6. proactive refresh and concurrent-refresh rules;
7. terminal versus transient failure classification;
8. headless login, sign-out, and credential deletion; and
9. tests proving that credentials cannot reach user-defined endpoints.

The common coordinator should provide secure storage, single-flight refresh within a process, an inter-process lock
when refresh tokens rotate, structured account status, and redacted logging. It should not decide provider-specific
origins or silently substitute another credential after an authentication failure.

## Recommended sequence

1. **Account-status correctness.** Extend ChatGPT status to distinguish local credential presence from verified
   refreshability when the access token is near expiry.
2. **Custom API-key endpoints.** Design a bounded OpenAI-compatible provider whose credentials and URLs are wholly
   separate from subscription routes.
3. **Copilot policy decision.** Compare the official VS Code-only route with the unpublished cross-host route. If the
   maintainer does not explicitly accept the latter's policy and account risk, leave it parked.
4. **Cross-process refresh ownership.** Add this before any new adapter whose refresh token can rotate.
5. **Gemini CLI research.** Proceed only after terms review, a named maintainer, a protocol-stability test suite, and
   a decision about the broad Google Cloud scopes. Do not infer authorization from OpenCode's community listing.
6. **Further providers.** Evaluate GitLab, Poe, Azure, Cloudflare, DigitalOcean, Snowflake, and xAI independently.

This sequence preserves the central distinction established by the audit: API compatibility is a transport property;
subscription authority is a provider-specific security contract.
