---
created: 2026-02-05
updated: 2026-02-10
---

# Plan: Server-Side Compaction via `compact_20260112` API

## Status: Proposed (Blocked — SDK types not available; PRD recommends client-side instead)

## Date: 2026-02-05

## Prerequisite: Anthropic SDK ships `compact_20260112` types (currently v0.72.1 does NOT include them)

---

> **PRD Decision:** The main PRD (`docs/prds/2026-02-02-prd-context-compactization.md`, Section 4.6) explicitly chose **client-side summarization** over server-side compaction for Anthropic. Reasons cited:
>
> - Server-side compaction is **opaque** — no visibility into what was preserved
> - Server-side uses the **same expensive model** for summarization (Opus at ~$12/200K)
> - **Inconsistent** — only works on Opus 4.6, not Sonnet/Haiku
> - **No user control** — can't inspect or override the summary
>
> This plan is preserved as a **reference and future option**, not a recommended near-term approach. Implement `docs/prds/2026-02-05-plan-claude-client-compactization.md` first.

---

## 1. Summary

Add server-side compaction to `ModelHandlerAnthropic` using Anthropic's native `compact_20260112` context management edit. This is an **optional upgrade path** for models that support it (currently Opus 4.6 only). When active, the API handles compaction automatically within the same request — no separate API call needed.

**This plan is doubly blocked:**

1. **SDK types not available** — The current SDK (v0.72.1) only supports `BetaClearToolUses20250919Edit` and `BetaClearThinking20251015Edit` in `BetaContextManagementConfig.edits`. Implementing without types would require extensive type augmentation.
2. **PRD recommends against it** — The PRD's architecture (Section 4.6) uses client-side for all providers except OpenAI Responses. Adopting server-side for Anthropic would deviate from the PRD's design.

**Relationship to client-side plan:** Client-side compaction (`docs/prds/2026-02-05-plan-claude-client-compactization.md`) is the **primary and recommended** approach. This plan documents the server-side API for reference and as a potential future optimization if the trade-offs shift (e.g., server-side summary quality proves significantly better, or cost becomes comparable).

---

## 2. API Overview

From `docs/prds/2026-02-05-claude-documentation-compactization.md`:

### How it works

1. Add `{ type: 'compact_20260112' }` to `context_management.edits`
2. Include beta header: `compact-2026-01-12`
3. When input tokens exceed trigger threshold (default 150K, min 50K):
   - API generates a summary → returns `compaction` block in `content[]`
   - Continues generating the actual response after the compaction block
4. On subsequent requests, pass the `compaction` block back in assistant messages
5. API automatically drops all messages prior to the last `compaction` block

### Key API parameters

| Parameter                | Type                                      | Default  | Description                                    |
| ------------------------ | ----------------------------------------- | -------- | ---------------------------------------------- |
| `type`                   | string                                    | Required | `"compact_20260112"`                           |
| `trigger`                | `{ type: "input_tokens", value: number }` | 150,000  | Min 50,000                                     |
| `pause_after_compaction` | boolean                                   | `false`  | Pause to allow message injection               |
| `instructions`           | string                                    | null     | Custom summarization prompt (replaces default) |

### Response shape when compaction fires

```json
{
  "content": [
    { "type": "compaction", "content": "Summary of conversation..." },
    { "type": "text", "text": "Based on our conversation so far..." }
  ],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 45000,
    "output_tokens": 1234,
    "iterations": [
      { "type": "compaction", "input_tokens": 180000, "output_tokens": 3500 },
      { "type": "message", "input_tokens": 23000, "output_tokens": 1000 }
    ]
  }
}
```

### Streaming shape

- `content_block_start`: `content_block.type === "compaction"`
- `content_block_delta`: `delta.type === "compaction_delta"` (single delta with complete content, not streamed incrementally)
- `content_block_stop`: compaction block complete

### Supported models

- Claude Opus 4.6 only (as of 2026-02)

---

## 3. SDK Gap Analysis

### What's missing in SDK v0.72.1

| Type/Feature                 | Expected                                         | Current SDK | Impact                                                |
| ---------------------------- | ------------------------------------------------ | ----------- | ----------------------------------------------------- |
| `BetaCompact20260112Edit`    | Edit type for `context_management.edits`         | Not present | Can't add compaction edit without type assertion      |
| `BetaCompactionContentBlock` | Content block type for `compaction`              | Not present | Can't type-safely check `block.type === 'compaction'` |
| `BetaCompactionDelta`        | Streaming delta for `compaction_delta`           | Not present | Stream handler can't match the delta type             |
| `iterations` on `BetaUsage`  | Array of `{ type, input_tokens, output_tokens }` | Not present | Can't access iteration-level usage for billing        |
| `"compaction"` stop reason   | New stop reason value                            | Not in enum | Can't check `response.stop_reason === 'compaction'`   |

### What DOES exist

- `BetaContextManagementConfig` — has `edits` array, can be extended
- `BetaInputTokensTrigger` — trigger type already exists (used by clearing)
- `ensureBeta()` — helper already handles adding beta headers
- `CONTEXT_MANAGEMENT_BETA` — existing beta constant pattern
- `logContextManagementFromResponse()` — existing response parsing can be extended

### Workaround (type assertions)

Everything works at the API level with the beta header. The gap is TypeScript types only:

```typescript
// Would work at runtime, fails at compile time:
contextManagementEdits.push({
  type: 'compact_20260112', // TS error: not in union type
  trigger: { type: 'input_tokens', value: 180000 },
} as any); // Requires `as any` or type augmentation
```

**Decision:** Wait for SDK types rather than use `as any` throughout. The client-side plan covers the immediate need. Type safety is important for maintainability.

---

## 4. Design

### 4.1 Model Eligibility Check

```typescript
private supportsNativeCompaction(): boolean {
  // Check if model ID contains opus-4-6 (or later models when added)
  return this.config.fullName.includes('claude-opus-4-6');
}
```

### 4.2 Adding Compaction to `setupContextManagement()`

The compaction edit goes **after** clearing edits. The API processes edits in order:

```typescript
// In setupContextManagement(), after existing clearing edits:
if (this.supportsNativeCompaction()) {
  this.ensureBeta(options, COMPACTION_BETA); // 'compact-2026-01-12'

  // Compaction trigger higher than clearing trigger:
  // clearing at thresholdPercent (75%), compaction at min(threshold+15, 95)%
  const compactionPercent = Math.min(thresholdPercent + 15, 95);
  const compactionTriggerTokens = Math.floor(
    (compactionPercent / 100) * contextWindow,
  );

  contextManagementEdits.push({
    type: 'compact_20260112',
    trigger: {
      type: 'input_tokens',
      value: compactionTriggerTokens,
    },
    instructions: ANTHROPIC_COMPACTION_INSTRUCTIONS,
  });
}
```

### 4.3 Layered Trigger Thresholds

```
Layer 1: Server-side clearing at 75%  (free, removes tool uses + thinking)
Layer 2: Server-side compaction at 90%  (costs a sampling iteration, summarizes)
Layer 3: Client-side compaction at 75%  (separate API call, fallback)
Layer 4: Hard fail at 100%  (validateTokenLimits throws)
```

**Interaction between server-side compaction (90%) and client-side compaction (75%):**

- On a request where input is 85%: clearing fires (75%), drops to ~70%. Neither compaction fires. Normal response.
- On a request where input is 92%: clearing fires, still at ~88%. Server-side compaction fires at 90%. Summary generated server-side. After response: client-side check sees post-compaction usage is now low → skips.
- If server-side compaction is unavailable (non-Opus model): clearing fires at 75%. After response: client-side check at 75% fires instead.

**Key rule:** When server-side compaction is enabled, client-side compaction should be **suppressed** for that handler to avoid double-compaction. Add a flag:

```typescript
private get hasServerSideCompaction(): boolean {
  return this.supportsNativeCompaction() &&
    this.getCompactionThresholdPercent() > 0;
}

private shouldCompact(): boolean {
  if (this.hasServerSideCompaction) return false;  // Server handles it
  // ... existing client-side check ...
}
```

### 4.4 Custom Summarization Instructions

The server-side API uses a different default prompt than the SDK's client-side one. The server default is:

```
You have written a partial transcript for the initial task above. Please write a
summary of the transcript. The purpose of this summary is to provide continuity
so you can continue to make progress towards solving the task in a future context,
where the raw history above may not be accessible and will be replaced with this
summary. Write down anything that would be helpful, including the state, next
steps, learnings etc. You must wrap your summary in a <summary></summary> block.
```

Override with TeXRA-specific instructions:

```typescript
const ANTHROPIC_COMPACTION_INSTRUCTIONS = `Summarize the conversation for continuation. Preserve:
1. The user's core task and success criteria
2. Files created/modified (with paths)
3. Key decisions, errors encountered, and their resolutions
4. Current progress and next steps
5. LaTeX-specific context (packages, document class, citation keys, formatting preferences)
Write concisely for immediate task resumption.
Wrap your summary in <summary></summary> tags.`;
```

### 4.5 Response Handling: Compaction Blocks

When compaction fires, `response.content` includes a `compaction` block:

```json
[
  { "type": "compaction", "content": "Summary..." },
  { "type": "text", "text": "Actual response..." }
]
```

**No message array surgery needed.** The existing code path:

1. `extractResponse()` — already filters for `type === 'text'` only → compaction blocks excluded from user-visible output
2. `extractAssistantContent()` — already preserves all non-`tool_use` blocks → compaction blocks included in messages
3. `createToolUseFollowUpMessages()` — already appends `response.content` as assistant message → compaction blocks flow through

The API automatically drops messages before the last `compaction` block on subsequent requests. So the messages array grows with compaction blocks and old context, but the API only processes post-compaction content.

### 4.6 Streaming: New Event Types

`AnthropicStreamHandler` needs to handle compaction-specific events:

```typescript
// In event handler:
case 'content_block_start':
  if (event.content_block.type === 'compaction') {
    this.logger.debug('Compaction block started in stream');
    // Do NOT stream to user — compaction content is internal
  }
  break;

case 'content_block_delta':
  if (event.delta.type === 'compaction_delta') {
    this.logger.debug(
      `Compaction summary: ${event.delta.content.length} chars`,
    );
    // Single delta with complete content, not incremental
    // Captured in finalMessage — no need to buffer
  }
  break;
```

Compaction blocks are **not streamed to the user**. They're context management artifacts. The stream handler logs them but doesn't pipe to the output stream.

### 4.7 Usage Tracking: Iterations Array

When compaction occurs, `response.usage` includes an `iterations` array:

```json
{
  "input_tokens": 45000, // Excludes compaction iteration
  "output_tokens": 1234, // Excludes compaction iteration
  "iterations": [
    { "type": "compaction", "input_tokens": 180000, "output_tokens": 3500 },
    { "type": "message", "input_tokens": 23000, "output_tokens": 1000 }
  ]
}
```

**Critical:** Top-level tokens **exclude** compaction. Total cost requires summing iterations.

```typescript
normalizeUsage(rawUsage: BetaUsage, responseTimeMs: number): NormalizedUsage {
  // Check for compaction iterations
  const iterations = (rawUsage as BetaUsage & {
    iterations?: Array<{
      type: string;
      input_tokens: number;
      output_tokens: number;
    }>;
  }).iterations;

  if (iterations?.length) {
    let totalInput = 0;
    let totalOutput = 0;
    for (const iter of iterations) {
      totalInput += iter.input_tokens;
      totalOutput += iter.output_tokens;
    }
    // Use iteration totals for accurate billing
    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cost: calculateTokenPrice(
        totalInput, totalOutput,
        this.config.inputPrice, this.config.outputPrice,
      ),
      responseTimeMs,
    };
  }

  // Non-compaction response: existing logic
  // ...
}
```

### 4.8 Logging Compaction Events

Extend `logContextManagementFromResponse()` to detect compaction:

```typescript
// After existing clearing logic:
const compactionBlock = response.content.find(
  (block) => (block as { type: string }).type === 'compaction',
);

if (compactionBlock) {
  const compactionContent = (compactionBlock as { content: string }).content;

  // Get pre-compaction tokens from iterations array
  const iterations = (response.usage as any).iterations as
    Array<{ type: string; input_tokens: number }> | undefined;
  const compactionIteration = iterations?.find((i) => i.type === 'compaction');
  const tokensBefore = compactionIteration?.input_tokens ?? totalInputTokens;

  this.logger.logContextManagement(
    `Server-side compaction: conversation summarized`,
    {
      action: 'compaction',
      tokensBefore,
      tokensAfter: response.usage.input_tokens,
      contextWindow,
      utilizationBefore: (tokensBefore / contextWindow) * 100,
      utilizationAfter: (response.usage.input_tokens / contextWindow) * 100,
      details: `Anthropic native compaction (model: ${this.config.fullName})`,
    },
  );
}
```

### 4.9 `pause_after_compaction`

**Use `false` (default).** Reasons:

- Simplest integration — compaction + response in one API call
- No need to inject context between compaction and response
- System prompt is preserved automatically
- The `compaction` block in `content[]` carries forward automatically

The `pause_after_compaction: true` flow is complex (requires handling `stop_reason: 'compaction'`, reconstructing messages, making a second API call). Only needed for advanced use cases like preserving specific recent messages verbatim.

### 4.10 Prompt Caching on Compaction Blocks

The API supports `cache_control` on compaction blocks:

```json
{
  "type": "compaction",
  "content": "[summary]",
  "cache_control": { "type": "ephemeral" }
}
```

This caches the system prompt + summary, avoiding re-processing on subsequent requests. Worth adding when `extractAssistantContent()` preserves compaction blocks:

```typescript
// In extractAssistantContent(), add cache_control to compaction blocks:
return responseObject.content
  .filter((block) => block.type !== 'tool_use')
  .map((block) => {
    if ((block as any).type === 'compaction') {
      return { ...block, cache_control: { type: 'ephemeral' } };
    }
    return block;
  });
```

---

## 5. Implementation Steps

### Step 1: Beta constant and model check

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

```typescript
const COMPACTION_BETA: AnthropicBeta = 'compact-2026-01-12';

private supportsNativeCompaction(): boolean {
  return this.config.fullName.includes('claude-opus-4-6');
}
```

### Step 2: Add compaction edit to `setupContextManagement()`

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

After existing clearing edits, conditionally add `compact_20260112` with custom trigger and instructions. Requires SDK types for `compact_20260112` edit.

### Step 3: Suppress client-side compaction for server-side models

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Add `hasServerSideCompaction` check in `shouldCompact()` to prevent double-compaction.

### Step 4: Log compaction from response

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Extend `logContextManagementFromResponse()` to detect `compaction` blocks in `response.content` and log as context management event.

### Step 5: Handle streaming compaction events

**File:** `src/agent/modelHandlers/support/AnthropicStreamHandler.ts`

Add `compaction` content block start and `compaction_delta` delta handling. Log but don't stream to user.

### Step 6: Update `normalizeUsage()` for iterations

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Sum across `iterations` array when present for accurate billing.

### Step 7: Add cache_control to compaction blocks (optional)

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

In `extractAssistantContent()`, add `cache_control: { type: 'ephemeral' }` to compaction blocks for prompt caching.

### Step 8: Schema + UI enrichment (optional)

Same as client-side plan Steps 6-7.

---

## 6. What Changes vs Client-Side

| Aspect               | Client-Side (Recommended)                   | Server-Side (This Plan)                                  |
| -------------------- | ------------------------------------------- | -------------------------------------------------------- |
| When compaction runs | After `createResponse()`, separate API call | During `createResponse()`, same API call                 |
| Who summarizes       | Sonnet (capable + cheaper model)            | Same model (Opus 4.6)                                    |
| Message management   | Replace all messages with summary           | API drops old messages; `compaction` block preserved     |
| Streaming            | No impact                                   | New event types to handle                                |
| Usage tracking       | Standard (separate call)                    | `iterations` array to parse                              |
| Cost                 | Sonnet pricing (~$0.60/200K)                | Opus pricing (~$12/200K)                                 |
| Model support        | All Anthropic models                        | Opus 4.6 only                                            |
| SDK requirement      | None (uses standard API)                    | SDK types for `compact_20260112`                         |
| Summary visibility   | Full — summary is a user message            | Opaque — `compaction` block content visible in logs only |
| User control         | Summary in message history, can re-compact  | API decides what to summarize                            |
| PRD alignment        | Matches PRD Section 4.6                     | Deviates from PRD architecture                           |

**Recommendation:** Client-side is preferred for all the reasons in the PRD. Server-side may be reconsidered if:

- Summary quality with Sonnet proves insufficient for complex LaTeX research contexts
- Anthropic adds visibility features to server-side compaction
- Cost differential narrows (e.g., compaction uses a cheaper model server-side)

---

## 7. Risks and Mitigations

| Risk                        | Mitigation                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| **SDK types not available** | Plan is blocked until SDK ships types. Client-side covers immediate need.                 |
| **Opus-only**               | `supportsNativeCompaction()` guard. Client-side fallback for other models.                |
| **Cost**                    | Same model for summarization (~$12/200K Opus). Layered thresholds minimize frequency.     |
| **Type assertions fragile** | Wait for proper SDK types rather than `as any`. Track SDK releases.                       |
| **Double-compaction**       | `hasServerSideCompaction` flag suppresses client-side when server-side active.            |
| **Streaming edge cases**    | Log defensively; final message captures compaction block regardless of stream events.     |
| **iterations billing**      | `normalizeUsage()` updated to sum iterations. Falls back to top-level when no iterations. |

---

## 8. Testing Strategy

1. **`supportsNativeCompaction()`** — True for `claude-opus-4-6`, false for sonnet/haiku.
2. **`setupContextManagement()`** — Verify `compact_20260112` edit added for Opus 4.6. Verify trigger at 90%. Verify NOT added for other models.
3. **`shouldCompact()` suppression** — Verify client-side compaction disabled when server-side active.
4. **Response handling** — Mock response with `compaction` + `text` blocks. Verify `extractResponse()` returns text only. Verify `extractAssistantContent()` preserves compaction. Verify logging.
5. **Usage normalization** — Mock response with `iterations`. Verify total = sum of iterations.
6. **Streaming** — Mock `compaction` content block events. Verify no stream output, only logging.
7. **Manual test** — Opus 4.6 conversation exceeding 90% context. Verify compaction fires server-side, summary in progress view, conversation continues.

---

## 9. Unblocking Criteria

This plan requires **BOTH** technical and architectural unblocking:

### Technical (SDK types)

One of these must be true:

1. **Anthropic SDK releases types for `compact_20260112`** — Check each SDK release for `BetaCompact20260112Edit` or similar types in `resources/beta/messages/messages.d.ts`.

2. **Anthropic moves compaction out of beta** — Would land in stable `messages` types instead of beta.

3. **Decision to proceed with type assertions** — If the team decides type safety trade-off is acceptable, can proceed with `as any` assertions. Not recommended for long-term maintenance.

To check: `npm info @anthropic-ai/sdk version` and review changelog for compaction/compact references.

### Architectural (PRD alignment)

The PRD (Section 4.6) currently recommends client-side for Anthropic. To proceed with server-side, one of these must be true:

1. **Client-side summary quality proves insufficient** — E.g., Sonnet summaries lose critical LaTeX research context that Opus preserves server-side. This would be evaluated after client-side is deployed.

2. **PRD is updated to allow server-side for Opus 4.6** — The team explicitly revises the architecture to use server-side for Opus while keeping client-side as fallback for other models.

3. **Server-side adds transparency** — Anthropic adds features that make server-side compaction visible (e.g., returning the full summary text, allowing custom extraction).

---

## 10. Implementation Order (When Unblocked)

1. **Beta constant + model check** (Step 1)
2. **setupContextManagement extension** (Step 2) — Feature-gated by model check
3. **Suppress client-side** (Step 3) — Prevent double-compaction
4. **Response logging** (Step 4) — Visibility into server-side compaction
5. **Streaming handler** (Step 5) — Prevent stream errors
6. **Usage tracking** (Step 6) — Accurate billing
7. **Prompt caching** (Step 7) — Cost optimization
8. **Schema + UI** (Step 8) — Polish

Steps 1-5 = MVP. Steps 6-8 = refinements.
