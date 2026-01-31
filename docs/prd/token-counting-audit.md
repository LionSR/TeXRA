# PRD: Token Counting & Context Management Audit

## Implementation Status

| Item                                              | Severity | Status      | Notes                                             |
| ------------------------------------------------- | -------- | ----------- | ------------------------------------------------- |
| T1: Cumulative token tracking may be inaccurate   | HIGH     | Proposed    | `cumulativeInputTokens` assumption needs验证      |
| T2: No pre-flight token counting                  | HIGH     | Proposed    | Use `inputTokens.count()` API                     |
| T3: Missing usage in streaming responses          | MEDIUM   | Documented  | Defaults to 0, affects UI display                 |
| T4: Safety buffer inconsistency (5000 vs 10)      | LOW      | Documented  | Intentional but may be overly conservative        |
| T5: OpenAI Chat heuristic counting                | LOW      | Won't Fix   | Best effort with `gpt-tokenizer`                  |

## Overview

This PRD documents token counting and context management discrepancies between model
providers. Post-response token counts are accurate (from API), but pre-flight counting
and cumulative tracking have issues that can cause unexpected context overflow errors.

---

## Critical Finding: Context Overflow Despite "67.7% Usage"

**Observed Behavior:**
```
🟢 Context: 270671/400000 tokens (67.7%)
🟡 Request failed with previousResponseId=resp_xxx. Error: Your input exceeds the context window
```

The UI showed 67.7% context usage, but the next request failed with context overflow.
This indicates a fundamental issue with how we track cumulative token usage.

---

## Issues

### T1) Cumulative token tracking may be inaccurate (HIGH) - NEW

- **Area:** Model Handlers
- **Type:** Logic bug (potential)
- **Impact:** HIGH - context overflow despite UI showing headroom available
- **Location:** `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts` (lines 354-359)
- **Root cause:** The code assumes `response.usage.input_tokens` represents the FULL
  cumulative context including server-side history from `previous_response_id`. This
  assumption needs verification.

**Code Evidence:**
```typescript
// Line 354-358 - ASSUMPTION THAT NEEDS VERIFICATION
// Set cumulative input tokens from actual usage (not additive - this IS the total)
// The response's input_tokens reflects the full context including server-side history
if (response.usage?.input_tokens) {
  this.conversationState.cumulativeInputTokens =
    response.usage.input_tokens;
}
```

**What `input_tokens` actually includes (per OpenAI community reports):**
- Full conversation history when using `previous_response_id` ✓
- Each message has 4-token overhead wrapper
- System messages counted fully
- Previous assistant responses included
- A 3-token prompt finalizer

**What we need to verify:**
1. Does `input_tokens` include output tokens from previous responses that become
   input for the next request?
2. How does `cached_tokens` relate to `input_tokens`?
   - `cached_tokens` is a SUBSET of `input_tokens` (tokens served from cache)
   - `input_tokens - cached_tokens` = uncached tokens (full price)
   - Total context = `input_tokens` (cached + uncached)
3. After compaction, does tracking remain accurate?
   - Compaction clears `previousResponseId` (line 536)
   - Next request sends all messages directly
   - `input_tokens` should then reflect actual sent tokens

**Possible scenarios for the observed bug:**
1. `input_tokens` doesn't include full server-side history (assumption wrong)
2. `input_tokens` is accurate, but doesn't predict what NEXT request will need
3. Output tokens from Response A become input for Response B, not accounted for
4. Model's actual context window differs from configured 400k

**Fix:** Use `inputTokens.count()` API for verification (see T2)

### T2) OpenAI Response API has pre-flight token counting API (HIGH) - UPDATED

- **Area:** Model Handlers
- **Type:** Missing feature
- **Impact:** HIGH - can prevent context overflow by checking BEFORE sending
- **Location:** `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts`

**OpenAI provides a pre-flight token counting API:**

```
POST https://api.openai.com/v1/responses/input_tokens
```

**SDK Usage:**
```typescript
const response = await client.responses.inputTokens.count({
  model: "gpt-5",
  input: newMessages,
  previous_response_id: this.previousResponseId,  // Includes server history!
  instructions: systemPrompt,
  tools: tools,
});
console.log(response.input_tokens);  // ACTUAL total context
```

**Key parameters:**
- `previous_response_id` - includes server-side conversation history in count
- `input` - new messages being sent
- `instructions` - system prompt
- `tools` - tool definitions (contribute to token count)
- `truncation` - can check if truncation would occur

**This API provides:**
1. Accurate pre-flight token count INCLUDING server-side history
2. Ability to check before sending and trigger compaction proactively
3. Verification of what `usage.input_tokens` should return

**Recommended implementation:**
```typescript
// Before createResponse()
const preflightCount = await client.responses.inputTokens.count({
  model: this.config.fullName,
  input: newMessages,
  previous_response_id: this.previousResponseId,
  instructions: systemPrompt,
  tools: convertedTools,
});

const utilization = preflightCount.input_tokens / this.config.contextWindow;
if (utilization > COMPACTION_THRESHOLD) {
  // Trigger compaction BEFORE the request fails
  await this.compactConversation(...);
}
```

**Comparison with other providers:**
| Provider        | Pre-flight API                       | Includes history? |
| --------------- | ------------------------------------ | ----------------- |
| OpenAI Response | `client.responses.inputTokens.count` | Yes (via prev_id) |
| Anthropic       | `client.beta.messages.countTokens`   | Yes (in messages) |
| Google          | `client.models.countTokens`          | Yes (in contents) |
| OpenAI Chat     | None (use gpt-tokenizer heuristic)   | N/A               |

### T3) Streaming responses may have missing usage data (MEDIUM)

- **Area:** Model Handlers (OpenAI)
- **Type:** Edge case handling
- **Impact:** Medium (token counts show as 0 in UI, affects context % display)
- **Location:**
  - `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts` (lines 1161-1172)
  - `src/agent/modelHandlers/modelHandlerOpenAI.ts` (lines 336-341, 717-721)
- **Root cause:** OpenAI streaming can sometimes return missing or null usage data,
  especially with thinking models through relay proxies.
- **Code Evidence:**
  ```typescript
  // Response API - defaults to zeros
  const usage: ResponseUsage = responseObject.usage ?? {
    input_tokens: 0,
    output_tokens: 0,
    // ...
  };
  if (!responseObject.usage) {
    this.logger.warn(
      'Response missing usage information - token counts will show as 0',
    );
  }
  ```
- **External Reference:** https://github.com/openai/openai-agents-python/issues/1179
- **Current Handling:** Logs warning and defaults to 0 (graceful degradation)

### T4) Safety buffer inconsistency between providers (LOW)

- **Area:** Model Handlers
- **Type:** Configuration inconsistency
- **Impact:** Low (OpenAI may have unnecessarily reduced `max_tokens`)
- **Locations:**
  - `src/agent/modelHandlers/modelHandlerOpenAI.ts`: `HEURISTIC_TOKEN_BUFFER = 5000`
  - `src/agent/modelHandlers/utils/tokenUtils.ts`: `TOKEN_SAFETY_BUFFER = 10`
- **Root cause:** OpenAI Chat uses heuristic counting which is less accurate, so a larger
  buffer (5000 tokens) compensates for estimation errors. Providers with exact counting
  use a minimal buffer (10 tokens).
- **Assessment:** This is intentional and documented.

### T5) OpenAI Chat heuristic pre-flight counting (WON'T FIX)

- **Area:** Model Handlers
- **Type:** Known limitation
- **Impact:** Low (compensated by large safety buffer)
- **Location:** `src/agent/modelHandlers/modelHandlerOpenAI.ts` (`_calculateApproximateTokens`)
- **Root cause:** Uses client-side `gpt-tokenizer` library which:
  - Doesn't account for message framing tokens
  - Doesn't handle multi-modal content correctly
  - May drift from OpenAI's actual tokenizer
- **Why Won't Fix:**
  - OpenAI Chat API doesn't have a pre-request token counting endpoint
  - The 5000-token safety buffer compensates for inaccuracy
  - Post-response counts are accurate for billing/display

---

## Token Counting Reference

### Post-Response Token Counting (ACCURATE)

All providers return accurate token counts from API responses:

| Provider        | Input Tokens                     | Output Tokens                        | Cached Tokens                           |
| --------------- | -------------------------------- | ------------------------------------ | --------------------------------------- |
| OpenAI Chat     | `usage.prompt_tokens`            | `usage.completion_tokens`            | `usage.prompt_tokens_details.cached`    |
| OpenAI Response | `usage.input_tokens`             | `usage.output_tokens`                | `usage.input_tokens_details.cached`     |
| Anthropic       | `usage.input_tokens`             | `usage.output_tokens`                | `usage.cache_read_input_tokens`         |
| Google          | `usageMetadata.promptTokenCount` | `usageMetadata.candidatesTokenCount` | `usageMetadata.cachedContentTokenCount` |

### Understanding `cached_tokens`

When using `previous_response_id`:
- `input_tokens` = TOTAL context (including server-side history)
- `cached_tokens` = portion served from cache (cost reduction)
- `input_tokens - cached_tokens` = uncached tokens

**Important:** `cached_tokens` is a SUBSET of `input_tokens`, not additional.
The total context size is `input_tokens`, not `input_tokens + cached_tokens`.

### How Context Grows with `previous_response_id`

```
Request 1:
  Send: system_prompt + user_message
  input_tokens: 1000
  output_tokens: 500

Request 2 (with previous_response_id):
  Server reconstructs: Request_1_context + Request_1_output + new_input
  input_tokens: 1000 + 500 + new_tokens = ~1600+
  cached_tokens: ~1500 (from Request 1)
```

Each response's output becomes input for the next request when using `previous_response_id`.

### Interaction: `inputTokens.count()` + `compact()`

**Both APIs work together for safe context management:**

```
Phase 1: Pre-flight Check
─────────────────────────
inputTokens.count({
  input: newMessages,
  previous_response_id: "resp_xxx"  ← Server history included
}) → { input_tokens: 380000 }       ← 95% of 400k context!

Phase 2: Trigger Compaction
───────────────────────────
responses.compact({
  input: allMessages,
  previous_response_id: "resp_xxx"
}) → {
  output: [
    { type: "message", role: "user", ... },
    { type: "compaction", encrypted_content: "..." }  ← Compressed history
  ],
  usage: { input_tokens: 120000 }  ← Reduced to 30%!
}

Phase 3: After Compaction
─────────────────────────
- Clear previous_response_id (no longer needed)
- Use compacted output array for future requests
- Compaction item contains encrypted conversation summary

Phase 4: Future Pre-flight Checks
─────────────────────────────────
inputTokens.count({
  input: compactedMessages,  ← Contains compaction item
  // NO previous_response_id - history is in compaction item
}) → { input_tokens: 125000 }  ← Accurate count of compacted context
```

**Key insight:** After compaction, the `compaction` item in the output array
carries the conversation history. No `previous_response_id` needed - just pass
the compacted messages to both `inputTokens.count()` and `responses.create()`.

**Compacted Response Structure:**
```json
{
  "output": [
    { "type": "message", "role": "user", "content": [...] },
    { "type": "compaction", "id": "cmp_001", "encrypted_content": "..." }
  ],
  "usage": {
    "input_tokens": 42897,
    "output_tokens": 12000,
    "cached_tokens": 30000
  }
}
```

---

## Summary

| Issue           | Pre-flight              | Post-response | Tracking Accurate? | Action               |
| --------------- | ----------------------- | ------------- | ------------------ | -------------------- |
| OpenAI Response | **None (should add)**   | Accurate      | **Needs验证**      | Use inputTokens.count |
| OpenAI Chat     | Heuristic (5000 buffer) | Accurate      | N/A (no chaining)  | Won't fix            |
| Anthropic       | Exact API               | Accurate      | Yes                | None needed          |
| Google          | Exact API               | Accurate      | Yes                | None needed          |

## Recommended Actions

### Phase 1: Verification
1. Add diagnostic logging to compare:
   - `cumulativeInputTokens` (our tracking)
   - `inputTokens.count()` result (pre-flight API)
   - `response.usage.input_tokens` (post-response)
2. Verify the relationship: do these three values align?

### Phase 2: Implementation
1. **T1/T2 (HIGH):** Add `inputTokens.count()` pre-flight check
   - Call before `createResponse()`
   - Use result to decide if compaction needed
   - Replace heuristic `cumulativeInputTokens` tracking with API-verified counts

2. **T3 (MEDIUM):** Current handling acceptable (logs warning, defaults to 0)

3. **T4/T5 (LOW):** Document rationale, no code changes needed

---

## Implementation Guide

### Complete API Integration Pattern

```typescript
// In modelHandlerOpenAIResponse.ts

private async getPreflightTokenCount(
  client: OpenAI,
  messages: ResponseInputItem[],
  systemPrompt?: string,
): Promise<number> {
  const params: InputTokenCountParams = {
    model: this.config.fullName,
    input: messages,
  };

  if (this.previousResponseId) {
    params.previous_response_id = this.previousResponseId;
  }

  if (systemPrompt) {
    params.instructions = systemPrompt;
  }

  const response = await client.responses.inputTokens.count(params);
  return response.input_tokens;
}

async createResponse(options: CreateResponseOptions): Promise<Response> {
  const { client, messages, systemPrompt } = options;

  // PRE-FLIGHT CHECK: Get accurate token count before sending
  const preflightTokens = await this.getPreflightTokenCount(
    client,
    messages,
    systemPrompt,
  );

  const utilization = preflightTokens / this.config.contextWindow;
  this.logger.logContextState(preflightTokens, this.config.contextWindow);

  // Check if compaction needed BEFORE request fails
  if (utilization > this.getCompactionThresholdPercent() / 100) {
    this.logger.logProgress(
      `Pre-flight check: ${preflightTokens} tokens (${(utilization * 100).toFixed(1)}%) ` +
      `exceeds threshold. Triggering compaction.`
    );

    const compactedMessages = await this.compactConversation(
      client,
      messages,
      systemPrompt,
    );

    // Use compacted messages, no previous_response_id
    return this.sendRequest(client, compactedMessages, systemPrompt, options);
  }

  // Send request normally
  return this.sendRequest(client, messages, systemPrompt, options);
}
```

### API Reference

**`POST /v1/responses/input_tokens`** - Pre-flight token counting
```typescript
const response = await client.responses.inputTokens.count({
  model: "gpt-5",                           // Required
  input: messages,                          // Optional: messages to count
  previous_response_id: "resp_xxx",         // Optional: includes server history
  instructions: "System prompt",            // Optional: system message
  tools: [...],                             // Optional: tool definitions
  truncation: "disabled",                   // Optional: "auto" | "disabled"
});
// Returns: { object: "response.input_tokens", input_tokens: 12345 }
```

**`POST /v1/responses/compact`** - Compress conversation
```typescript
const compactedResponse = await client.responses.compact({
  model: "gpt-5",                           // Required
  input: allMessages,                       // Optional: messages to compact
  previous_response_id: "resp_xxx",         // Optional: server history to include
  instructions: "System prompt",            // Optional: system message
});
// Returns: CompactedResponse with:
//   - output: [...messages, { type: "compaction", encrypted_content: "..." }]
//   - usage: { input_tokens, output_tokens, cached_tokens }
```

### Migration Path

**Current (broken):**
```
Request → Response → Store usage.input_tokens as cumulativeInputTokens
                     (May not include full server history!)
```

**Proposed (fixed):**
```
inputTokens.count() → Check utilization → [Compact if needed] → Request → Response
        ↓
  Accurate pre-flight
  count including
  server history
```

### Error Handling

The `inputTokens.count()` API should be non-blocking for request flow:

```typescript
try {
  const preflightTokens = await this.getPreflightTokenCount(...);
  // Use for compaction decision
} catch (err) {
  // If pre-flight fails, fall back to sending request directly
  // Let the request fail naturally if context exceeded
  this.logger.warn(`Pre-flight token count failed: ${err.message}`);
}
```

---

## References

- [OpenAI Responses API - Input Tokens](https://platform.openai.com/docs/api-reference/responses/input-tokens)
- [OpenAI Prompt Caching](https://platform.openai.com/docs/guides/prompt-caching)
- [Community: Tokens usage on Response API with previous message](https://community.openai.com/t/tokens-usage-on-response-api-with-previous-message/1327213)
- [Community: Responses API high token consumption](https://community.openai.com/t/responses-api-high-token-consumption/1293882)
