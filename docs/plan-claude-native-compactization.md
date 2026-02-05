# Plan: Claude Compactization for ModelHandlerAnthropic

## Status: Proposed

## Date: 2026-02-05

---

## 1. Context and Motivation

The existing PRD (`docs/prd-context-compactization.md`) proposes **client-side summarization** for the Anthropic handler — sending conversation history to a cheaper model for summarization. Anthropic has also published documentation for a **native server-side compaction API** (`docs/prd/claude-documentation-compactization-2026-02.md`).

This plan evaluates both approaches and recommends an implementation strategy.

### 1.1 SDK State (v0.72.1)

The Anthropic Node SDK (`@anthropic-ai/sdk@0.72.1`) provides two compaction-related features:

**A. Client-side `CompactionControl` (available now)**
- Located in `lib/tools/CompactionControl.ts` and `lib/tools/BetaToolRunner.ts`
- Used by the SDK's `BetaToolRunner` for automatic client-side compaction
- `_checkAndCompact()` method: checks token usage → calls API with summary prompt → replaces messages with summary
- `DEFAULT_SUMMARY_PROMPT`: Structured 5-section prompt for continuation summaries
- `DEFAULT_TOKEN_THRESHOLD`: 100,000 tokens
- Replaces all messages with a single user message containing the model's summary

**B. Server-side `compact_20260112` API (NOT in SDK types)**
- Documented in `docs/prd/claude-documentation-compactization-2026-02.md`
- Beta header: `compact-2026-01-12`
- No TypeScript types exist in SDK v0.72.1:
  - `BetaContextManagementConfig.edits` only accepts `BetaClearToolUses20250919Edit | BetaClearThinking20251015Edit`
  - No `compaction` content block type in `BetaContentBlock`
  - No `compaction_delta` in streaming event types
  - No `iterations` field in `BetaUsage`
- Would require extensive type augmentation to use

### 1.2 Approach Comparison

| Dimension | Client-Side (SDK Pattern) | Server-Side (`compact_20260112`) |
|---|---|---|
| SDK support | Types available (CompactionControl) | No types in v0.72.1 |
| Implementation | Follow `BetaToolRunner._checkAndCompact()` | Type augmentations + beta header |
| Integration point | Before `createResponse()` call | Inside `context_management.edits` |
| Summary visibility | Transparent (stored as user message) | Transparent (`compaction` block) |
| Compactor model | Configurable (e.g., Haiku for cost) | Same model only (no cheaper option) |
| Streaming impact | None (separate blocking call) | New event types to handle |
| Message management | Replace all messages with summary | API auto-drops old messages |
| Works with clearing | Independent (runs before API call) | Integrated (API applies clearing then compact) |
| Supported models | Any model (client does the work) | Opus 4.6 only |
| Cost control | Can use cheaper model for summary | Full-price sampling iteration |

### 1.3 Recommendation

**Use client-side compaction** following the SDK's `BetaToolRunner._checkAndCompact()` pattern. Reasons:

1. **Works today** — No SDK type gaps. The pattern is proven in the SDK itself.
2. **Cost efficiency** — Can use a cheaper model (e.g., Haiku) for summarization.
3. **All models** — Works for all Anthropic models, not just Opus 4.6.
4. **Consistency** — Same approach proposed in the main PRD for other providers. The compaction logic is provider-agnostic.
5. **Complements clearing** — Runs before the API call, independent of server-side clearing. Both can coexist.

**Future upgrade path:** When SDK v0.73+ ships with `compact_20260112` types, evaluate switching Opus 4.6 to server-side compaction for simpler integration. The client-side approach is not throwaway — it remains needed for non-Opus models.

---

## 2. Current State Analysis

### 2.1 What `ModelHandlerAnthropic` Already Has

The handler (`src/agent/modelHandlers/modelHandlerAnthropic.ts`) has:

1. **`setupContextManagement()`** (line 288): Configures `context_management.edits` with:
   - `clear_tool_uses_20250919`: Removes old tool use/result pairs (keeps last 3)
   - `clear_thinking_20251015`: Removes old thinking blocks (keeps last 3 turns)
   - Trigger at `thresholdPercent` of context window (default 75%)

2. **`logContextManagementFromResponse()`** (line 800): Parses `response.context_management.applied_edits` and logs clearing events.

3. **`estimateTokenCount()`** (line 422): Calls `client.beta.messages.countTokens()` with full params including `context_management`.

4. **Beta header management**: `ensureBeta()` helper, `CONTEXT_MANAGEMENT_BETA` constant.

5. **Token validation flow**: `createResponse()` follows Build → Count → Validate → Execute phases.

6. **`measuredInputTokens`** (line 517): Tracked inside `createResponse()` — stores the last measured token count.

### 2.2 SDK's `BetaToolRunner._checkAndCompact()` (Reference Implementation)

From `node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.js` (lines 65-133):

```javascript
async _checkAndCompact() {
  const compactionControl = this.params.compactionControl;
  if (!compactionControl || !compactionControl.enabled) return false;

  // 1. Get total tokens from last response
  let tokensUsed = 0;
  const message = await this._message;
  const totalInputTokens = message.usage.input_tokens
    + (message.usage.cache_creation_input_tokens ?? 0)
    + (message.usage.cache_read_input_tokens ?? 0);
  tokensUsed = totalInputTokens + message.usage.output_tokens;

  // 2. Check threshold
  const threshold = compactionControl.contextTokenThreshold ?? 100000;
  if (tokensUsed < threshold) return false;

  // 3. Clean last assistant message (remove pending tool_use blocks)
  const messages = this.params.messages;
  if (messages.at(-1).role === 'assistant') {
    const lastMsg = messages.at(-1);
    if (Array.isArray(lastMsg.content)) {
      const nonToolBlocks = lastMsg.content.filter(b => b.type !== 'tool_use');
      if (nonToolBlocks.length === 0) messages.pop();
      else lastMsg.content = nonToolBlocks;
    }
  }

  // 4. Call API with summary prompt appended
  const response = await client.beta.messages.create({
    model: compactionControl.model ?? this.params.model,
    messages: [...messages, { role: 'user', content: [{ type: 'text', text: summaryPrompt }] }],
    max_tokens: this.params.max_tokens,
  }, { headers: { 'x-stainless-helper': 'compaction' } });

  // 5. Replace ALL messages with single user message containing summary
  this.params.messages = [{ role: 'user', content: response.content }];
  return true;
}
```

### 2.3 What the OpenAI Response Handler Does (Other Reference)

The OpenAI handler (`src/agent/modelHandlers/modelHandlerOpenAIResponse.ts`) implements compaction as:

1. **`conversationState`** (line 300): Tracks `sentMessages`, `cumulativeInputTokens`, `isCompacted`.
2. **`shouldCompact()`** (line 475): Checks cumulative tokens vs threshold.
3. **`compactConversation()`** (line 542): Calls `client.responses.compact()`, logs event, stores result.
4. **`applyCompactionState()`** (line 619): Resets state after successful API call.
5. **Integration in `createResponse()`** (line 1030): Check → compact → clear previousResponseId → send compacted messages.
6. **Return `updatedMessages`**: When compaction occurs, returns the new messages so the calling flow can update its state.

### 2.4 Gap: What's Missing for Anthropic Compaction

- No cumulative token tracking across calls (no `conversationState`)
- No `shouldCompact()` check
- No compaction call (no `compactConversation()`)
- No message replacement after compaction
- No `updatedMessages` return from `createResponse()`
- No compaction event logging with summary text

---

## 3. Design

### 3.1 Compaction Flow

Compaction happens **before** the API call in `createResponse()`, following the same pattern as the OpenAI handler:

```
createResponse() called
  ├─ Phase 0: CHECK COMPACTION (NEW)
  │   ├─ Check: cumulativeInputTokens > threshold?
  │   ├─ If yes: call compaction model with messages + summary prompt
  │   ├─ Replace messages with [{ role: 'user', content: summary }]
  │   └─ Log compaction event
  ├─ Phase 1: BUILD (existing)
  ├─ Phase 2: COUNT (existing)  ← token count now reflects compacted messages
  ├─ Phase 3: VALIDATE (existing)
  └─ Phase 4: EXECUTE (existing)
```

### 3.2 Compaction Decision

Track cumulative input tokens from API response usage (same pattern as OpenAI handler):

```typescript
private compactionState = {
  /** Cumulative input tokens from most recent API response */
  cumulativeInputTokens: 0,
};
```

Updated after each successful `createResponse()` from `response.usage`:

```typescript
// After API response received:
const totalInputTokens = response.usage.input_tokens
  + (response.usage.cache_read_input_tokens ?? 0)
  + (response.usage.cache_creation_input_tokens ?? 0);
this.compactionState.cumulativeInputTokens = totalInputTokens;
```

Trigger check:

```typescript
private shouldCompact(): boolean {
  const thresholdPercent = getConfig<number>(
    'texra.model.compactionThresholdPercent',
    DEFAULT_COMPACTION_THRESHOLD_PERCENT, // 75
  );
  if (thresholdPercent <= 0) return false;

  const threshold = Math.floor(
    (thresholdPercent / 100) * this.config.contextWindow,
  );
  return this.compactionState.cumulativeInputTokens > threshold;
}
```

### 3.3 Compaction Execution

Follow the SDK's `_checkAndCompact()` pattern adapted for TeXRA:

```typescript
private async compactConversation(
  client: Anthropic,
  messages: MessageParam[],
  systemPrompt?: string,
): Promise<{ compacted: boolean; newMessages: MessageParam[]; summary?: string }> {
  const tokensBefore = this.compactionState.cumulativeInputTokens;
  const contextWindow = this.config.contextWindow;

  // 1. Clean last assistant message (remove pending tool_use blocks)
  const cleanedMessages = [...messages];
  const lastMsg = cleanedMessages.at(-1);
  if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
    const nonToolBlocks = lastMsg.content.filter(
      (b: ContentBlockParam) => b.type !== 'tool_use',
    );
    if (nonToolBlocks.length === 0) {
      cleanedMessages.pop();
    } else {
      cleanedMessages[cleanedMessages.length - 1] = {
        ...lastMsg,
        content: nonToolBlocks,
      };
    }
  }

  // 2. Append summary prompt as user message
  cleanedMessages.push({
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_SUMMARY_PROMPT }],
  });

  // 3. Call API (non-streaming) with compaction model
  const compactionModel = this.getCompactionModel();
  const response = await client.beta.messages.create({
    model: compactionModel,
    messages: cleanedMessages,
    max_tokens: 8192,
    ...(systemPrompt && { system: systemPrompt }),
  });

  // 4. Extract summary text
  const summaryBlock = response.content.find(
    (b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text',
  );
  if (!summaryBlock) {
    this.logger.warn('Compaction produced no text response; keeping original messages');
    return { compacted: false, newMessages: messages };
  }

  const summary = summaryBlock.text;
  const tokensAfter = response.usage.input_tokens; // Approximate post-compaction size

  // 5. Log compaction event
  this.logger.logContextManagement(
    `Compacted: ${tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()} tokens`,
    {
      action: 'compaction',
      tokensBefore,
      tokensAfter,
      contextWindow,
      utilizationBefore: (tokensBefore / contextWindow) * 100,
      utilizationAfter: (tokensAfter / contextWindow) * 100,
      details: `Client-side compaction (model: ${compactionModel})`,
    },
  );

  // 6. Replace ALL messages with single user message containing summary
  const newMessages: MessageParam[] = [
    { role: 'user', content: [{ type: 'text', text: summary }] },
  ];

  return { compacted: true, newMessages, summary };
}
```

### 3.4 Compaction Model Selection

Use a cheaper model from the same provider for summarization:

```typescript
private getCompactionModel(): string {
  // Use Haiku for fast, cheap summarization
  // Falls back to the current model if no cheaper option available
  const model = this.config.fullName;

  // Opus/Sonnet → Haiku (much cheaper for summarization)
  if (model.includes('claude-opus') || model.includes('claude-sonnet')) {
    return 'claude-haiku-4-5';
  }
  // Haiku → Haiku (already cheap)
  if (model.includes('claude-haiku')) {
    return model;
  }
  // Unknown → same model
  return model;
}
```

This is a significant cost advantage over server-side compaction (which must use the same model). Haiku is ~60x cheaper than Opus for input tokens.

### 3.5 Summary Prompt

Use the Anthropic SDK's `DEFAULT_SUMMARY_PROMPT` from `CompactionControl.ts`. It's well-structured with 5 sections:

```typescript
import { DEFAULT_SUMMARY_PROMPT } from '@anthropic-ai/sdk/lib/tools/CompactionControl';

// Or define locally if import path is unstable:
const COMPACTION_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it.
Write a continuation summary that will allow you (or another instance of yourself)
to resume work efficiently in a future context window where the conversation
history will be replaced with this summary. Your summary should be structured,
concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete—err on the side of including information that would
prevent duplicate work or repeated mistakes. Write in a way that enables
immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;
```

This prompt is battle-tested by the SDK itself. Define it locally rather than importing from the SDK's internal path to avoid breakage on SDK updates.

### 3.6 Integration with `createResponse()`

Insert the compaction check at the start of `createResponse()`, before the Build phase:

```typescript
async createResponse(
  requestOptions: CreateResponseOptions<MessageParam, Anthropic>,
): Promise<CreateResponseResult<BetaMessage, MessageParam>> {
  const { client, messages, systemPrompt, ... } = requestOptions;

  // Phase 0: CHECK COMPACTION (NEW)
  let effectiveMessages = messages;
  let compactedMessages: MessageParam[] | undefined;

  if (this.shouldCompact()) {
    const result = await this.compactConversation(client, messages, systemPrompt);
    if (result.compacted) {
      effectiveMessages = result.newMessages;
      compactedMessages = result.newMessages;
    }
  }

  // Phase 1: BUILD (existing, but use effectiveMessages)
  const options: MessageCreateParams = {
    model: this.config.fullName,
    max_tokens: this.getEffectiveMaxOutputTokens(),
    messages: effectiveMessages,  // ← was `messages`
    ...
  };

  // ... Phase 2-4 unchanged ...

  // After response: update cumulative tokens
  const totalInputTokens = response.usage.input_tokens
    + (response.usage.cache_read_input_tokens ?? 0)
    + (response.usage.cache_creation_input_tokens ?? 0);
  this.compactionState.cumulativeInputTokens = totalInputTokens;

  return {
    response,
    ...(compactedMessages && { updatedMessages: compactedMessages }),
  };
}
```

### 3.7 Return `updatedMessages` for Flow Integration

The `CreateResponseResult` type needs to support `updatedMessages` so the calling flow (ToolUseCycleFlow) can update its shared message state after compaction:

```typescript
// In types/IModelHandler.ts
export interface CreateResponseResult<R, M> {
  response: R;
  updatedMessages?: M[];  // Set when compaction replaced messages
}
```

The flow integration (`ToolUseCycleFlow.ts`) already handles `updatedMessages` — see `CommonCycleTypes.ts`:
- `BaseInvocationSuccessData` includes `updatedMessages?: unknown[]`
- `replaceMessagesInPlace()` applies the update

### 3.8 Interaction with Server-Side Clearing

Client-side compaction and server-side clearing are **independent and complementary**:

1. **Client-side compaction** (this plan): Runs before the API call when cumulative tokens exceed threshold. Replaces all messages with a summary. Threshold: 75%.

2. **Server-side clearing** (existing): Runs during the API call. Removes old tool use/result pairs and thinking blocks. Also triggered at 75%, but operates on whatever messages are sent.

**After compaction:** Server-side clearing has nothing to clear (messages are just a single summary). It becomes a no-op. This is fine — clearing kicks back in as the conversation grows again post-compaction.

**Without compaction (disabled or not triggered):** Server-side clearing continues to operate as before, buying time before the context window is exhausted.

---

## 4. Implementation Steps

### Step 1: Add Compaction State and Configuration

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

```typescript
/** Compaction state tracking */
private compactionState = {
  cumulativeInputTokens: 0,
};

/** Whether compaction should be triggered based on cumulative tokens */
private shouldCompact(): boolean {
  const thresholdPercent = getConfig<number>(
    'texra.model.compactionThresholdPercent',
    DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  );
  if (thresholdPercent <= 0) return false;

  const threshold = Math.floor(
    (thresholdPercent / 100) * this.config.contextWindow,
  );
  return this.compactionState.cumulativeInputTokens > threshold;
}

/** Get the model to use for compaction summarization */
private getCompactionModel(): string {
  const model = this.config.fullName;
  if (model.includes('claude-opus') || model.includes('claude-sonnet')) {
    return 'claude-haiku-4-5';
  }
  return model;
}
```

### Step 2: Add Summary Prompt Constant

**File:** `src/agent/modelHandlers/compactionPrompt.ts` (new file)

Store the summary prompt separately so it can be shared across providers (per existing PRD's vision) and iterated independently:

```typescript
/**
 * Summary prompt for client-side compaction.
 * Based on Anthropic SDK's DEFAULT_SUMMARY_PROMPT from CompactionControl.ts.
 */
export const COMPACTION_SUMMARY_PROMPT = `You have been working on the task described above...`;
// (full prompt as shown in Section 3.5)
```

### Step 3: Implement `compactConversation()`

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Add the `compactConversation()` method as described in Section 3.3. Key points:
- Clean pending tool_use blocks from last assistant message
- Append summary prompt as user message
- Call API non-streaming with compaction model
- Replace all messages with single user message containing summary
- Log compaction event with structured data

### Step 4: Integrate into `createResponse()`

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

1. Add compaction check at start of `createResponse()` (before Phase 1: BUILD)
2. Use `effectiveMessages` (compacted or original) for the API call
3. After successful response, update `compactionState.cumulativeInputTokens`
4. Return `updatedMessages` when compaction occurred

### Step 5: Reset Compaction State on New Session

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Reset `compactionState` in `initializeMessages()`:

```typescript
async initializeMessages(...): Promise<MessageParam[]> {
  this.compactionState.cumulativeInputTokens = 0;
  // ... existing logic ...
}
```

### Step 6: Update Context Management Schema

**File:** `src/shared/schemas/contextManagement.ts`

Add optional `summary` and `compactionModel` fields:

```typescript
export const ContextManagementDataSchema = z.object({
  // ... existing fields ...
  summary: z.string().optional(),
  compactionModel: z.string().optional(),
});
```

### Step 7: Update Progress View Formatter

**File:** `src/progressView/frontend/formatters/logFormatters/contextManagementFormatters.ts`

When `action === 'compaction'` and `summary` is present, render an expandable details section showing the summary text.

---

## 5. What Does NOT Change

1. **Server-side clearing** — `clear_tool_uses_20250919` and `clear_thinking_20251015` continue to work independently.

2. **`createToolUseFollowUpMessages()`** — After compaction, messages are simple (single user message), so follow-up handling works as before.

3. **Other model handlers** — Only `ModelHandlerAnthropic` is changed. OpenAI Responses keeps native `/compact`. Others await the broader client-side engine from the main PRD.

4. **Token counting** — `estimateTokenCount()` works on whatever messages are passed. After compaction, it counts the compacted messages.

5. **Streaming** — No streaming changes needed (compaction is a separate, non-streaming API call before the main request).

---

## 6. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Summary quality with Haiku** | Haiku is capable for summarization. Use the SDK's proven prompt. Monitor quality in production. |
| **Extra API call latency** | Compaction only fires at 75% threshold. Uses fast model (Haiku). Non-blocking for user (shows progress). |
| **Cost of compaction call** | Haiku is ~60x cheaper than Opus. One compaction call costs less than a few lines of Opus output. |
| **Lost context** | Structured 5-section prompt preserves task overview, current state, discoveries, next steps, and user preferences. |
| **Double counting tokens** | Compaction call tokens are separate from the main request. `computePrice()` already handles per-call usage. |
| **Message format after compaction** | Single user message with text content — simplest possible format, compatible with all downstream code. |

---

## 7. Testing Strategy

1. **Unit test: `shouldCompact()`** — Verify triggers at correct threshold. Verify disabled when threshold is 0.

2. **Unit test: `compactConversation()`** — Mock API response. Verify message cleaning (tool_use removal), summary extraction, message replacement, and logging.

3. **Unit test: `getCompactionModel()`** — Verify Opus/Sonnet → Haiku mapping. Verify Haiku → Haiku. Verify unknown → same model.

4. **Unit test: `createResponse()` integration** — Verify compaction runs when threshold exceeded. Verify `updatedMessages` returned. Verify `cumulativeInputTokens` updated from response.

5. **Manual test: Long conversation** — Run a multi-turn tool-use agent conversation. Verify compaction fires, summary appears in progress view, and conversation continues.

---

## 8. Relationship to Existing PRD

This plan implements **Phase 3** (Integration with handlers) from `docs/prd-context-compactization.md` specifically for the Anthropic handler.

It **reuses** the same approach proposed for all non-OpenAI-Responses providers:
- Client-side summarization
- Summary prompt from `compactionPrompt.ts`
- Summary stored as user message
- `CONTEXT_MANAGEMENT` event logging

The compaction prompt file (`compactionPrompt.ts`) will be shared when other providers are integrated. The `compactConversation()` method is Anthropic-specific (uses Anthropic SDK types), but the logic is provider-agnostic and can be extracted into a shared utility for the DRY implementation described in PRD Section 4.3.1.

---

## 9. Future: Server-Side `compact_20260112` Upgrade Path

When the Anthropic SDK adds types for `compact_20260112`:

1. **Add `supportsNativeCompaction()` check** — returns true for Opus 4.6+
2. **Add `compact_20260112` to `setupContextManagement().edits`** — with trigger at 90% (above clearing's 75%)
3. **Handle `compaction` blocks in response content** — preserve in messages, log summary
4. **Handle streaming `compaction_delta` events** — log but don't stream to user
5. **Parse `usage.iterations`** — sum across iterations for accurate billing
6. **Keep client-side as fallback** — for models that don't support server-side compaction

This is additive — the client-side approach continues working for non-eligible models.

---

## 10. Implementation Order

Recommended sequence (each step independently testable):

1. **State + config** (Step 1) — `compactionState`, `shouldCompact()`, `getCompactionModel()`
2. **Summary prompt** (Step 2) — `compactionPrompt.ts`
3. **Compaction method** (Step 3) — `compactConversation()`
4. **createResponse integration** (Step 4) — Phase 0 check + token tracking
5. **Session reset** (Step 5) — Reset in `initializeMessages()`
6. **Schema + UI** (Steps 6-7) — Optional enrichment

Steps 1-5 form the MVP. Steps 6-7 are UI polish.
