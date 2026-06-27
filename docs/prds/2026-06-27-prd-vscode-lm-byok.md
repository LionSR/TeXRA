---
created: 2026-06-27
updated: 2026-06-27
---

# PRD: vscode.lm BYOK Integration for TeXRA

## Problem Statement

Academic researchers using TeXRA face compounding key-management overhead as the number of supported AI providers grows. A user who wants to switch between Anthropic Claude for theorem writing, OpenAI GPT for code generation, and Google Gemini for literature review must enter and maintain separate API keys in TeXRA's settings panel. If they also use GitHub Copilot Chat, Cursor, or other VS Code AI tools, they enter those same keys a second time in each tool's own store. Key rotation — required when a key leaks or a subscription renews — must be performed in every tool independently. For academics who are not software engineers, this ceremony creates a real adoption barrier.

VS Code 1.104 (released June 2026) introduced a stable BYOK (Bring Your Own Key) system under the `vscode.lm` namespace. A user can now enter their Anthropic, OpenAI, Google, or OpenRouter API key once in VS Code's "Chat: Manage Language Models" panel and have it available to every extension that queries `vscode.lm.selectChatModels()`. This is the right UX for TeXRA's users: manage keys in one trusted, encrypted place; have them flow into TeXRA automatically. The new `LanguageModelChatProvider` registration API also allows TeXRA to expose its own relay-backed and subscription models into the VS Code model picker, so users of GitHub Copilot Chat see TeXRA's models alongside built-in ones.

However, TeXRA's inference pipeline is significantly more sophisticated than a generic chat client. It uses Anthropic beta headers for context compaction and extended caching, places `cache_control` breakpoints for prompt caching, tracks per-iteration token usage across compaction rounds, and drives extended thinking with fine-grained effort-level parameters. The `vscode.lm` API surface is deliberately provider-agnostic and exposes none of these capabilities. This PRD defines a scoped integration that captures the key-management UX benefit where technically feasible, exposes TeXRA's own models into the unified VS Code picker, and is explicit about which features degrade or become unavailable when a `vscode.lm`-backed model is selected.

---

## Goals and Non-Goals

### Goals

- Allow users to select models sourced from VS Code's built-in BYOK store (OpenAI, OpenRouter, Ollama, and compatible custom endpoints) as inference targets inside TeXRA, without re-entering keys in TeXRA's settings.
- Register TeXRA as a `LanguageModelChatProvider` so that TeXRA's relay-backed and subscription models appear in the VS Code model picker for other extensions and in the "Chat: Manage Language Models" panel.
- Introduce a `VscodeLmModelHandler` implementing `IModelHandler` that routes inference through `vscode.lm.sendRequest()` for providers where this is safe: OpenAI-compatible endpoints without advanced Anthropic-specific features (no extended thinking, no prompt caching, no beta headers).
- Surface clear, inline degradation warnings in the TeXRA model picker whenever a `vscode.lm`-backed model is selected, enumerating exactly which TeXRA features are unavailable.
- Make the integration entirely opt-in: the `texra.model.useVsCodeLmForProvider` configuration key defaults to OFF for all providers and the existing direct-API path remains the default.
- Implement as an additive code path with no modification to existing agent YAML files, prompt structures, or the output pipeline.

### Non-Goals

- Routing Anthropic (`claude-*`) inference through `vscode.lm` in any production path. The combination of `cache_control` breakpoints, four Anthropic beta headers (`files-api-2025-04-14`, `context-management-2025-06-27`, `compact-2026-01-12`, `extended-cache-ttl-2025-04-11`), extended thinking configuration, `BetaUsage.iterations[]` accounting, and server-side compaction stream events (`compaction_delta`) is categorically not expressible through `vscode.lm.LanguageModelChatRequestOptions`. This is a hard technical blocker, not a configuration gap.
- Routing Google Generative AI inference through `vscode.lm` in any phase. Google's handler uses `requiresBatchedParallelToolResults`, the Interactions API, and thought-signature tool calls that are not representable in `LanguageModelToolCallPart`.
- Exposing `vscode.lm`-sourced API keys to TeXRA's own `@anthropic-ai/sdk` client. VS Code's documentation is explicit: BYOK keys stored in `chatLanguageModels.json` are not readable by other extensions.
- Replacing the `SecretStorage` / `platform().secrets` path for any existing provider.
- Enabling `VscodeLmModelHandler` for GitHub Copilot vendor models (`vendor='copilot'`) in any automated or background agent task. Copilot models require user-initiated consent dialogs and are quota-tracked per extension.
- Providing cost accounting or cache metrics for any request routed through `vscode.lm`. The API returns no usage object.
- Supporting code completions, semantic search, or embedding features through `vscode.lm`.
- Changing any existing agent YAML, prompt, or output pipeline.
- Publishing TeXRA's `LanguageModelChatProvider` to VS Code Business/Enterprise organizations (currently restricted by Microsoft to individual Copilot plan users). Phase 2 ships behind a feature flag until Microsoft lifts this restriction.

---

## User Stories

### US-1: Key-free onboarding for OpenAI users

**As a** new TeXRA user who already has an OpenAI API key configured in VS Code's "Chat: Manage Language Models" panel,
**I want** TeXRA's model picker to show those models without asking me to enter the key again,
**so that** I can start using TeXRA immediately after installing it.

**Acceptance criteria:**

- After installing TeXRA with no keys set in its own settings, at least one OpenAI model appears in the TeXRA model picker labelled with a "Via VS Code LM" badge if a compatible `vscode.lm` model is available and the user has toggled `texra.model.useVsCodeLmForProvider.openai` to ON.
- Selecting the model and running an agent request completes without a "missing key" error.
- If the user later adds an OpenAI key directly to TeXRA settings, both the direct-API model and the "Via VS Code LM" model continue to appear as separate entries in the TeXRA model picker (when `texra.model.useVsCodeLmForProvider.openai` is ON). The user selects explicitly which entry to use; there is no automatic precedence. To stop seeing the `vscode.lm` entry, the user turns the toggle OFF.

### US-2: TeXRA models in the VS Code model picker

**As a** TeXRA subscriber (relay tier) who also uses GitHub Copilot Chat (individual plan),
**I want** TeXRA's relay-backed models to appear in the VS Code Chat model picker,
**so that** I can use a single model selector for both Copilot Chat and TeXRA agent workflows.

**Acceptance criteria:**

- After logging into TeXRA, `vscode.lm.selectChatModels({vendor: 'texra'})` returns at least the set of models available under the user's relay tier.
- The models are listed in the VS Code Chat "Model" dropdown with vendor label "TeXRA".
- A `managementCommand` registered by TeXRA opens TeXRA's settings panel when the user clicks "Manage" next to a TeXRA model.
- This feature is gated behind `texra.vscodeLm.registerProvider` (default OFF) until Microsoft's plan restriction is clarified.

### US-3: Degradation warning before selecting a vscode.lm-backed model

**As a** power TeXRA user who relies on prompt caching to reduce costs on long documents,
**I want** the model picker to warn me before I select a `vscode.lm`-backed model that prompt caching and cost display will be unavailable,
**so that** I can make an informed decision about which path to use.

**Acceptance criteria:**

- The TeXRA model picker entry for any `vscode.lm`-routed model displays a warning icon and tooltip listing specific degraded features.
- Before the first agent run with a `vscode.lm`-routed model (ever, not just this session), TeXRA shows a one-time dismissible notification: "Cost display and prompt caching are not available for models accessed via VS Code LM. Switch to direct API keys in TeXRA Settings for full functionality." Dismissed state is stored in VS Code's global configuration (`texra.vscodeLm.shownDegradationNotice: true`) so it does not reappear across VS Code restarts.
- The notification includes a "Open TeXRA Settings" action button.

### US-4: Ollama / local model access

**As a** researcher at an institution with strict data policies,
**I want** to run TeXRA agents against a local Ollama model configured in VS Code's "Chat: Manage Language Models" panel,
**so that** no data leaves my machine.

**Acceptance criteria:**

- A `vscode.lm` model with `vendor='ollama'` (or any locally-hosted model registered via VS Code BYOK custom endpoint) appears in the TeXRA model picker after the user enables `texra.model.useVsCodeLmForProvider.ollama`.
- Selecting it and running a text-only agent task produces a response.
- If the selected model's `capabilities.toolCalling` is `false` or the field is absent, TeXRA shows a picker warning: "Tool-use agents are not available for this model" and disables tool-use agents for that selection.

### US-5: Per-provider opt-in toggle

**As a** TeXRA user who wants direct-API Anthropic with full caching but VS Code LM for OpenAI,
**I want** to enable the `vscode.lm` path per provider group individually,
**so that** I keep Anthropic's full feature set while avoiding key re-entry for OpenAI.

**Acceptance criteria:**

- The TeXRA Models settings tab shows a "Use VS Code LM" toggle per provider group (openai, openrouter, ollama, custom). No toggle exists for anthropic or google; attempting to add one via settings.json logs a warning and is ignored.
- Toggling a provider group to "Use VS Code LM" causes all models from that provider to resolve through `vscode.lm` when a matching model is available.
- The toggle defaults to OFF for all providers.

### US-6: Graceful fallback when vscode.lm model is unavailable

**As a** TeXRA user who configured a `vscode.lm`-backed GPT-4o model but then revoked the VS Code key,
**I want** TeXRA to detect the missing model and fail clearly rather than crashing silently,
**so that** I understand what happened and can fix it.

**Acceptance criteria:**

- If `vscode.lm.selectChatModels()` returns an empty array for a configured provider at agent-run time, TeXRA emits a user-visible error: "The VS Code LM model '[name]' is no longer available. Check 'Chat: Manage Language Models' or add a direct API key in TeXRA Settings."
- The agent run is aborted before sending any messages; no partial output is written.
- When `vscode.lm.onDidChangeChatModels` fires and the model reappears, it becomes selectable in the TeXRA picker without restarting VS Code.

### US-7: Tool-use agents through vscode.lm

**As a** TeXRA user running a tool-use agent with a `vscode.lm`-backed GPT-4o model,
**I want** tool calls to be correctly relayed through the `vscode.lm` streaming surface and results returned to the model,
**so that** multi-turn tool-use workflows complete correctly.

**Acceptance criteria:**

- `LanguageModelToolCallPart` chunks arriving in `response.stream` are parsed and dispatched to the correct TeXRA tool implementation.
- Tool results are re-submitted using `LanguageModelChatMessage.Assistant([toolCallPart])` + `LanguageModelChatMessage.User([toolResultPart])`.
- The tool-calling loop continues until no `LanguageModelToolCallPart` appears in a round or a stop condition is met.
- If the selected `vscode.lm` model reports `capabilities.toolCalling === false` or the field is absent, TeXRA disables tool-use for that model and shows a picker warning. Absent is treated conservatively as `false` (disabled).

### US-8: Enterprise/admin policy compliance

**As a** VS Code administrator at a university who has disabled BYOK via the `configureBYOK` GitHub Copilot policy,
**I want** TeXRA's vscode.lm integration to respect that policy,
**so that** TeXRA does not become a side channel around institutional AI governance.

**Acceptance criteria:**

- If `vscode.lm.selectChatModels()` returns an empty array or throws `LanguageModelError.NoPermissions` due to an admin policy, TeXRA logs the reason and disables the "Via VS Code LM" path gracefully.
- TeXRA does not cache or retry around the policy check.
- The direct-API SecretStorage path is unaffected by BYOK policy.

---

## Proposed Design

### Where the user configures BYOK in VS Code

Users configure BYOK keys through VS Code's built-in "Chat: Manage Language Models" command. This UI is owned entirely by VS Code core and is outside TeXRA's control. TeXRA adds no UI to this flow.

For providers configured through VS Code BYOK, TeXRA reads available models via `vscode.lm.selectChatModels()` and never reads the underlying API key. The key remains opaque inside VS Code's encrypted `chatLanguageModels.json` state.

TeXRA's own settings panel gains a new "Via VS Code LM" section in the Models tab. This section shows discovery status (which providers have models discoverable via `vscode.lm`) and contains per-provider "Use VS Code LM" toggles for the supported set (openai, openrouter, ollama, custom). Anthropic and Google do not appear in this section; the feature is technically blocked for those providers.

### How TeXRA detects available vscode.lm models at startup

Detection is lazy and non-blocking. The extension host, in `packages/extension/src/extension.ts`, registers a listener on `vscode.lm.onDidChangeChatModels` immediately at activation. This listener calls `VscodeLmProbe.refresh()` — a new class in `packages/extension/src/frontend/vscodeLm/VscodeLmProbe.ts` that lives in the VS Code-allowed zone.

`VscodeLmProbe.refresh()` calls `vscode.lm.selectChatModels()` (no selector, matching all) and stores the result in a module-level singleton cache. It does NOT call `selectChatModels()` at extension activation, since this may trigger a consent dialog. It calls it lazily when the user opens the TeXRA settings panel or model picker, or when `onDidChangeChatModels` fires. The probe also calls `selectChatModels()` lazily the first time a user initiates an agent run with a `vscode.lm`-routed model selected.

The probe result is a `VscodeLmModelCatalog`:

```typescript
interface VscodeLmModelCatalog {
  models: VscodeLmModelInfo[];
  refreshedAt: number; // Date.now()
}

interface VscodeLmModelInfo {
  vscodeLmId: string; // LanguageModelChat.id
  name: string; // LanguageModelChat.name
  vendor: string; // LanguageModelChat.vendor
  family: string; // LanguageModelChat.family
  version: string; // LanguageModelChat.version
  maxInputTokens: number; // LanguageModelChat.maxInputTokens
  supportsToolCalling: boolean; // capabilities.toolCalling === true (absent treated as false/disabled — conservative)
  supportsImageInput: boolean; // capabilities.imageInput === true
}
```

This catalog is stored in `platform().globalState` under `'vscodeLm.modelCatalog'` so that the settings webview can read it through the existing `StateStore` port without touching `vscode.lm` directly, which would violate the VS Code-free zone rules for `src/`.

### The new model option type

`computeModelOptions.ts` is extended to include an optional additional source: the `VscodeLmModelCatalog` read from `globalState`. For each `VscodeLmModelInfo` where:

- the provider is not Anthropic or Google (hard block), and
- the corresponding provider's `useVsCodeLmForProvider` toggle is enabled,

a synthetic `ModelOptionData` is constructed:

```typescript
{
  value: `vscodelm:${info.vscodeLmId}`,     // e.g. "vscodelm:openai/gpt-4o"
  label: `${info.name} (VS Code LM)`,
  provider: ModelProvider.VSCODE_LM,          // new enum value — see shim note below
  context: `${Math.round(info.maxInputTokens / 1000)}K`,
  cost: 'N/A',
  hint: 'Model accessed via VS Code Language Model API. Cost display and prompt caching unavailable.',
  availability: 'vscode-lm',                 // new ModelAvailabilityKind variant
  availabilityLabel: 'Via VS Code LM',
  requiresKey: false,
  disabled: false,
}
```

The `AVAILABILITY_STATUS` record in `computeModelOptions.ts` receives a new entry:

```typescript
'vscode-lm': {
  kind: 'vscode-lm',
  label: 'Via VS Code LM',
  available: true,
  requiresKey: false,
},
```

The `value` field prefix `vscodelm:` is parsed by `createModelHandler()` in `ModelFactory.ts` to route to `VscodeLmModelHandler`.

**Shim note on `ModelProvider.VSCODE_LM`.** Adding this enum value to the external `llm-zoo` package requires a PR with an unknown review cycle. In the interim, `ModelFactory.ts` checks for the `vscodelm:` prefix before the `PROVIDER_HANDLER_ROUTES` dispatch. Because `PROVIDER_HANDLER_ROUTES` is typed as `Record<ModelProvider, ProviderHandlerRoute>`, a new enum value without an entry fails TypeScript exhaustiveness checking, so the prefix check must guard before the record lookup. A `// TODO(vscode-lm): remove prefix check when llm-zoo gains ModelProvider.VSCODE_LM` comment marks the shim. `ModelHandlerCompatibilityKey` in `ModelFactory.ts` receives a new `'ModelHandlerVscodeLm'` member in the union. See Phase 5 for the llm-zoo PR.

### How vscode.lm.selectChatModels() is called and model matched

When an agent run begins with a model value prefixed `vscodelm:`, `VscodeLmModelHandler.getClient()` is called. Because `src/agent/` is a VS Code-free zone, `VscodeLmModelHandler` receives a `VscodeLmClientPort` interface injected at construction. The concrete implementation of this port lives in `packages/extension/src/frontend/vscodeLm/VscodeLmClientAdapter.ts` (VS Code-allowed zone). Both `ensureModelAvailable` (which returns `Promise<void>`) and `sendRequest` use the same model-selection snippet internally:

```typescript
// Inside VscodeLmClientAdapter — used by both ensureModelAvailable and sendRequest.
// ensureModelAvailable: verifies reachability, returns void (no return statement).
// sendRequest: retrieves the LanguageModelChat handle to call .sendRequest() on.
const models = await vscode.lm.selectChatModels({ id: this.vscodeLmId });
if (models.length === 0) {
  throw new VscodeLmModelUnavailableError(this.vscodeLmId);
}
// sendRequest proceeds: const modelChat = models[0]; ...
```

The `justification` string passed to `sendRequest()` is always `'TeXRA agent inference request'`.

### The VscodeLmClientPort interface

```typescript
// src/agent/modelHandlers/vscodeLm/VscodeLmClientPort.ts
// No 'vscode' import — VS Code-free zone

export interface VscodeLmClientPort {
  /**
   * Verifies the model is still reachable.
   * Throws VscodeLmModelUnavailableError if selectChatModels returns empty.
   */
  ensureModelAvailable(vscodeLmId: string): Promise<void>;

  sendRequest(
    vscodeLmId: string,
    messages: VscodeLmMessage[],
    options: VscodeLmRequestOptions,
    cancellationToken: VscodeLmCancellationToken,
  ): Promise<VscodeLmResponseStream>;

  /**
   * Estimates input token count via LanguageModelChat.countTokens().
   * Returns a best-effort figure; callers must treat as estimated.
   */
  countTokens(vscodeLmId: string, text: string): Promise<number>;
}

export interface VscodeLmMessage {
  role: 'user' | 'assistant';
  content: Array<
    VscodeLmTextContent | VscodeLmToolCallContent | VscodeLmToolResultContent
  >;
}

export interface VscodeLmTextContent {
  type: 'text';
  value: string;
}

export interface VscodeLmToolCallContent {
  type: 'toolCall';
  callId: string;
  name: string;
  input: object;
}

export interface VscodeLmToolResultContent {
  type: 'toolResult';
  callId: string;
  content: string;
}

export interface VscodeLmResponseStream {
  [Symbol.asyncIterator](): AsyncIterator<VscodeLmResponseChunk>;
}

export type VscodeLmResponseChunk =
  | { type: 'text'; value: string }
  | { type: 'toolCall'; callId: string; name: string; input: object }
  | { type: 'unknown' };

export interface VscodeLmRequestOptions {
  justification: string;
  tools?: VscodeLmToolSpec[];
  toolMode?: 'auto' | 'required';
}

export interface VscodeLmToolSpec {
  name: string;
  description: string;
  inputSchema?: object;
}

export interface VscodeLmCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (cb: () => void) => { dispose: () => void };
}
```

### VscodeLmModelHandler class skeleton

All abstract methods from `ModelHandler<M, U, R, T, C, Resp>` must be implemented. Below is the complete list with their specified behavior; non-trivial ones include inline notes.

```typescript
// src/agent/modelHandlers/vscodeLm/modelHandlerVscodeLm.ts
// No 'vscode' import — VS Code-free zone

import { ModelHandler } from '../ModelHandler';
import type {
  VscodeLmClientPort,
  VscodeLmMessage,
  VscodeLmResponseChunk,
} from './VscodeLmClientPort';
import type { ModelConfig } from 'llm-zoo';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { FileLocation } from '@shared/schemas';
import type { ToolFileAttachment } from '@shared/schemas/toolResult';
import type { ToolResultPayload } from '../utils/toolAttachmentUtils';
import type { VscodeLmToolCall } from '../types/IModelHandler';
import type { ProviderStopReason } from '../types/StopReasonTypes';
import type {
  ExtractResponseResult,
  CreateResponseOptions,
  CreateResponseResult,
} from '../types/IModelHandler';

const VSCODE_LM_STOP_REASON = 'end_turn' as const;

export class VscodeLmModelHandler extends ModelHandler<
  VscodeLmMessage, // M
  void, // U (no provider usage object)
  NormalizedUsage, // R
  VscodeLmToolCall, // T
  VscodeLmClientPort, // C
  AsyncIterable<VscodeLmResponseChunk> // Resp
> {
  // Identity flags
  override get isOpenai(): boolean {
    return false;
  }
  override get isAnthropic(): boolean {
    return false;
  }
  override get isGoogle(): boolean {
    return false;
  }

  // Capability flags — all advanced features unavailable
  readonly supportsManualCompaction = false;
  readonly supportsReasoningLevelOverride = false;
  readonly canProcessToolResultAttachments = false;
  readonly requiresBatchedParallelToolResults = false;
  // NOTE: supportsTokenCounting does not exist in IModelHandler or ModelHandler yet.
  // Implementation must add this getter to the base class/interface; `override` is not valid here.
  get supportsTokenCounting(): boolean {
    return true;
  } // estimated only

  constructor(
    config: ModelConfig,
    private readonly clientPort: VscodeLmClientPort,
    readonly vscodeLmId: string,
  ) {
    super(config);
  }

  // -----------------------------------------------------------------------
  // Client lifecycle
  // -----------------------------------------------------------------------

  /**
   * Verifies the model is still reachable; throws VscodeLmModelUnavailableError if not.
   * Returns the injected clientPort (the port IS the client for this handler).
   */
  async getClient(): Promise<VscodeLmClientPort> {
    await this.clientPort.ensureModelAvailable(this.vscodeLmId);
    return this.clientPort;
  }

  // -----------------------------------------------------------------------
  // Response generation
  // -----------------------------------------------------------------------

  /**
   * Streams the response. Accumulates tool call chunks; forwards text chunks
   * to the output stream. Sets estimatedInputTokens before the request via
   * countTokens() on the concatenated message text.
   *
   * Never throws on countTokens() failure — proceeds with inputTokens=0.
   *
   * @throws VscodeLmModelUnavailableError — propagated from getClient().
   * @throws Error with message 'vscode.lm request failed: ...' — for API errors.
   */
  protected override async createResponseImpl(
    options: CreateResponseOptions<VscodeLmMessage, VscodeLmClientPort>,
  ): Promise<
    CreateResponseResult<AsyncIterable<VscodeLmResponseChunk>, VscodeLmMessage>
  > {
    // implementation: count tokens, open output stream, call clientPort.sendRequest,
    // iterate stream, accumulate toolCalls, emit text to logger, return stream object
    throw new Error('Not yet implemented');
  }

  // -----------------------------------------------------------------------
  // Message building — all methods strip cache_control; no system role exists
  // -----------------------------------------------------------------------

  /**
   * System prompt is prepended as the first user message wrapped in <system> tags.
   * A synthetic assistant reply "Understood." follows to maintain the required
   * alternating user/assistant turn structure that vscode.lm enforces.
   *
   * Example output for systemPrompt="You are a math assistant.":
   *   [
   *     { role: 'user', content: [{ type: 'text', value: '<system>\nYou are a math assistant.\n</system>' }] },
   *     { role: 'assistant', content: [{ type: 'text', value: 'Understood.' }] },
   *     { role: 'user', content: [{ type: 'text', value: userPrefix + '\n' + userRequest }] },
   *   ]
   *
   * Implication: system-prompt caching is lost; document this in the picker tooltip.
   */
  async initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<VscodeLmMessage[]> {
    throw new Error('Not yet implemented');
  }

  async createRoundMessages(
    messages: VscodeLmMessage[],
    userMessage: string,
    _mediaFiles?: FileLocation[],
  ): Promise<VscodeLmMessage[]> {
    // Appends a user turn; image media is attached as raw bytes if
    // capabilities.imageInput === true, otherwise ignored with a warning.
    throw new Error('Not yet implemented');
  }

  /** Returns empty array — vscode.lm passes media as LanguageModelDataPart inline. */
  createMediaContent(_mediaMessage: MediaEntry[]): unknown[] {
    return [];
  }

  /**
   * Extracts text from the accumulated response. The Resp type for this handler
   * is AsyncIterable<VscodeLmResponseChunk>, which has already been consumed by
   * createResponseImpl(). extractResponse() operates on a synthetic result object
   * (see VscodeLmAccumulatedResponse) rather than the raw stream.
   *
   * stopReason is always VSCODE_LM_STOP_REASON ('end_turn') unless a tool call
   * chunk was the last event (in which case it is 'tool_use').
   */
  extractResponse(
    responseObject: AsyncIterable<VscodeLmResponseChunk>,
    _endTag: string,
  ): ExtractResponseResult {
    throw new Error('Not yet implemented');
  }

  // -----------------------------------------------------------------------
  // Continuation / prefill — no prefill support
  // -----------------------------------------------------------------------

  /** No-op: called by base class; default is already a no-op for prefill-capable handlers. */
  override addContinueMessageWithPrefill(
    _messages: VscodeLmMessage[],
    _workspaceState: AgentWorkspaceState,
    _agentSetting: AgentSetting,
  ): void {}

  /**
   * Appends a user continuation message (same text as other handlers).
   * vscode.lm has no native prefill; continuation is always without prefill.
   */
  addContinueMessageWithoutPrefill(
    messages: VscodeLmMessage[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void {
    // uses createContinuationPrompt() from base class
    throw new Error('Not yet implemented');
  }

  // -----------------------------------------------------------------------
  // Output file / prefill — no prefill
  // -----------------------------------------------------------------------

  /**
   * Writes the output file header (same as OpenAI handler, no prefill).
   * Returns [false, messages] unconditionally; vscode.lm has no assistant-prefill.
   */
  async initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: VscodeLmMessage[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    _prefill: string,
  ): Promise<[boolean, VscodeLmMessage[]]> {
    throw new Error('Not yet implemented');
  }

  // -----------------------------------------------------------------------
  // Usage / pricing
  // -----------------------------------------------------------------------

  /**
   * computePrice is never called for this handler (U=void), but must be implemented.
   * Always returns 0.
   */
  computePrice(_responseUsage: void): number {
    return 0;
  }

  /**
   * Returns NormalizedUsage with isEstimatedUsage: true.
   * outputTokens is 0 (unavailable). cost is 0 (unavailable).
   * inputTokens is taken from the pre-request countTokens() estimate stored
   * on the handler instance during createResponseImpl().
   *
   * Note: NormalizedUsageSchema must be extended with `isEstimatedUsage: z.boolean().optional()`
   * before this compiles. See Phase 3.
   */
  normalizeUsage(_rawUsage: void, responseTimeMs: number): NormalizedUsage {
    return {
      provider: 'vscode-lm', // added to UsageProviderSchema in Phase 3
      inputTokens: this._estimatedInputTokens,
      outputTokens: 0,
      cost: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      cacheMissInputTokens: 0, // cache info unavailable via vscode.lm; 0 is more honest than asserting 100% miss
      percentageCached: 0,
      reasoningTokens: 0,
      serverToolRequests: 0,
      responseTimeMs,
      isEstimatedUsage: true, // new optional field — see NormalizedUsage extension
    } as NormalizedUsage;
  }

  private _estimatedInputTokens = 0;

  // -----------------------------------------------------------------------
  // Message mutation (update after response)
  // -----------------------------------------------------------------------

  /**
   * Appends an assistant message. No cache_control; no prefill injection.
   */
  updateMessageContentWithPrefill(
    messages: VscodeLmMessage[],
    _bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', value: newResponse }],
    });
  }

  updateMessageContentWithoutPrefill(
    messages: VscodeLmMessage[],
    _bestConnector: string,
    newResponse: string,
    _workspaceState: AgentWorkspaceState,
  ): void {
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', value: newResponse }],
    });
  }

  // -----------------------------------------------------------------------
  // Stop conditions
  // -----------------------------------------------------------------------

  /**
   * Returns true when stopReason signals end-of-turn or the response contains
   * the document close tag. Always returns false for 'tool_use' (loop continues).
   */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean {
    throw new Error('Not yet implemented');
  }

  /** Returns null — no thinking content available through vscode.lm. */
  processThinkingBlock(_responseObject: unknown): null {
    return null;
  }

  // -----------------------------------------------------------------------
  // Tool use
  // -----------------------------------------------------------------------

  /**
   * Extracts accumulated VscodeLmToolCall[] from the response object.
   * Returns [] if the model does not support tool calling.
   */
  extractToolUse(
    _responseObject: AsyncIterable<VscodeLmResponseChunk>,
  ): VscodeLmToolCall[] {
    throw new Error('Not yet implemented');
  }

  /**
   * Builds follow-up messages for a single tool call round.
   *
   * Pattern:
   *   Assistant: [{ type: 'toolCall', callId, name, input }]
   *   User:      [{ type: 'toolResult', callId, content: result.text }]
   *
   * Binary attachments in `attachments` are ignored (no Files API).
   * `client` is unused (no file upload path for vscode.lm).
   */
  async createToolUseFollowUpMessages(
    _client: VscodeLmClientPort | undefined,
    call: VscodeLmToolCall,
    result: ToolResultPayload,
    _attachments: ToolFileAttachment[],
    _workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<VscodeLmMessage[]> {
    throw new Error('Not yet implemented');
  }

  /** Appends a plain user turn. */
  async createUserFollowUpMessages(
    messages: VscodeLmMessage[],
    userMessage: string,
  ): Promise<VscodeLmMessage[]> {
    return [
      ...messages,
      { role: 'user', content: [{ type: 'text', value: userMessage }] },
    ];
  }

  createAssistantMessage(text: string): VscodeLmMessage {
    return { role: 'assistant', content: [{ type: 'text', value: text }] };
  }

  extractServerToolData(_responseObject: unknown) {
    return { webSearchResults: [], webFetchResults: [], contentBlocks: [] };
  }

  // -----------------------------------------------------------------------
  // Message modification helpers
  // -----------------------------------------------------------------------

  prependTextToUserMessage(messages: VscodeLmMessage[], text: string): void {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') {
      last.content.unshift({ type: 'text', value: text });
    }
  }

  async addMediaToUserMessage(
    messages: VscodeLmMessage[],
    _mediaFiles: FileLocation[],
  ): Promise<void> {
    // Image input only if capabilities.imageInput === true.
    // Attach as LanguageModelDataPart (raw bytes) via clientPort when supported.
    // Log a warning and skip when not supported.
    this.logger.warn('Image input via vscode.lm is not yet implemented.');
  }

  extractAssistantText(message: VscodeLmMessage): string | undefined {
    if (message.role !== 'assistant') return undefined;
    const text = message.content
      .filter((c): c is { type: 'text'; value: string } => c.type === 'text')
      .map((c) => c.value)
      .join('');
    return text.length > 0 ? text : undefined;
  }
}
```

**Important implementation note on `extractResponse` and the accumulated response object.** Because `vscode.lm` delivers a streaming `AsyncIterable`, `createResponseImpl` must consume the stream before returning. The `Resp` type parameter (`AsyncIterable<VscodeLmResponseChunk>`) is therefore a design fiction kept for type-system compatibility with the base class. In practice, `createResponseImpl` accumulates a `VscodeLmAccumulatedResponse` struct (text, toolCalls, finalStopReason) and stores it on the handler instance, and `extractResponse` reads from that struct rather than re-iterating. This deviation from the normal data-flow contract must be documented in `modelHandlerVscodeLm.ts` with a comment explaining why.

### Streaming through LanguageModelChatResponse

`VscodeLmClientAdapter.sendRequest()` iterates `response.stream` and translates each chunk:

```typescript
for await (const chunk of response.stream) {
  if (chunk instanceof vscode.LanguageModelTextPart) {
    yield { type: 'text', value: chunk.value };
  } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
    yield { type: 'toolCall', callId: chunk.callId, name: chunk.name, input: chunk.input };
  } else {
    yield { type: 'unknown' };
  }
}
```

### The VscodeLmToolCall type

A new discriminant is added to the `SdkToolCall` union in `src/agent/modelHandlers/types/IModelHandler.ts`:

```typescript
export type VscodeLmToolCall = {
  provider: 'vscode-lm';
  callId: string;
  name: string;
  input: object;
  // No 'raw' field — LanguageModelToolCallPart carries no additional metadata
};

export type SdkToolCall =
  | OpenAIToolCall
  | DeepSeekToolCall
  | OpenAIResponseToolCall
  | GoogleToolCall
  | AnthropicToolCall
  | OpenRouterToolCall
  | VscodeLmToolCall; // new
```

### How token counting and usage are approximated

`vscode.lm` returns no usage object. Before each `sendRequest()` call, `VscodeLmModelHandler` calls `clientPort.countTokens(vscodeLmId, concatenatedInputText)` to estimate input tokens and stores the result in `this._estimatedInputTokens`. This is a best-effort figure; `countTokens()` failure is soft (sets `_estimatedInputTokens = 0`, logs a debug warning, continues).

`NormalizedUsageSchema` in `src/agent/types/NormalizedUsage.ts` is extended with:

```typescript
isEstimatedUsage: z.boolean().optional(),
```

All existing handlers leave this field absent (treated as `false` by consumers). The cost display component checks this flag and shows "~N tokens (estimated)" and "Cost: N/A" rather than "$0.00" to avoid misleading users into thinking the run was free.

The TeXRA run summary panel shows a banner: "Cost and cache metrics are unavailable for VS Code LM models. Input token count is estimated."

### TeXRA as LanguageModelChatProvider

`VscodeLmProviderRegistration.ts` in `packages/extension/src/frontend/vscodeLm/` calls:

```typescript
vscode.lm.registerLanguageModelChatProvider('texra', {
  async provideLanguageModelChatInformation(options, token) {
    if (options.silent && !isLoggedIn()) return [];
    const relayModels = await getRelayModelList();
    return relayModels.map((m) => ({
      id: m.value,
      name: m.label,
      family: m.provider,
      version: '1',
      maxInputTokens: m.contextWindowTokens,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: { toolCalling: true, imageInput: false },
    }));
  },
  async provideLanguageModelChatResponse(
    model,
    messages,
    options,
    progress,
    token,
  ) {
    const response = await runRelayInference(
      model.id,
      messages,
      options,
      token,
    );
    for await (const chunk of response) {
      progress.report(new vscode.LanguageModelTextPart(chunk.text));
    }
  },
  async provideTokenCount(model, text, token) {
    return estimateTokenCount(text);
  },
});
```

This registration is gated behind `texra.vscodeLm.registerProvider` (default OFF). When the user enables it and is not on an individual Copilot plan, an informational tooltip explains: "TeXRA models in the VS Code picker are currently only visible to individual GitHub Copilot plan users (Free, Pro, Pro+). Business/Enterprise users will not see them until Microsoft lifts this restriction."

`package.json` addition:

```json
"contributes": {
  "languageModelChatProviders": [
    {
      "vendor": "texra",
      "displayName": "TeXRA",
      "managementCommand": "texra.openModelSettings"
    }
  ]
}
```

### Fallback behavior when vscode.lm model is unavailable

`VscodeLmModelUnavailableError` is a new class in `src/common/errors/VscodeLmModelUnavailableError.ts`. The agent runtime in `src/agent/runtime/` catches this class specifically and calls `runtimeHost.emit('vscodeLmModelUnavailable', { modelId })` — a new typed event key added to `ProgressEventPayloads` in `src/eventBus/ProgressEventBus.ts`. The extension host layer registers a listener for this event and shows a VS Code error notification with an "Open Language Model Settings" action.

There is no automatic fallback to a different model. The user must explicitly reconfigure. This is the correct behavior because a silent fallback to a different model could produce unexpected outputs for agents that were selected specifically for their capability profile.

---

## What TeXRA Features Cannot Work Through vscode.lm

The following features are unavailable when a `vscode.lm`-routed model is selected. Each triggers a specific warning in the model picker tooltip and a one-time run-start notification:

| Feature                                      | Why unavailable                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extended thinking / adaptive thinking        | `buildThinkingConfig()` parameters (`thinking.type`, `output_config.effort`) cannot be expressed in `LanguageModelChatRequestOptions`. The `modelOptions` bag has no documented schema at the VS Code or Anthropic provider level.                                                  |
| Prompt caching (`cache_control` breakpoints) | `LanguageModelChatMessage` has no field for cache annotations. The VS Code Anthropic provider has no documented pass-through for `cache_control`.                                                                                                                                   |
| Anthropic beta headers                       | `files-api-2025-04-14`, `context-management-2025-06-27`, `compact-2026-01-12`, `extended-cache-ttl-2025-04-11` are assembled in `anthropicContextManagement.ts` and injected as HTTP headers via the Anthropic SDK client, with no equivalent in `LanguageModelChatRequestOptions`. |
| Server-side context compaction               | The `compaction_delta` stream event and `BetaUsage.iterations[]` are Anthropic SDK-specific streaming artifacts not representable in `vscode.lm`.                                                                                                                                   |
| Files API document upload                    | TeXRA uses `source: {type:'file', file_id}` in Anthropic `MessageParam` blocks. `LanguageModelDataPart` embeds raw bytes; it cannot reference a server-side `file_id` handle. PDF agents must be blocked for this path.                                                             |
| System prompt (top-level)                    | `LanguageModelChatMessageRole` has only `User` and `Assistant`. System content is prepended as a user message wrapped in `<system>` tags; this loses Anthropic-side system-prompt caching and changes semantics for providers that treat the first user message differently.        |
| Accurate cost display                        | No usage object returned from `vscode.lm`.                                                                                                                                                                                                                                          |
| Cache savings display                        | `cachedInputTokens` / `cacheCreationTokens` unavailable.                                                                                                                                                                                                                            |
| Output token count                           | Unavailable; displayed as N/A.                                                                                                                                                                                                                                                      |
| Per-model reasoning effort tiers             | `thinking.effort` (`low`/`medium`/`high`/`xhigh`/`max`) cannot be injected via `modelOptions` with any guarantee. The TeXRA effort slider is disabled for `vscode.lm` models.                                                                                                       |
| Relay quota enforcement                      | `ServerSideKeyService.canUseModelSync()` does not apply; the key is managed by VS Code.                                                                                                                                                                                             |
| `requiresBatchedParallelToolResults`         | Always false for this handler; providers that require batched parallel tool results (Google, DeepSeek, Kimi, MiniMax) are blocked.                                                                                                                                                  |
| Context compaction eligibility               | `isCompactionEligibleModel()` always returns false. A context-window warning fires at 75% estimated fill.                                                                                                                                                                           |

### Capability flags in TeXRA's model registry for vscode.lm-backed models

The synthetic `ModelConfig` for `vscode.lm` models carries:

```typescript
const vscodeLmCapabilities: ModelCapabilities = {
  supportsPromptCaching: false,
  supportsTokenCounting: true, // via countTokens() — estimated only
  supportsStreaming: true,
  supportsToolUse: info.supportsToolCalling,
  supportsImageInput: info.supportsImageInput,
  supportsSystemPrompt: false, // workaround applied in initializeMessages()
  supportsExtendedThinking: false,
  supportsServerCompaction: false,
  supportsReasoningEffort: false,
  requiresBatchedParallelToolResults: false,
  // New flag read by VscodeLmModelHandler to skip caching/compaction setup
  isVscodeLmBacked: true,
};
```

`isVscodeLmBacked: true` is added to the `ModelCapabilities` type in `llm-zoo`. The interim shim stores it as a loose property on the synthetic `ModelConfig` object. Rather than casting to `any`, read it through a narrowly-typed local intersection in `VscodeLmModelHandler`:

```typescript
type VscodeLmModelConfig = ModelConfig & {
  capabilities: ModelCapabilities & { isVscodeLmBacked?: boolean };
};
const cfg = this.config as VscodeLmModelConfig;
if (cfg.capabilities.isVscodeLmBacked === true) {
  /* skip caching/compaction setup */
}
```

This keeps the prefix-guard path type-checked and avoids the `as any` escape hatch that would otherwise bypass the repo's internal type-safety convention.

### Settings UI changes

The TeXRA Settings webview's Models tab gains a new "VS Code Language Model" section (positioned after the existing provider key sections). It contains:

1. **Discovery status**: "N models available via VS Code LM" (read-only, sourced from `globalState['vscodeLm.modelCatalog']`).
2. **Provider toggles**: One toggle per supported provider group (`openai`, `openrouter`, `ollama`, `custom`). Label: "Use VS Code LM for [Provider]". Default: OFF. Anthropic and Google are absent from this list.
3. **"Open Language Model Settings" button**: Fires `vscode.commands.executeCommand('workbench.action.chat.manageLanguageModels')`.
4. **Register as provider toggle**: "Expose TeXRA models in VS Code picker" mapped to `texra.vscodeLm.registerProvider`. Default: OFF. Shows the individual-plan caveat.

A new `SETTINGS_VIEW_COMMANDS.SET_VSCODE_LM_PROVIDER_ENABLED` carries `{provider: string, enabled: boolean}` from the webview to the handler, which writes to `texra.model.useVsCodeLmForProvider.<provider>` via `platform().config.update(...)`. A new `SETTINGS_VIEW_COMMANDS.SET_VSCODE_LM_REGISTER_PROVIDER` carries `{enabled: boolean}` to set `texra.vscodeLm.registerProvider`.

---

## Technical Architecture

### New files and their locations

```
src/agent/modelHandlers/vscodeLm/
  modelHandlerVscodeLm.ts        # VscodeLmModelHandler class
  VscodeLmClientPort.ts          # Port interface (no vscode import)
  VscodeLmAccumulatedResponse.ts # Internal struct for consumed stream data
  vscodeLmUsage.ts               # normalizeUsage() implementation
  vscodeLmMessages.ts            # initializeMessages(), createRoundMessages()
  vscodeLmTools.ts               # extractToolUse(), createToolUseFollowUpMessages()
  # Note: VscodeLmModelUnavailableError is defined at src/common/errors/ (see below).
  # Do NOT add a re-export shim here; consumers import it directly via @common/errors.
packages/extension/src/frontend/vscodeLm/
  VscodeLmClientAdapter.ts          # Concrete VscodeLmClientPort (imports vscode)
  VscodeLmProbe.ts                  # Model discovery, catalog refresh
  VscodeLmProviderRegistration.ts   # registerLanguageModelChatProvider() for TeXRA models

src/common/errors/
  VscodeLmModelUnavailableError.ts  # Error class (no vscode import)

src/shared/constants/
  vscodeLmConstants.ts              # 'vscodelm:' prefix, provider toggle config key names

src/model/
  vscodeLmModelConfig.ts            # Synthetic ModelConfig builder for vscode.lm models
```

### Modified files

| File                                                                | Change                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agent/runtime/ModelFactory.ts`                                 | Add `vscodelm:` prefix branch (before `PROVIDER_HANDLER_ROUTES` dispatch) in `createModelHandler()`; add `'ModelHandlerVscodeLm'` to `ModelHandlerCompatibilityKey` union; inject `VscodeLmClientPort` from Platform extension                                                     |
| `src/model/computeModelOptions.ts`                                  | Merge `VscodeLmModelCatalog` from globalState; add `'vscode-lm'` to `AVAILABILITY_STATUS` record (requires the enum variant added to `ModelAvailabilityKindSchema` first — see row below)                                                                                          |
| `src/eventBus/ProgressEventBus.ts`                                  | Add `vscodeLmModelUnavailable: { modelId: string }` and `vscodeLmContextWarning: { modelId: string; estimatedTokens: number }` to `ProgressEventPayloads` (emitted via `runtimeHost.emit()` from the agent runtime, consumed by extension-host listeners)                          |
| `src/agent/modelHandlers/types/IModelHandler.ts`                    | Add `VscodeLmToolCall` to `SdkToolCall` union                                                                                                                                                                                                                                      |
| `src/agent/types/NormalizedUsage.ts`                                | Add `isEstimatedUsage: z.boolean().optional()` to `NormalizedUsageSchema`; add `'vscode-lm'` to `UsageProviderSchema` (Phase 3 — so `normalizeUsage()` output passes schema validation from the start)                                                                             |
| `packages/extension/src/extension.ts`                               | Register `VscodeLmProbe` listener on `onDidChangeChatModels`; construct `VscodeLmClientAdapter`; conditionally call `VscodeLmProviderRegistration` when `texra.vscodeLm.registerProvider` is true                                                                                  |
| `packages/extension/package.json`                                   | Add `contributes.languageModelChatProviders` entry (with `managementCommand: 'texra.openModelSettings'`); add `texra.model.useVsCodeLmForProvider` configuration object; add `texra.vscodeLm.registerProvider` boolean (default false); register `texra.openModelSettings` command |
| `packages/extension/src/settingsView/SettingsViewMessageHandler.ts` | Add `SET_VSCODE_LM_PROVIDER_ENABLED` and `SET_VSCODE_LM_REGISTER_PROVIDER` handlers                                                                                                                                                                                                |
| `src/shared/schemas/settingsView/inbound.ts`                        | Add `SetVscodeLmProviderEnabledMessageSchema` and `SetVscodeLmRegisterProviderMessageSchema` to `SettingsViewInboundMessageSchema` discriminated union                                                                                                                             |
| `src/shared/schemas/mainView/state.ts`                              | Add `'vscode-lm'` to `ModelAvailabilityKindSchema` (enum at `:43`; `ModelAvailabilityKind` type derived at `:56`); `AVAILABILITY_STATUS` in `computeModelOptions.ts:53` is typed `Record<ModelAvailabilityKind, …>` and won't compile until this variant is added first            |
| `packages/extension/src/settingsView/frontend/tabs/ModelsTab.ts`    | Add VS Code LM section                                                                                                                                                                                                                                                             |
| Cost display components in settings and progress webviews           | Check `isEstimatedUsage` flag and show "N/A" / "~N tokens (estimated)"                                                                                                                                                                                                             |

### Data flow for a vscode.lm-routed agent run

```
User selects model "vscodelm:openai/gpt-4o"
  │
  ▼
AgentRuntime.run(config)
  │  config.modelConfig.value === 'vscodelm:openai/gpt-4o'
  ▼
createModelHandler(config)                          [ModelFactory.ts]
  │  detects 'vscodelm:' prefix (before PROVIDER_HANDLER_ROUTES lookup)
  │  parses vscodeLmId = 'openai/gpt-4o'
  │  builds synthetic ModelConfig via vscodeLmModelConfig.ts
  │  retrieves VscodeLmClientAdapter from Platform extension
  ▼
new VscodeLmModelHandler(syntheticConfig, clientAdapter, vscodeLmId)
  │
  ▼
handler.getClient()
  │  clientAdapter.ensureModelAvailable('openai/gpt-4o')
  │    └─ vscode.lm.selectChatModels({id:'openai/gpt-4o'})  [vscode.lm API]
  │       throws VscodeLmModelUnavailableError if empty
  │
  ▼
handler.createResponse(messages, tools, agentTrace)
  │
  ├─ clientPort.countTokens(id, text)               [VscodeLmClientAdapter]
  │    └─ modelChat.countTokens(text, token)         [vscode.lm API]
  │       stores result in _estimatedInputTokens
  │
  ├─ clientPort.sendRequest(id, messages, opts, ct)  [VscodeLmClientAdapter]
  │    └─ modelChat.sendRequest(vscMessages, opts, token)  [vscode.lm API]
  │         └─ VS Code core → BYOK provider → model inference
  │
  ├─ for await chunk of responseStream:
  │    text chunk  → agentTrace outputStream.append(text)
  │    toolCall    → accumulate VscodeLmToolCall[]
  │
  ▼
handler.extractResponse() → ExtractResponseResult {
  text: string,
  usage: { provider: 'vscode-lm' },  // 'vscode-lm' added to UsageProviderSchema in Phase 3
  stopReason: 'end_turn' | 'tool_use',
}
  │
  ▼
handler.extractToolUse() → VscodeLmToolCall[]
  │
  ▼
handler.normalizeUsage(undefined, elapsedMs) → NormalizedUsage {
  inputTokens: _estimatedInputTokens,
  outputTokens: 0,
  cost: 0,
  isEstimatedUsage: true,
  ...
}
  │
  ▼
Agent tool-use loop (unchanged except SdkToolCall discriminant 'vscode-lm')
  └─ createToolUseFollowUpMessages() builds next round messages
       as Assistant[toolCall] + User[toolResult] pairs
```

---

## API Limitations and Mitigations

### Blocker 1: Anthropic beta headers are inexpressible — Anthropic hard-blocked

The four Anthropic beta flags (`files-api-2025-04-14`, `context-management-2025-06-27`, `compact-2026-01-12`, `extended-cache-ttl-2025-04-11`) assembled in `anthropicContextManagement.ts` cannot be forwarded through `LanguageModelChatRequestOptions.modelOptions` with any guarantee. The VS Code built-in Anthropic BYOK provider has no documented contract to pass arbitrary HTTP headers to the Anthropic Messages API.

**Mitigation:** `createModelHandler()` throws immediately if the `vscodelm:` prefix is detected and the underlying `vendor` field of the discovered `VscodeLmModelInfo` is `'anthropic'` (or the family starts with `'claude'`). Error message: "VS Code LM routing is not supported for Anthropic models. Add an Anthropic API key in TeXRA Settings to use full functionality." The Settings UI does not show an Anthropic toggle. Open question #1 (Anthropic provider commitment to beta-header pass-through) must be resolved before this restriction can be lifted.

### Blocker 2: Prompt caching invisible through vscode.lm — silently disabled

TeXRA places `cache_control: {type:'ephemeral'}` (5-minute) and `cache_control: {type:'ephemeral', ttl:'1h'}` (1-hour) breakpoints on specific content blocks. These are Anthropic SDK `MessageParam` fields with no analogue in `LanguageModelChatMessage`. The `vscode.lm` API provides no mechanism to annotate individual message parts with cache hints.

**Mitigation:** Prompt caching is silently disabled for all `vscode.lm`-routed models. `VscodeLmModelHandler.initializeMessages()` and `createRoundMessages()` never emit any cache-control annotation. The model picker tooltip includes "Prompt caching: not available". The run summary notes "Prompt caching not active (VS Code LM model)."

### Blocker 3: Extended thinking / adaptive thinking lost — UI disabled

`buildThinkingConfig()` in `anthropicThinking.ts` constructs the `thinking: {type:'adaptive', display:'summarized'}` block with `output_config.effort` varying per model (Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5, Mythos 5 each have different effort tiers). This is injected directly into `client.beta.messages.stream()` parameters via the Anthropic SDK.

**Mitigation:** The TeXRA Settings "Thinking" effort slider is disabled (greyed out) when a `vscode.lm`-backed model is selected. `VscodeLmModelHandler.capabilities.supportsExtendedThinking` is `false`. The model picker tooltip shows "Extended thinking: not available (VS Code LM)". No `modelOptions` pass-through is attempted; even as an undocumented experiment, forwarding `thinkingEffort` through `modelOptions` has no guarantee of effect and could cause confusing behavior.

### Blocker 4: Server-side context compaction inaccessible — disabled with warning

The `compaction_delta` stream event and `BetaUsage.iterations[]` from `client.beta.messages.stream()` are Anthropic SDK streaming artifacts with no analogue in `LanguageModelChatResponse`. The `vscode.lm` streaming surface yields only `LanguageModelTextPart`, `LanguageModelToolCallPart`, and `LanguageModelDataPart`.

**Mitigation:** `VscodeLmModelHandler.supportsManualCompaction` is `false`. When estimated input token count exceeds 75% of `maxInputTokens` (the only context-size information `vscode.lm` exposes), the agent calls `runtimeHost.emit('vscodeLmContextWarning', { modelId, estimatedTokens })` — a new typed event key added to `ProgressEventPayloads` in `src/eventBus/ProgressEventBus.ts` — to advise the user to start a new run or switch to a direct-API model with compaction enabled. The compaction UI controls are hidden when a `vscode.lm` model is active.

### Blocker 5: BYOK keys are opaque — full delegation model, not key extraction

VS Code's documentation states that BYOK keys in `chatLanguageModels.json` are not readable by other extensions. There is no injection point to obtain the key and pass it to `new Anthropic({apiKey})`.

**Mitigation:** TeXRA never attempts to read VS Code's BYOK key store. For the `vscode.lm` path, all inference is delegated to `clientPort.sendRequest()`, which calls `modelChat.sendRequest()` inside `VscodeLmClientAdapter`. TeXRA's own `@anthropic-ai/sdk` is never instantiated in this path. This is a full delegation model.

### Blocker 6: System prompts not supported in vscode.lm — user-message workaround

`LanguageModelChatMessageRole` has only `User=1` and `Assistant=2`. TeXRA's system prompt is normally placed in the Anthropic `system:` field or the OpenAI `messages[0].role='system'` entry.

**Mitigation:** `VscodeLmModelHandler.initializeMessages()` prepends the system prompt as the first `VscodeLmMessage` with `role: 'user'` and content wrapped in `<system>\n{systemPrompt}\n</system>`. A synthetic assistant reply `"Understood."` follows to satisfy the alternating turn requirement. Consequences: system-prompt caching is lost; some models may not honor a system prompt delivered this way as strictly as a native system field. The model picker tooltip notes "System prompt: via user-message workaround." Agent YAML files are unchanged.

### Blocker 7: Tool calling contracts diverge — new discriminant, parallel batching not applicable

TeXRA's `SdkToolCall` is a discriminated union on `provider` with six variants, each typed to its raw SDK object (e.g., `AnthropicToolCall.raw` is `ToolUseBlock`). `vscode.lm` delivers `LanguageModelToolCallPart({callId, name, input})` with no raw SDK object. The existing `createToolUseFollowUpMessages()` / `createBatchedToolUseFollowUpMessages()` pipeline assumes provider-specific raw objects.

**Mitigation:** A new `VscodeLmToolCall` discriminant (`provider: 'vscode-lm'`) is added to `SdkToolCall`. `createToolUseFollowUpMessages()` for this handler uses only the portable fields (callId, name, input). `createBatchedToolUseFollowUpMessages()` is not implemented (tool calls are single-per-round for `vscode.lm`); the agent tool-use loop in `src/agent/` already checks `requiresBatchedParallelToolResults` before calling the batched variant.

### Blocker 8: Usage accounting breaks completely — estimates and N/A display

`NormalizedUsage` carries `inputTokens`, `outputTokens`, `cost`, `cachedInputTokens`, `cacheCreationTokens`, `percentageCached`, `reasoningTokens`, `serverToolRequests`, and `responseTimeMs`. Every field except `responseTimeMs` is sourced from the provider's response object. `vscode.lm` returns no usage data.

**Mitigation:** A new optional `isEstimatedUsage: boolean` field is added to `NormalizedUsageSchema`. When `true`, the cost display shows "Cost: N/A (VS Code LM)" and the token count shows "~N tokens (estimated)". Output tokens, cache tokens, and reasoning tokens show "N/A". The `UsageProviderSchema` enum gains `'vscode-lm'` for the `provider` field. `ServerSideKeyService.canUseModelSync()` is not called for this path (no relay quota applies).

### Blocker 9: Model capability metadata is sparse

TeXRA's `llm-zoo` `ModelConfig` encodes `contextWindow`, `maxOutputTokens`, `inputPrice`, `outputPrice`, and fine-grained `ModelCapabilities`. `vscode.lm` exposes only `maxInputTokens` and `capabilities: {imageInput?, toolCalling?}`.

**Mitigation:** The synthetic `ModelConfig` for `vscode.lm` models sets `maxOutputTokens = Math.floor(info.maxInputTokens / 4)` as a rough estimate (error range: 2–6× across model families — e.g. GPT-4o with 128K input and 16K max output yields 32K, a 2× overestimate; downstream output-size guards should treat this value as a ceiling hint, not a precise limit), `inputPrice = 0`, `outputPrice = 0`, and `contextWindow = info.maxInputTokens`. This is documented as an estimate in the model picker tooltip: "Max output tokens: estimated (VS Code LM reports input tokens only)". Features gated on missing capability fields (e.g., per-model reasoning effort tiers) default to disabled.

### Blocker 10: Google hard-blocked

Google's handler uses `requiresBatchedParallelToolResults`, the Interactions API path, and thought-signature tool calls (`FunctionCall.args` with a `thoughtSignature` field). None of these are representable in `vscode.lm`.

**Mitigation:** Same hard block as Anthropic. `createModelHandler()` throws immediately if the `vscodeLmId` vendor is `'google'` (or the family starts with `'gemini'`). The Settings UI does not show a Google toggle.

---

## Rollout Strategy

### Feature flags and default values

| Configuration key                               | Default | Purpose                                                                                                           |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `texra.model.useVsCodeLmForProvider.openai`     | `false` | Enable vscode.lm path for OpenAI models                                                                           |
| `texra.model.useVsCodeLmForProvider.openrouter` | `false` | Enable vscode.lm path for OpenRouter models                                                                       |
| `texra.model.useVsCodeLmForProvider.ollama`     | `false` | Enable vscode.lm path for Ollama/local models                                                                     |
| `texra.model.useVsCodeLmForProvider.custom`     | `false` | Enable vscode.lm path for custom endpoints                                                                        |
| `texra.vscodeLm.registerProvider`               | `false` | Register TeXRA as a `LanguageModelChatProvider` in VS Code                                                        |
| `texra.vscodeLm.shownDegradationNotice`         | `false` | Tracks whether the one-time degradation warning has been permanently dismissed (persists across VS Code restarts) |

All flags are VS Code configuration settings scoped to `ConfigurationTarget.Global`. They are not stored in `platform().secrets` or `globalState`.

### VS Code version floor

`vscode.lm.registerLanguageModelChatProvider` requires VS Code 1.104+. TeXRA's `engines.vscode` is `^1.105.0`, which already satisfies this requirement — no version bump is needed. The capability checks below are still warranted as defensive practice for environments where the `vscode.lm` API is absent despite the version floor (e.g. when Copilot is not installed):

```typescript
if (typeof vscode.lm?.selectChatModels === 'function') {
  // vscode.lm path
}
if (typeof vscode.lm?.registerLanguageModelChatProvider === 'function') {
  // Phase 2 registration
}
```

The VS Code LM section in the Settings Models tab shows "Requires GitHub Copilot" when `selectChatModels` is unavailable.

### Phased rollout

Phase 1 (read-only probe) is completely behind `vscode.lm.selectChatModels` availability and writes nothing to agent configuration. Phases 2, 3, and 4 each have explicit opt-in flags that default to OFF. No phase auto-enables a subsequent phase.

---

## Migration Path

### For users who already have TeXRA keys in SecretStorage

Existing users who have already entered provider keys in TeXRA's settings panel are unaffected by this integration. The direct-API path (`SecretStorage` → provider SDK) remains the default and is not deprecated. No migration action is required.

When a user later decides to consolidate key management:

1. Open VS Code's "Chat: Manage Language Models" (Command Palette → `Chat: Manage Language Models`).
2. Add the same API key(s) that are currently in TeXRA's settings.
3. Open TeXRA Settings → Models → "VS Code Language Model" section.
4. Enable the "Use VS Code LM for [Provider]" toggle for the desired provider.
5. Optionally remove the corresponding key from TeXRA's settings via the provider key row's "Remove" button.

At step 4, TeXRA's `computeModelOptions.ts` will surface the discovered `vscode.lm` models alongside any direct-API models. Step 5 is optional: if both a direct key and a `vscode.lm` model are present for the same provider, the direct-API key takes precedence when the toggle is OFF; when the toggle is ON, the `vscode.lm`-routed model appears in the picker as a distinct entry (labelled "Via VS Code LM") and the user selects it explicitly.

### For users who have never set TeXRA keys

New users benefit immediately from Phase 1 (discovery probe) by seeing which models are available via `vscode.lm` in the read-only status display. They must explicitly enable the per-provider toggle to use those models. The onboarding flow (if any) may suggest enabling the toggle if a compatible `vscode.lm` model is discovered and no TeXRA key is set for that provider.

### Rollback

Any user who finds the `vscode.lm` path unsatisfactory can toggle it OFF at any time. The direct-API path is immediately restored without loss of data or history.

---

## Capability Degradation Matrix

| Feature                                | Direct API (existing)                                             | Via vscode.lm                                                                   | Mitigation                                                              |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Text streaming                         | Full, token-by-token                                              | Full, chunk-by-chunk                                                            | None needed                                                             |
| Tool calling                           | Full (all providers)                                              | Supported only if model `capabilities.toolCalling === true` (absent = disabled) | Picker warning if tool calling unavailable; agent aborts gracefully     |
| Stop reasons                           | Per-provider typed enum                                           | Inferred from stream end / tool call presence                                   | Treat stream end as `end_turn`; `shouldContinue()` uses heuristic       |
| Token counts (input)                   | Exact from provider response                                      | Estimated via `countTokens()`                                                   | Show "~N tokens (estimated)"; `isEstimatedUsage: true`                  |
| Token counts (output)                  | Exact from provider response                                      | Unavailable                                                                     | Show "N/A"                                                              |
| Cost display                           | Accurate (input+output+cache)                                     | Unavailable                                                                     | "Cost: N/A" label; run summary warning                                  |
| Prompt caching                         | Full (`cache_control`, 5-min and 1-hr TTL)                        | Not available                                                                   | Warning in picker; inform user to use direct key for caching            |
| Cache savings display                  | Accurate (`cache_read_input_tokens`)                              | Unavailable                                                                     | N/A shown                                                               |
| Extended thinking                      | Full (adaptive, effort tiers per model)                           | Not available                                                                   | Thinking slider disabled; warning in picker                             |
| Anthropic beta headers                 | All four beta flags via `@anthropic-ai/sdk`                       | Not expressible                                                                 | Hard block: Anthropic vendor rejected at factory                        |
| Server-side compaction                 | Full (`compaction_delta` stream events, `BetaUsage.iterations[]`) | Not available                                                                   | Compaction disabled; context-window warning at 75%                      |
| System prompt                          | Top-level `system:` field with caching                            | Prepended as first user message in `<system>` tags                              | Documented workaround; system caching lost                              |
| Media attachments (images)             | Full (inline base64 or Files API)                                 | `LanguageModelDataPart` raw bytes if model supports `imageInput`                | Check `capabilities.imageInput`; pass raw bytes; no Files API           |
| PDF upload (Files API)                 | Anthropic Files API with `file_id`                                | Not available                                                                   | Block PDF agents for vscode.lm path                                     |
| Reasoning tokens display               | From provider usage (`reasoningTokens`)                           | Unavailable                                                                     | Show N/A                                                                |
| Per-model reasoning effort             | `thinking.effort` or `reasoning_effort` param per model tier      | Not injectable                                                                  | Effort slider disabled for vscode.lm models                             |
| Batched parallel tool results          | Provider-specific batching (Google, DeepSeek, Kimi, MiniMax)      | Not applicable (those providers hard-blocked)                                   | `requiresBatchedParallelToolResults: false`                             |
| Context compaction eligibility         | `isCompactionEligibleModel()` + `COMPACTION_BETA` header          | Always false                                                                    | No compaction; warn at 75% estimated fill                               |
| Relay tier quota enforcement           | `ServerSideKeyService.canUseModelSync()`                          | Not applicable (key in VS Code)                                                 | N/A                                                                     |
| Model-specific max output tokens       | `llm-zoo` registry (`maxOutputTokens`)                            | Estimated as `maxInputTokens / 4`                                               | Shown as estimated in run summary                                       |
| `addContinueMessageWithPrefill`        | Provider-specific prefill (Anthropic assistant role)              | No prefill; always uses `addContinueMessageWithoutPrefill`                      | Standard continuation prompt used                                       |
| `processThinkingBlock`                 | Returns thinking text (Anthropic, Google, OpenAI o-series)        | Always returns `null`                                                           | N/A                                                                     |
| `extractServerToolData`                | Web search / web fetch results (Anthropic server tools)           | Always returns empty                                                            | N/A                                                                     |
| `createBatchedToolUseFollowUpMessages` | Optional: Google thought-signature batching                       | Not implemented                                                                 | `requiresBatchedParallelToolResults: false`; loop uses single-call path |

---

## Implementation Phases

### Phase 1: Read-only model discovery probe (zero behavior change)

**Scope:** Implement `VscodeLmProbe.ts` and wire it into `extension.ts`. On `onDidChangeChatModels`, call `vscode.lm.selectChatModels()` (all models) and store the resulting `VscodeLmModelCatalog` in `platform().globalState`. Add a read-only "VS Code Language Model" section to the Settings Models tab that displays discovered models, their capabilities, and a link to "Chat: Manage Language Models". No inference is routed through `vscode.lm`. The existing SecretStorage path is completely unchanged.

**Guard:** Entire probe is wrapped in `typeof vscode.lm?.selectChatModels === 'function'`; silently no-ops on VS Code < 1.104.

**Files touched:** `packages/extension/src/frontend/vscodeLm/VscodeLmProbe.ts` (new), `packages/extension/src/extension.ts`, `packages/extension/src/settingsView/frontend/tabs/ModelsTab.ts` (read-only section), `src/shared/schemas/settingsView/data.ts` (new `VSCODE_LM_CATALOG_UPDATED` push message schema), `src/shared/schemas/settingsView/inbound.ts` (no change).

**Success gate:** Settings panel shows discovered `vscode.lm` models with name, vendor, family, and capability flags. No regressions in existing model selection or agent execution. VS Code < 1.104 installs show "Requires VS Code 1.104 or later" in that section.

### Phase 2: TeXRA as LanguageModelChatProvider (exposure, not consumption)

**Scope:** Implement `VscodeLmProviderRegistration.ts`. Register TeXRA as a `LanguageModelChatProvider` with vendor `'texra'`, gated behind `texra.vscodeLm.registerProvider` (default OFF). Expose relay-tier models when the user is logged in with an active Supabase session. Add `contributes.languageModelChatProviders` to `package.json`. Implement `provideLanguageModelChatResponse()` by routing through TeXRA's existing relay inference path. Add `texra.openModelSettings` command.

**Guard:** `typeof vscode.lm?.registerLanguageModelChatProvider === 'function'` and `texra.vscodeLm.registerProvider === true`.

**Files touched:** `packages/extension/src/frontend/vscodeLm/VscodeLmProviderRegistration.ts` (new), `packages/extension/package.json`, `packages/extension/src/commands/settings/openModelSettings.ts` (new), `packages/extension/src/settingsView/frontend/tabs/ModelsTab.ts` (register provider toggle), `src/shared/schemas/settingsView/inbound.ts` (new `SET_VSCODE_LM_REGISTER_PROVIDER` message).

**Success gate:** A user with a TeXRA relay session and `texra.vscodeLm.registerProvider=true` can see TeXRA models in VS Code's "Chat: Model" dropdown. Selecting a TeXRA model in Copilot Chat and sending a message produces a valid response routed through TeXRA's relay. Users without Copilot individual plan see no new models (expected). Feature is otherwise invisible to users who leave the toggle OFF.

### Phase 3: VscodeLmClientPort and VscodeLmModelHandler (OpenAI-compatible path only)

**Scope:** Define `VscodeLmClientPort.ts` interface. Implement `VscodeLmClientAdapter.ts`. Implement `VscodeLmModelHandler` with all `IModelHandler` abstract methods as specified in the class skeleton above. Extend `ModelFactory.ts` to handle `vscodelm:` prefix (hard-block Anthropic and Google vendor values at the factory). Add synthetic `ModelConfig` builder in `vscodeLmModelConfig.ts`. Extend `SdkToolCall` union with `VscodeLmToolCall`. Extend `NormalizedUsageSchema` with `isEstimatedUsage`. **Add `'vscode-lm'` to `UsageProviderSchema`** (required in this phase so `normalizeUsage`'s `provider: 'vscode-lm'` value passes schema validation at runtime). Add per-provider toggle in Settings UI. Add degradation warnings in model picker. Add `VscodeLmModelUnavailableError` and wire its catch in agent runtime.

**Scope constraint:** Anthropic and Google vendor values are rejected at the factory with a clear error. No tool calling in this phase (Phase 4).

**Files touched:** All new files in `src/agent/modelHandlers/vscodeLm/`, `packages/extension/src/frontend/vscodeLm/VscodeLmClientAdapter.ts`, `src/agent/runtime/ModelFactory.ts`, `src/agent/modelHandlers/types/IModelHandler.ts`, `src/agent/types/NormalizedUsage.ts` (both `isEstimatedUsage` addition and `'vscode-lm'` enum value), `src/model/computeModelOptions.ts`, `src/model/vscodeLmModelConfig.ts`, `src/common/errors/VscodeLmModelUnavailableError.ts`, settings webview frontend and message handler, cost display components.

**Success gate:** A user with an OpenAI key in VS Code BYOK and `texra.model.useVsCodeLmForProvider.openai=true` can select "GPT-4o (VS Code LM)" in TeXRA and complete a text-only (non-tool-use) agent task. Cost display shows "N/A". System prompt prepended correctly as first user message. Attempting to select an Anthropic `vscode.lm` model shows an immediate error. Attempting to enable the Anthropic toggle in settings is blocked (no toggle rendered). Zero regressions on the direct-API path.

### Phase 4: Tool calling and image input through vscode.lm

**Scope:** Implement `vscodeLmTools.ts` (`extractToolUse()` and `createToolUseFollowUpMessages()`). Wire tool call / tool result round-tripping through `VscodeLmClientAdapter`. Add `LanguageModelDataPart`-based image attachment (raw bytes) when `capabilities.imageInput === true`. Add capability check at agent-run entry: if the selected `vscode.lm` model reports `toolCalling === false`, disable tool-use and show a warning. Write Vitest tests for the tool-use round-trip using a mock `VscodeLmClientPort`.

**Files touched:** `src/agent/modelHandlers/vscodeLm/vscodeLmTools.ts` (new), `VscodeLmClientAdapter.ts` (extend for tool call emission and image attachment), `src/agent/runtime/` (tool-use capability check for `vscode.lm` models).

**Success gate:** A tool-use agent using a `vscode.lm` GPT-4o model completes a multi-turn tool call sequence. Tool result re-submission uses correct Assistant[toolCall] + User[toolResult] pattern. Models with `toolCalling !== true` (i.e. `false` or absent) abort gracefully with a clear error. Vitest tests pass for the tool-use round-trip mock.

### Phase 5: Observability, hardening, and llm-zoo PR

**Scope:** Add `onDidChangeChatModels` reactive refresh (picker updates within 2 seconds of catalog change). File a PR to `llm-zoo` to add `ModelProvider.VSCODE_LM` (and the `isVscodeLmBacked` capability flag), then remove the inline shim from `ModelFactory.ts` and the capability cast in `VscodeLmModelHandler`. Add integration tests using a mock `VscodeLmClientPort` for the full agent run cycle (text-only + tool-use). Publish documentation "Using VS Code Language Model API with TeXRA" covering setup, limitations, and comparison with direct API keys. (Note: `'vscode-lm'` was added to `UsageProviderSchema` in Phase 3 to match `normalizeUsage`'s output; no schema change needed here.)

**Files touched:** `packages/extension/src/extension.ts` (reactive catalog refresh), `src/agent/runtime/ModelFactory.ts` (remove shim once llm-zoo PR merged), test files in `src/test-kernel/`.

**Success gate:** `onDidChangeChatModels` causes the TeXRA model picker to reflect newly added/removed VS Code LM models within 2 seconds. The `llm-zoo` PR is merged and the shim is removed with TypeScript exhaustiveness checking re-validated. All Vitest tests pass. Zero regressions in the direct-API path for all existing providers.

---

## Open Questions

1. **Anthropic provider commitment to beta-header pass-through.** Has the VS Code built-in Anthropic BYOK provider extension committed to forwarding any fields from `LanguageModelChatRequestOptions.modelOptions` as HTTP request body fields or HTTP headers? Without this commitment from the Anthropic VS Code provider team, the Anthropic hard-block (Phase 3) cannot be lifted regardless of TeXRA engineering effort. _Action: file a question on the VS Code GitHub Discussions for the Anthropic BYOK provider extension before Phase 3 ships._

2. **llm-zoo PR timeline.** The synthetic `ModelConfig` shim in `ModelFactory.ts` is a maintenance liability because `PROVIDER_HANDLER_ROUTES` is typed `Record<ModelProvider, ProviderHandlerRoute>` and a new enum value without an entry will cause a typecheck failure in that record. Should TeXRA temporarily fork `llm-zoo` to unblock Phase 3, or hold Phase 3 until the upstream merge? _Decision needed before Phase 3 starts._

3. **Business/Enterprise user exclusion.** Microsoft's current documentation states that third-party `LanguageModelChatProvider` registrations are only visible to individual Copilot plan users (Free, Pro, Pro+). TeXRA's academic user base includes many institutional VS Code deployments. Should Phase 2 be held until Microsoft lifts this restriction, or ship as-is behind `texra.vscodeLm.registerProvider` (default OFF) with the tooltip caveat? _Current proposal: ship with default OFF and the caveat. Revisit when Microsoft documents a change._

4. **Copilot-vendor model consent dialog in background tasks.** If a user running a background TeXRA agent task has a Copilot-vendor model selected as their `vscode.lm` model, `selectChatModels({vendor:'copilot'})` may trigger a blocking consent dialog. The current design hard-blocks `vendor='copilot'` in all agent tasks. Should TeXRA allow Copilot-vendor models with a synchronous user confirmation gate at task-start time? _Current proposal: hard-block. Revisit in a follow-on PRD._

5. **Token estimation accuracy near context limits.** `LanguageModelChat.countTokens()` is documented as an estimate. For TeXRA agents that operate near context window limits (long-context PDF processing), estimation errors could lead to context overflow without warning. Should Phase 1 include a calibration study comparing `countTokens()` estimates to actual token counts across model families before the context-warning heuristic (75% of `maxInputTokens`) is shipped? _Recommendation: yes, validate on at least GPT-4o and one Ollama model before Phase 4 ships._

6. **Relay path vs vscode.lm path priority.** If a user has both a TeXRA relay subscription and VS Code BYOK keys configured for the same provider, which path takes precedence? The current design makes `useVsCodeLmForProvider` the explicit switch, with relay being the TeXRA default when the switch is OFF. A user with the switch ON sees `vscode.lm`-routed models in the picker as distinct entries (labelled "Via VS Code LM"); relay models appear as separate entries. Both are available simultaneously. _No action needed; this is the intended behavior._

7. **Headless CLI behavior when default model is a `vscodelm:` value.** `texra run` and `texra --print` paths in `packages/cli/` cannot call `vscode.lm` APIs (unavailable outside the VS Code extension host). If a user's default model is set to a `vscodelm:` prefixed value, the CLI will encounter an unroutable model. _Current proposal: CLI's `createModelHandler()` detects the `vscodelm:` prefix and throws immediately with "VS Code LM models are not available in the TeXRA CLI. Set a non-vscode-lm model as default or pass --model explicitly." No silent fallback._

8. **VS Code version floor and `engines.vscode`.** _(Resolved.)_ This question is moot: `engines.vscode` is already `^1.105.0`, which satisfies the 1.104+ requirement. The capability-check guards remain in place for environments where the `vscode.lm` API may be absent despite the version floor (e.g. Copilot not installed). No minimum version bump is needed.

9. **`extractResponse` streaming contract mismatch.** The `Resp` type parameter for `VscodeLmModelHandler` is `AsyncIterable<VscodeLmResponseChunk>`, but `extractResponse()` cannot re-iterate a consumed stream. The resolved design (accumulate in `createResponseImpl`, read accumulated data in `extractResponse`) deviates from the pattern used by other handlers. _This must be explicitly documented in the class and raised in code review. If the `ModelHandler` base class is ever refactored to separate streaming from extraction, this handler should be updated._

---

## Success Metrics

**Adoption:**

- 15% of active TeXRA extension users have at least one `vscode.lm`-routed model enabled within 60 days of release.
- Median time from TeXRA install to first successful agent run decreases by at least 20% for users who have VS Code BYOK keys configured (measured via opt-in telemetry comparing cohorts).

**Stability:**

- Zero crashes attributable to `VscodeLmModelHandler` in the 30 days post-release (measured from crash reporter).
- `VscodeLmModelUnavailableError` surfaces a user-visible error notification in at least 99% of cases (no silent failures), verified by checking that the `vscodeLmModelUnavailable` progress event always results in a VS Code notification.

**Model exposure:**

- TeXRA's `LanguageModelChatProvider` registration is confirmed working (models appear in VS Code model picker) for at least 95% of VS Code 1.104+ individual Copilot plan users with an active TeXRA relay session.

**Feature coverage:**

- Tool-use agents complete successfully through `vscode.lm` for models reporting `capabilities.toolCalling === true` at least 95% success rate (measured by Phase 4 telemetry).

**Degradation awareness:**

- The capability degradation warning is explicitly dismissed (not just closed without reading) by at least 80% of users who encounter it, measured by dismiss-vs-close event telemetry.
- Support tickets citing "unexpected $0.00 cost display" or "cost shows zero" reach zero after the "N/A" cost label and `isEstimatedUsage` warning banner are deployed.
