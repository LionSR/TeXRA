# PRD: GitHub Copilot model handler via the VS Code Language Model API (`vscode.lm`)

**Status:** Proposal (official path, extension-host only)
**Owner:** _unassigned_
**Tracking branch:** `claude/vscode-copilot-handler-scout-ygc444`
**Companion proposal:** [`2026-06-22-copilot-oauth-handler-prd.md`](./2026-06-22-copilot-oauth-handler-prd.md) (the cross-host OAuth route — experimental/parked)

## Summary

Let a TeXRA user drive **GitHub Copilot's models** (the ones in their Copilot
subscription's picker — GPT-4.x, o-series, Claude, Gemini, depending on plan)
from TeXRA agents, using VS Code's **official** Language Model API
(`vscode.lm`). The user signs in to Copilot the normal way (the GitHub Copilot
Chat extension), grants TeXRA per-extension consent once, and TeXRA's agent loop
calls the selected Copilot model through `vscode.lm.selectChatModels(...)` →
`model.sendRequest(...)`.

This is the **sanctioned** way to consume Copilot models, but it is
fundamentally **VS Code-extension-host only**: it cannot work in the `texra` CLI
or the Electron desktop shell, because the `vscode` module only exists inside the
extension host. It also has real capability gaps (no system role, no usage/cost
reporting, no image input in stable, hard abuse-detection rate limits).

## Motivation

- Many academic users already pay for Copilot (often via institutional/education
  plans) and would rather spend that included quota than top up a separate API
  key.
- Copilot's picker exposes a strong multi-vendor set (OpenAI + Claude + Gemini)
  behind one subscription.
- It is the **only official** way to reach the user's Copilot subscription — no
  reverse-engineering, no borrowed client id (contrast the
  [OAuth route](./2026-06-22-copilot-oauth-handler-prd.md)).
- The provider slot is **already stubbed** in the codebase (see below), so this
  is largely a matter of filling in a handler plus a new platform port.

## Current state (verified in repo)

`ModelProvider.COPILOT` already exists as an inert, pre-reserved slot:

| File                                                     | Line | Current state                                                     |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------- |
| `src/agent/runtime/ModelFactory.ts`                      | 122  | `[ModelProvider.COPILOT]: { load: null, compatibilityKey: null }` |
| `src/shared/constants/providers.ts`                      | 88   | display name `'Copilot'` (in `EXTRA_DISPLAY_NAMES`)               |
| `src/agent/modelHandlers/support/ProxyConfigResolver.ts` | 48   | `[ModelProvider.COPILOT]: null`                                   |

The `PROVIDER_HANDLER_ROUTES` record is `Record<ModelProvider, ...>`, so the
TypeScript compiler already forces every provider (including `COPILOT`) to have
an entry — filling it in is the wiring task.

## API surface (verified against `@types/vscode@1.105.0`, the version this repo targets)

`packages/extension/package.json` pins `"vscode": "^1.105.0"`. Read directly from
the installed `.d.ts`:

**Available (stable):**

- `lm.selectChatModels(selector?)` → `Thenable<LanguageModelChat[]>`; selector on
  `vendor` / `id` / `family` / `version`. **May return `[]`** — must handle.
- `lm.onDidChangeChatModels: Event<void>` — re-query when it fires.
- `LanguageModelChat`: `id`, `name`, `vendor`, `family`, `version`,
  `maxInputTokens`; `sendRequest(messages, options?, token?)`;
  `countTokens(text|message)`.
- Streaming: `response.text` (`AsyncIterable<string>`) and `response.stream`
  (`LanguageModelTextPart | LanguageModelToolCallPart | unknown`).
- Tools: `options.tools: LanguageModelChatTool[]` (`name`, `description`,
  `inputSchema`), `options.toolMode` (`Auto` | `Required`); model emits
  `LanguageModelToolCallPart` (`callId`, `name`, `input`); reply with a
  `LanguageModelToolResultPart` keyed by `callId`.
- `options.justification`, `options.modelOptions` (free-form per-model knobs).
- Consent: first `sendRequest` shows a per-extension consent dialog;
  `vscode.env.languageModelAccessInformation.canSendRequest(chat)` checks
  persisted state (does not prompt).
- Errors: `LanguageModelError.NoPermissions / Blocked (quota) / NotFound`.

**Hard limitations (confirmed by the 1.105 `.d.ts`):**

- **No system role.** `LanguageModelChatMessageRole` is `User = 1, Assistant = 2`
  only. System guidance must be folded into a `User` message. TeXRA is
  system-prompt-heavy, so this is the biggest adapter cost.
- **No image / data input in stable.**
  `LanguageModelInputPart = LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart`.
  There is no data/image content part in 1.105 (the `unknown` in the stream is a
  documented placeholder for future image parts). TeXRA agents that rely on
  PDF/image input cannot use those via this route yet.
- **No usage / cost reporting.** No token-usage field is returned; only
  `countTokens()` exists. `normalizeUsage`/`computePrice` would be estimates, and
  cost is "included in subscription," not $/token.
- **Subscription + Copilot Chat extension required.** `vendor: 'copilot'` models
  only appear when the user has Copilot and the Copilot Chat extension installed;
  a consuming extension typically declares
  `"extensionDependencies": ["github.copilot", "github.copilot-chat"]`.
- **Aggressive abuse-detection rate limiting** for agentic third-party use (see
  ToS section).

## Capability comparison against OAuth

| Capability      | `vscode.lm` route                                      | OAuth backend route                                      |
| --------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Hosts           | VS Code extension host only                            | Extension, CLI, desktop                                  |
| API shape       | VS Code Language Model API                             | OpenAI Chat Completions-compatible backend               |
| System guidance | Folded into user messages; no stable system role       | Native OpenAI-style system/developer messages expected   |
| Image/PDF input | Not available in stable `vscode.lm@1.105`              | Potentially available later via Copilot vision headers   |
| Usage reporting | No returned usage; only `countTokens()` estimates      | Backend may expose OpenAI-style token usage              |
| Policy posture  | Official API, still rate-limited for agentic workloads | Reverse-engineered and parked behind maintainer go/no-go |

## The architectural constraint (decisive)

Per `CLAUDE.md`, `src/agent/` and `src/model/` are **VS Code-free zones** — a
model handler **cannot** `import 'vscode'`, and `vscode.lm` only exists in the
extension host. So the handler cannot call `vscode.lm.*` directly. This forces a
**platform port**:

```
src/platform/                         (interface, vscode-free)
  CopilotLmPort
    listModels(): Promise<CopilotModelInfo[]>
    sendRequest(modelId, messages, tools?, opts, onChunk, signal): Promise<CopilotResult>
    countTokens(modelId, text): Promise<number>
    isAvailable(): boolean   // false in CLI/desktop

packages/extension/src/…              (vscode-allowed wiring)
  VsCodeCopilotLm implements CopilotLmPort  → wraps vscode.lm.*

packages/cli, packages/desktop
  UnsupportedCopilotLm  → isAvailable() === false; throws a clear error

src/agent/modelHandlers/copilot/modelHandlerCopilot.ts   (vscode-free)
  extends ModelHandler, delegates to platform().copilotLm (never imports vscode)
```

This mirrors how every other host capability is reached via `platform()` (config,
secrets, fs, …).

## Design

Additive; the provider slot already exists.

### 1. Platform port

Add a `CopilotLmPort` to the `Platform` interface (`src/platform/`), wired once
from `packages/extension/src/extension.ts` (VS Code impl) and from the CLI /
desktop composition roots (unsupported impl). Keep the port's message/part types
host-neutral (plain objects), translating to/from `vscode.LanguageModel*` only
inside the extension implementation.

### 2. Model handler

`ModelHandlerCopilot` in `src/agent/modelHandlers/copilot/`, delegating to
`platform().copilotLm`. Responsibilities:

- **Message build:** fold the TeXRA system prompt into the first `User` message
  (no system role); map prior turns to User/Assistant; map tool results to
  `LanguageModelToolResultPart`.
- **Streaming:** consume the port's chunk callback; emit TeXRA output/thinking
  streams as the base `ModelHandler` expects.
- **Tool calls:** map TeXRA tool contracts → `LanguageModelChatTool`; extract
  `LanguageModelToolCallPart` → TeXRA's normalized tool-call union; round-trip
  results.
- **Usage/cost:** report `cost = 0` / "included (Copilot subscription)"; derive
  input tokens from `countTokens()`, output tokens estimated. Make the
  "no real usage data" explicit in telemetry rather than faking precision.
- **Capabilities:** `supportsToolUse: true`, `supportsImages: false` (stable),
  `supportsThinking: false`, `supportsCaching: false`, `supportsTokenCounting:
true`. No Responses/compaction/web-search.

### 3. Factory wiring

Fill `PROVIDER_HANDLER_ROUTES[ModelProvider.COPILOT]` with a real `load` +
`compatibilityKey` (add `'ModelHandlerCopilot'` to the
`ModelHandlerCompatibilityKey` union). Because `vscode.lm` is host-only, also
guard in `createModelHandler`: if `!platform().copilotLm.isAvailable()`, fail
with an actionable error ("Copilot models are only available inside VS Code").

### 4. Model registry & availability

- **Dynamic discovery preferred:** populate the picker from
  `port.listModels()` (which calls `selectChatModels({ vendor: 'copilot' })`),
  re-querying on `onDidChangeChatModels`. The Copilot catalog is volatile and
  plan-dependent, so a hardcoded list will go stale.
- Add a new `ModelAvailabilityKind` (e.g. `copilot-host-only` /
  `copilot-consent-required`) in the model-selection controller so the Settings →
  Models tab can show "Available in VS Code with Copilot" and, in CLI/desktop,
  greys these out with an explanatory tooltip.

### 5. UX & consent

- Consent fires on first `sendRequest`, which **must be a user action** — trigger
  it from a Settings → Models "Enable Copilot models" button or on first run of
  an agent the user explicitly started, never on activation.
- After consent: Copilot models appear in the picker (VS Code only).
- CLI/desktop: the models are listed-but-disabled with a clear "VS Code only"
  reason; `texra` documents that Copilot models require the VS Code host.

## Platform / VS Code separation

- `ModelHandlerCopilot`, `src/model/` registry entries, and capability mapping
  stay `vscode`-free and reach Copilot only through `platform().copilotLm`.
- All `vscode.lm` calls, `LanguageModelChatMessage` construction, and the
  consent-triggering command live in `packages/extension/`.
- `extensionDependencies` on `github.copilot` / `github.copilot-chat` is declared
  in `packages/extension/package.json`.

## ToS / policy framing (non-negotiable)

- Using `vscode.lm` Copilot models **binds TeXRA to GitHub's Copilot acceptable
  use policy** (VS Code's own docs state this). Surface that to the user.
- **Documented enforcement risk even on this official path:** third-party
  extensions driving Copilot agentically through `vscode.lm` (e.g. Cline) report
  aggressive token-based rate limiting and lockouts (minutes-to-days) and
  abuse-detection warnings. The PRD must set expectations: Copilot models are
  best for light/interactive use, not long autonomous TeXRA runs.
- This route uses the user's **own** signed-in Copilot session via the official
  API — no credential sharing, no borrowed client id.

## Scope

**In (v0):** `CopilotLmPort` + VS Code impl + unsupported CLI/desktop impl;
`ModelHandlerCopilot` (system-prompt folding, streaming, tool calls, estimated
usage); factory wiring; dynamic model discovery; Settings consent/enable UX;
availability plumbing; docs.

**Out (v0):** image/PDF input (not in stable `vscode.lm`); accurate $/token
usage; CLI/desktop support (architecturally impossible via this route — see the
OAuth proposal for cross-host); caching/Responses/web-search features.

## Alternative / companion idea worth noting

`lm.registerLanguageModelChatProvider(vendor, provider)` is **stable** in 1.105.
This is the _inverse_ direction: TeXRA could **contribute its own models into VS
Code's Copilot model picker** (the BYOK provider API — `LanguageModelChatProvider`
with `provideLanguageModelChatInformation` / `provideLanguageModelChatResponse` /
`provideTokenCount`, and a `capabilities` field that does support `imageInput` and
`toolCalling`). That is a different product bet (expose TeXRA→VS Code, not
consume Copilot→TeXRA) and deserves its own proposal if pursued.

## Open questions

1. Provider id naming surfaced to users: keep `Copilot`, or distinguish
   `Copilot (VS Code)` to signal the host constraint.
2. New `ModelAvailabilityKind` value(s) vs reusing an existing host-gated kind.
3. How to represent "subscription-included, rate-limited" cost in usage/telemetry
   that assumes $/token (shared question with the Codex/OAuth work).
4. Whether to declare a hard `extensionDependencies` (blocks install without
   Copilot) or a soft runtime check (degrade gracefully). Soft is friendlier for
   non-Copilot users.
5. Helper-model usage: should Copilot models be eligible as the auxiliary/helper
   model, given the rate limits? Probably no by default.

## Milestones

1. `CopilotLmPort` interface + VS Code implementation + CLI/desktop unsupported
   stub, with unit tests on the message/tool translation (host-neutral, mockable).
2. `ModelHandlerCopilot` + factory wiring; smoke-test a real streamed
   `sendRequest` with tools inside an Extension Development Host.
3. Dynamic model discovery + availability plumbing in Settings → Models.
4. Consent/enable UX; CLI/desktop "VS Code only" messaging; CHANGELOG under an
   appropriate heading.

## References

- VS Code LM API guide: https://code.visualstudio.com/api/extension-guides/ai/language-model
- VS Code LM tools guide: https://code.visualstudio.com/api/extension-guides/ai/tools
- BYOK provider API: `vscode.lm.registerLanguageModelChatProvider` (stable, 1.105)
- Copilot supported models: https://docs.github.com/en/copilot/reference/ai-models/supported-models
- Third-party rate-limit reports (Cline via `vscode.lm`):
  https://github.com/orgs/community/discussions/150373
- Authoritative signatures: `@types/vscode@1.105.0` `index.d.ts`, namespace `lm`
  (≈ line 20610) and `LanguageModelChat*` types (≈ lines 20003–20605).
