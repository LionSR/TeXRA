# PRD: Token Counting & Context Management Audit

## Implementation Status

| Item | Severity | Status | Notes |
|------|----------|--------|-------|
| OpenAI Response API no pre-flight check | HIGH | Proposed | Can overflow context on first request |
| Missing usage in streaming responses | MEDIUM | Proposed | Defaults to 0, affects UI display |
| Safety buffer inconsistency (5000 vs 10) | LOW | Documented | Intentional but may be overly conservative |
| OpenAI Chat heuristic counting | LOW | Won't Fix | Best effort with `gpt-tokenizer` |

## Overview

This PRD documents token counting and context management discrepancies between model
providers. Post-response token counts are accurate (from API), but pre-flight counting
and edge cases have issues.

## Findings

### Post-Response Token Counting (ACCURATE)

All providers return accurate token counts from API responses:

| Provider | Input Tokens | Output Tokens | Source |
|----------|-------------|---------------|--------|
| OpenAI Chat | `usage.prompt_tokens` | `usage.completion_tokens` | API response |
| OpenAI Response | `usage.input_tokens` | `usage.output_tokens` | API response |
| Anthropic | `usage.input_tokens` | `usage.output_tokens` | API response |
| Google | `usageMetadata.promptTokenCount` | `usageMetadata.candidatesTokenCount` | API response |

**Conclusion:** No action needed for post-response counting.

---

## Issues

### T1) OpenAI Response API has no pre-flight token counting (HIGH)

- **Area:** Model Handlers
- **Type:** Logic gap
- **Impact:** High (can overflow context on first request if prior conversation + new message > context window)
- **Location:** `src/agent/modelHandlers/modelHandlerOpenAIResponse.ts`
- **Root cause:** Unlike other providers, the Response API handler does NOT check token
  counts before sending a request. It only checks `cumulativeInputTokens` AFTER receiving
  a response to decide if compaction is needed.
- **Code Evidence:**
  - `modelHandlerOpenAI.ts` calls `this.applyTokenHeuristics()` during request prep
  - `modelHandlerOpenAIResponse.ts` has no equivalent pre-flight check
  - `shouldCompact()` at line 424 only checks after response: `cumulativeInputTokens > threshold`
- **Comparison:**
  - Anthropic: Calls `client.beta.messages.countTokens()` BEFORE creating message
  - Google: Calls `client.models.countTokens()` BEFORE creating message
  - OpenAI Response: No pre-flight check
- **Fix Options:**
  1. Add heuristic pre-flight check using `gpt-tokenizer` (same as OpenAI Chat)
  2. Use a larger safety buffer to account for estimation uncertainty
  3. Accept risk since compaction handles overflow after first response

### T2) Streaming responses may have missing usage data (MEDIUM)

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
    this.logger.warn('Response missing usage information - token counts will show as 0');
  }
  ```
- **External Reference:** https://github.com/openai/openai-agents-python/issues/1179
- **Current Handling:** Logs warning and defaults to 0 (graceful degradation)
- **Fix Options:**
  1. Keep current behavior (acceptable - already logs warning)
  2. Estimate tokens from response text length as fallback
  3. Retry request with `stream: false` to get usage (expensive)

### T3) Safety buffer inconsistency between providers (LOW)

- **Area:** Model Handlers
- **Type:** Configuration inconsistency
- **Impact:** Low (OpenAI may have unnecessarily reduced `max_tokens`)
- **Locations:**
  - `src/agent/modelHandlers/modelHandlerOpenAI.ts`: `HEURISTIC_TOKEN_BUFFER = 5000`
  - `src/agent/modelHandlers/utils/tokenUtils.ts`: `TOKEN_SAFETY_BUFFER = 10`
- **Root cause:** OpenAI Chat uses heuristic counting which is less accurate, so a larger
  buffer (5000 tokens) compensates for estimation errors. Providers with exact counting
  use a minimal buffer (10 tokens).
- **Code Evidence:**
  ```typescript
  // OpenAI Chat - large buffer for heuristic inaccuracy
  const reducedMaxTokens = computeReducedMaxTokens(availableTokens, HEURISTIC_TOKEN_BUFFER);

  // Anthropic/Google - small buffer for exact counting
  const reducedMaxTokens = computeReducedMaxTokens(availableTokens, TOKEN_SAFETY_BUFFER);
  ```
- **Assessment:** This is intentional and documented. The 5000-token buffer may be overly
  conservative but provides safety margin. Consider reducing to 1000-2000 if testing shows
  it's too aggressive.
- **Fix:** Document the rationale in code comments (already partially done).

### T4) OpenAI Chat heuristic pre-flight counting (WON'T FIX)

- **Area:** Model Handlers
- **Type:** Known limitation
- **Impact:** Low (compensated by large safety buffer)
- **Location:** `src/agent/modelHandlers/modelHandlerOpenAI.ts` (`_calculateApproximateTokens`)
- **Root cause:** Uses client-side `gpt-tokenizer` library which:
  - Doesn't account for message framing tokens
  - Doesn't handle multi-modal content correctly
  - May drift from OpenAI's actual tokenizer
- **Code Evidence:** Comment in code acknowledges this:
  ```typescript
  // Note: This is a simplified token count. A more accurate count would
  // need to replicate OpenAI's specific chat message formatting rules.
  // https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
  ```
- **Why Won't Fix:**
  - OpenAI doesn't provide a pre-request token counting API
  - The 5000-token safety buffer compensates for inaccuracy
  - Post-response counts are accurate for billing/display
  - Alternative (tiktoken WASM) would add significant bundle size

---

## Summary

| Issue | Pre-flight | Post-response | Action |
|-------|-----------|---------------|--------|
| OpenAI Chat | Heuristic (5000 buffer) | Accurate | Won't fix |
| OpenAI Response | **None** | Accurate | Consider adding |
| Anthropic | Exact API | Accurate | None needed |
| Google | Exact API | Accurate | None needed |

## Recommended Actions

1. **T1 (HIGH):** Add pre-flight token estimation to OpenAI Response API handler
   - Use same `gpt-tokenizer` approach as OpenAI Chat
   - Apply similar safety buffer

2. **T2 (MEDIUM):** Current handling is acceptable (logs warning, defaults to 0)
   - Consider adding heuristic fallback if this causes user confusion

3. **T3/T4 (LOW):** Document rationale, no code changes needed
