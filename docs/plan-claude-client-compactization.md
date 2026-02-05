# Plan: Client-Side Compaction for Anthropic (and All Non-OpenAI-Responses Providers)

## Status: Proposed

## Date: 2026-02-05

## Prerequisite: None (can start immediately)

## PRD Alignment: `docs/prd-context-compactization.md`

This plan implements **Phase 3** (Integration with Handlers) of the PRD for the Anthropic provider. It follows the PRD's core architectural decision (Section 4.6): **Anthropic uses client-side summarization, not server-side `context_management`**. The PRD explicitly states: "Anthropic → returns `null` → triggers client-side summarization" and explains: "The server-side clearing is opaque and loses context. Client-side summarization preserves the conversation summary visibly in the message history."

---

## 1. Summary

Add client-side compaction to `ModelHandlerAnthropic`, following the pattern proven in the Anthropic SDK's `BetaToolRunner._checkAndCompact()`. This approach works with **all Anthropic models** (not just Opus 4.6), uses a **cheaper model** for summarization, and requires **no SDK type additions**.

This is the same approach proposed in the main PRD (`docs/prd-context-compactization.md`) Section 4.2 for all non-OpenAI-Responses providers. Implementing it for Anthropic first validates the pattern before rolling out to Google, DeepSeek, Kimi, and OpenAI Chat.

**Relationship to PRD phases:**
- **Phase 0** (Refactor `createResponse()`): Not a hard prerequisite — compaction can be added as a new phase (Phase 5: CHECK COMPACTION) at the end of `createResponse()` without restructuring earlier phases. However, the Phase 0 refactoring would make the integration cleaner.
- **Phase 1** (Client-Side Summarization Engine): This plan is the Anthropic-specific implementation of Phase 1's `ContextCompactor`.
- **Phase 2** (Auto-Compact Toggle): Independent UI work. This plan works with or without the toggle — when no toggle exists, compaction is always enabled (controlled by `compactionThresholdPercent > 0`).
- **Phase 3** (Integration with Handlers): This plan IS Phase 3 for Anthropic.

---

## 2. Reference: SDK `_checkAndCompact()` Analysis

From `node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.js` (lines 65-133). Key design decisions the SDK made:

### What to adopt

1. **Token metric: input + output** — The SDK checks `inputTokens + cacheTokens + outputTokens` against the threshold. Output tokens matter because the assistant's response becomes part of the conversation on the next turn.

2. **`tool_use` block cleanup** — Before calling the compactor, strip `tool_use` blocks from the last assistant message. Without this, the API returns 400 ("tool_use requires tool_result"). Two cases: if all blocks are tool_use, pop the entire message; otherwise keep non-tool blocks.

3. **Summary as `role: 'user'`** — The compactor's response (assistant role) is stored as a **user message**. This satisfies user/assistant alternation requirements and frames the summary as the "user's context" for subsequent turns.

4. **Keep `<summary>` tags** — The prompt asks for `<summary></summary>` tags but the code doesn't strip them. The tags serve as a structural signal to the model that this is compacted context, not a real conversation.

5. **`structuredClone` for message isolation** — The SDK deep-clones messages at construction time to prevent mutations from leaking between caller and runner.

### What to change

| SDK Behavior | Our Adaptation | Reason |
|---|---|---|
| Compaction runs **after** API call | Run **after** API call (match SDK) | Better UX: user sees response immediately, compaction happens between turns |
| No system prompt in compaction call | **Include** system prompt | TeXRA's system prompts contain important LaTeX/research context |
| Same `max_tokens` as main request | Fixed **8192** for compaction | Summaries rarely need >4K tokens; avoid wasting budget |
| Hard throw on non-text response | **Graceful fallback** to original messages | More robust in production |
| No logging | Full **context management logging** | TeXRA's progress view needs visibility |

---

## 3. Design

### 3.1 Compaction Timing: After API Call

Following the SDK's pattern, compaction runs **after** the response is received, not before. The loop becomes:

```
ToolUseCycleFlow iteration:
  1. createResponse() → send request, receive response
  2. Update compactionState.lastUsageTokens from response.usage
  3. Check shouldCompact()
  4. If yes → compactConversation() → replace messages → return updatedMessages
  5. If no → append assistant message, generate tool response
  6. Loop to step 1 (next iteration uses compacted or original messages)
```

**Why after, not before:**
- The response that pushes tokens over threshold is still delivered to the user (no added latency)
- Compaction happens between turns — next `createResponse()` benefits from compacted context
- Matches the SDK's proven flow
- Avoids the "compact then immediately call API" double-wait

**Integration point:** At the end of `createResponse()`, after the API response is received and usage is known. Return `updatedMessages` in the result so the calling flow can update its state.

### 3.2 Token Tracking

Track total tokens (input + output) from each API response:

```typescript
private compactionState = {
  /** Total tokens (input + output) from most recent API response */
  lastUsageTokens: 0,
};
```

Updated after every successful `createResponse()`:

```typescript
const totalInput = response.usage.input_tokens
  + (response.usage.cache_read_input_tokens ?? 0)
  + (response.usage.cache_creation_input_tokens ?? 0);
const totalOutput = response.usage.output_tokens;
this.compactionState.lastUsageTokens = totalInput + totalOutput;
```

### 3.3 Compaction Decision

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
  return this.compactionState.lastUsageTokens > threshold;
}
```

### 3.4 Compaction Execution

```typescript
private async compactConversation(
  client: Anthropic,
  messages: MessageParam[],
  systemPrompt?: string,
  signal?: AbortSignal,
): Promise<{ compacted: boolean; newMessages: MessageParam[]; summary?: string }> {
  const tokensBefore = this.compactionState.lastUsageTokens;
  const contextWindow = this.config.contextWindow;

  // 1. Deep-copy and clean last assistant message (remove pending tool_use blocks)
  const cleanedMessages: MessageParam[] = structuredClone(messages);
  const lastMsg = cleanedMessages.at(-1);
  if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
    const nonToolBlocks = (lastMsg.content as BetaContentBlockParam[]).filter(
      (b) => b.type !== 'tool_use',
    );
    if (nonToolBlocks.length === 0) {
      cleanedMessages.pop();
    } else {
      (cleanedMessages[cleanedMessages.length - 1] as MessageParam).content = nonToolBlocks;
    }
  }

  // 2. Append summary prompt as user message
  cleanedMessages.push({
    role: 'user',
    content: [{ type: 'text', text: COMPACTION_SUMMARY_PROMPT }],
  });

  // 3. Call API (non-streaming) with compaction model
  const compactionModel = this.getCompactionModel();
  try {
    const response = await client.beta.messages.create(
      {
        model: compactionModel,
        messages: cleanedMessages,
        max_tokens: 8192,
        ...(systemPrompt && { system: systemPrompt }),
      },
      { signal },
    );

    // 4. Extract summary text
    const summaryBlock = response.content.find(
      (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
    );
    if (!summaryBlock) {
      this.logger.warn('Compaction returned no text; keeping original messages');
      return { compacted: false, newMessages: messages };
    }

    const summary = summaryBlock.text;

    // 5. Log compaction event
    this.logger.logContextManagement(
      `Compacted: ${tokensBefore.toLocaleString()} → summary`,
      {
        action: 'compaction',
        tokensBefore,
        contextWindow,
        utilizationBefore: (tokensBefore / contextWindow) * 100,
        details: `Client-side compaction (model: ${compactionModel})`,
      },
    );

    // 6. Replace ALL messages with single user message containing summary
    const newMessages: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: summary }] },
    ];

    return { compacted: true, newMessages, summary };
  } catch (error) {
    this.logger.warn(`Compaction failed: ${error}; keeping original messages`);
    return { compacted: false, newMessages: messages };
  }
}
```

### 3.5 Compaction Model Selection

Uses the shared `COMPACTION_MODEL_MAP` from the PRD (Section 4.3). For the Anthropic handler:

```typescript
// From src/agent/modelHandlers/compactionPrompt.ts (shared across providers)
export const COMPACTION_MODEL_MAP: Record<string, string> = {
  // Anthropic: use Sonnet for summarization (capable + fast)
  'claude-opus-4-6': 'claude-sonnet-4-5',
  'claude-opus-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',
  // Haiku → same model (already cheapest)
  'claude-haiku-4-5': 'claude-haiku-4-5',

  // Google
  'gemini-3-pro': 'gemini-3-flash',
  'gemini-2.5-pro': 'gemini-2.5-flash',

  // DeepSeek: no cheaper option
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-chat',

  // Kimi
  'kimi-k2': 'kimi-k2',
  'kimi-k1.5-long': 'kimi-k1.5-long',
};

export function getCompactionModel(primaryModel: string): string {
  return COMPACTION_MODEL_MAP[primaryModel] ?? primaryModel;
}
```

The Anthropic handler calls:
```typescript
private getCompactionModel(): string {
  return getCompactionModel(this.config.fullName);
}
```

**No thinking mode for summarizer** (per PRD Section 4.3): The Anthropic SDK's compaction call doesn't pass thinking parameters — summarization is straightforward and doesn't need extended thinking.

### 3.6 Summary Prompt

Define locally in `src/agent/modelHandlers/compactionPrompt.ts` (shared across providers):

```typescript
export const COMPACTION_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it.
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

Based on the Anthropic SDK's `DEFAULT_SUMMARY_PROMPT` (`lib/tools/CompactionControl.js`). Defined locally to avoid importing from an unstable internal SDK path.

### 3.7 Integration with `createResponse()`

```typescript
async createResponse(
  requestOptions: CreateResponseOptions<MessageParam, Anthropic>,
): Promise<CreateResponseResult<BetaMessage, MessageParam>> {
  const { client, messages, systemPrompt, signal, ... } = requestOptions;

  // ... Phase 1-4 unchanged (BUILD → COUNT → VALIDATE → EXECUTE) ...

  // After response received:
  const totalInput = response.usage.input_tokens
    + (response.usage.cache_read_input_tokens ?? 0)
    + (response.usage.cache_creation_input_tokens ?? 0);
  this.compactionState.lastUsageTokens = totalInput + response.usage.output_tokens;

  // Phase 5: CHECK COMPACTION (NEW — after response, before return)
  let updatedMessages: MessageParam[] | undefined;
  if (this.shouldCompact()) {
    this.logger.logProgress(
      `Compacting conversation (${this.compactionState.lastUsageTokens.toLocaleString()} tokens exceed threshold)`,
    );
    const result = await this.compactConversation(client, messages, systemPrompt, signal);
    if (result.compacted) {
      updatedMessages = result.newMessages;
    }
  }

  return {
    response,
    ...(updatedMessages && { updatedMessages }),
  };
}
```

### 3.8 Flow Integration

The calling flow (`ToolUseCycleFlow`) already handles `updatedMessages`:

- `BaseInvocationSuccessData` includes `updatedMessages?: unknown[]`
- `replaceMessagesInPlace()` applies the update to the shared state
- When compaction returns `updatedMessages`, all subsequent iterations use the compacted messages

**After compaction, the messages array contains:**
```
[{ role: 'user', content: [{ type: 'text', text: '<summary>...</summary>' }] }]
```

The next iteration appends user/assistant messages normally. The conversation grows from this clean baseline until the next compaction threshold is reached.

### 3.8.1 Relationship to PRD's `allMessages` Pattern

The PRD (Section 4.7) proposes a single `allMessages` source of truth with derived active messages:

```typescript
function getMessagesToSend(
  allMessages: Message[],
  compactionState: CompactionState | null,
): Message[] {
  if (compactionState === null) return allMessages;
  return [{ role: 'user', content: `<conversation-summary>${compactionState.summary}</conversation-summary>` }];
}
```

**For the MVP implementation**, we use the simpler `updatedMessages` return pattern that already exists in the flow infrastructure (proven by OpenAI Responses handler). The `allMessages` / `compactionState` derivation pattern from the PRD is the **long-term architecture** and should be adopted in Phase 1 (Client-Side Summarization Engine) when building the shared `ContextCompactor` class. At that point:

- `allMessages` remains append-only (full history, visible in UI)
- `compactionState` stores the latest summary + metadata
- Active messages are derived at each `createResponse()` call
- The webview shows full history with a "compacted away" visual divider (PRD Section 5.4)

### 3.9 Interaction with Server-Side Clearing

Client-side compaction and server-side clearing are **independent and complementary**:

- **Server-side clearing** (existing `setupContextManagement()`): Removes old tool uses and thinking blocks during the API call. Trigger: 75%.
- **Client-side compaction** (this plan): Replaces all messages with a summary after the API call. Trigger: also 75%.

The sequence in a single `createResponse()` call:
1. API call includes `context_management.edits` (clearing)
2. Server applies clearing if threshold exceeded
3. Response received with `applied_edits` logged
4. After response: check compaction on total tokens (input+output)
5. If threshold exceeded: compact client-side

After compaction, the next API call has a single user message — server-side clearing has nothing to clear and becomes a no-op. Clearing resumes as the conversation grows again.

**Note on Anthropic's `compact_20260112` API:** The PRD (Section 4.6) explicitly chose **not** to use Anthropic's native server-side compaction for these reasons:
1. **Opaque** — server-side compaction gives zero visibility into what was preserved
2. **Inconsistent** — only works on Opus 4.6, not on Sonnet/Haiku
3. **Expensive** — uses the same model for summarization (Opus at ~$12/200K vs Sonnet at ~$0.60)
4. **No user control** — can't inspect or override the summary

Client-side summarization provides the same compaction benefit with full transparency, lower cost, and universal model support. See `docs/plan-claude-server-compactization.md` for the server-side plan (kept as a future option, not recommended for near-term).

---

## 4. Implementation Steps

### Step 1: Shared compaction infrastructure

**New file:** `src/agent/modelHandlers/compactionPrompt.ts`

Exports shared across all providers:
- `COMPACTION_SUMMARY_PROMPT` — The 5-section structured prompt (from Anthropic SDK)
- `COMPACTION_MODEL_MAP` — Constant map from primary model → cheaper compaction model (PRD Section 4.3)
- `getCompactionModel()` — Lookup function with same-model fallback

### Step 2: Compaction state and decision methods

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Add:
- `private compactionState = { lastUsageTokens: 0 }`
- `private shouldCompact(): boolean`
- `private getCompactionModel(): string` (delegates to shared `getCompactionModel()`)

### Step 3: `compactConversation()` method

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

Add the method as described in Section 3.4. Key behaviors:
- `structuredClone` messages before mutation
- Clean `tool_use` blocks from last assistant message
- Non-streaming API call to compaction model
- Graceful fallback on failure
- Structured logging via `logger.logContextManagement()`

### Step 4: Integrate into `createResponse()`

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

1. After API response: update `compactionState.lastUsageTokens`
2. After token tracking: check `shouldCompact()`
3. If triggered: call `compactConversation()`, set `updatedMessages`
4. Return `updatedMessages` in result

This adds a **Phase 5: CHECK COMPACTION** after the existing phases (BUILD → COUNT → VALIDATE → EXECUTE). The PRD's Phase 0 refactoring (decomposing `createResponse()`) would make this cleaner but is not a hard prerequisite — the compaction check is a self-contained block appended after the response is received.

### Step 5: Reset state on new session

**File:** `src/agent/modelHandlers/modelHandlerAnthropic.ts`

In `initializeMessages()`:
```typescript
this.compactionState.lastUsageTokens = 0;
```

### Step 6: Schema enrichment (optional)

**File:** `src/shared/schemas/contextManagement.ts`

Add optional fields for compaction events (per PRD Section 4.2 logging spec):
```typescript
summary: z.string().optional(),
compactionModel: z.string().optional(),
```

### Step 7: Progress view summary display (optional)

**File:** `src/progressView/frontend/formatters/logFormatters/contextManagementFormatters.ts`

When `action === 'compaction'` and `summary` present: render expandable `<details>` with the summary text. Per PRD Section 4.2:
- Header: "Context compacted: {tokensBefore} → {tokensAfter} tokens ({utilizationAfter}% utilization)"
- Expandable body: Full summary text
- Badge: Compaction model used

---

## 5. What Does NOT Change

1. **Server-side clearing** — `clear_tool_uses` and `clear_thinking` continue unchanged
2. **Streaming** — No streaming changes (compaction is a separate non-streaming call)
3. **Token counting** — `estimateTokenCount()` works on whatever messages are passed
4. **Other handlers** — Only `ModelHandlerAnthropic` changes now; others follow later
5. **`createToolUseFollowUpMessages()`** — Works as-is; post-compaction messages are simple

---

## 6. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Summary quality with Haiku** | SDK's proven 5-section prompt. System prompt included for LaTeX context. Monitor in production. |
| **Extra API call latency** | After-response timing = no user-visible delay. Haiku is fast (~1-2s for summarization). |
| **Cost** | Haiku at ~$0.20 per 200K conversation. Far cheaper than Opus compaction iteration. |
| **Lost context** | Structured prompt preserves: task overview, file paths, decisions, errors, next steps. User can scroll full history in UI. |
| **Message mutation** | `structuredClone` before modifying content blocks. No mutation of caller's array. |
| **Compaction of compacted content** | Summary replaces all messages — subsequent compactions re-summarize from fresh conversation, not summary-of-summary. |

---

## 7. Testing Strategy

1. **`shouldCompact()`** — Triggers at threshold. Disabled when 0. Uses input+output tokens.
2. **`compactConversation()`** — Mock API. Verify: tool_use cleanup, summary extraction, message replacement, logging, fallback on error.
3. **`getCompactionModel()`** — Opus→Haiku, Sonnet→Haiku, Haiku→Haiku.
4. **`createResponse()` integration** — Token tracking updated from usage. `updatedMessages` returned when compacted.
5. **Manual test** — Multi-turn tool-use conversation exceeding threshold. Verify compaction fires, progress view shows event, conversation continues.

---

## 8. Relationship to Other Plans

- **Main PRD** (`docs/prd-context-compactization.md`): This plan implements Phase 3 for Anthropic per the PRD's architecture. Key PRD decisions adopted:
  - Section 4.1: CompactionManager strategy pattern (client-side for Anthropic)
  - Section 4.3: Shared `COMPACTION_MODEL_MAP` constant
  - Section 4.5: Compaction inside `createResponse()` (has access to full token context)
  - Section 4.6: Anthropic returns `null` strategy → triggers client-side summarization
  - Section 4.7: `allMessages` single source of truth (long-term; MVP uses `updatedMessages`)
- **Server-side plan** (`docs/plan-claude-server-compactization.md`): Optional future upgrade for Opus 4.6. The PRD explicitly chose client-side over server-side for Anthropic. Server-side plan is preserved as a reference if the team later decides the trade-offs favor it for Opus 4.6.
- **DRY rollout** (PRD Section 4.3.1): After this plan validates the pattern for Anthropic, Google gets its own implementation (different SDK), while DeepSeek, Kimi, and OpenAI Chat share `compactOpenAICompatible()`.

---

## 9. Implementation Order

1. **Shared infrastructure** (Step 1) — Prompt + model map + helper
2. **State + config** (Step 2) — No dependencies
3. **Compaction method** (Step 3) — Depends on 1, 2
4. **createResponse integration** (Step 4) — Depends on 3
5. **Session reset** (Step 5) — Depends on 2
6. **Schema + UI** (Steps 6-7) — Optional polish

Steps 1-5 = MVP. Steps 6-7 = UI enrichment.

---

## 10. PRD Decisions NOT Adopted in MVP

These PRD features are deferred to keep the MVP focused:

| PRD Feature | Section | Deferred To |
|---|---|---|
| `allMessages` single source of truth | 4.7 | Phase 1 (ContextCompactor class) |
| Auto-Compact toggle button | 4.8 | Phase 2 (UI) |
| Compact Now button | 4.9 | Phase 2 (UI) |
| Chat view compaction divider | 5.4 | Phase 4 (UI visibility) |
| Faded messages above divider | 5.4 | Phase 4 (UI visibility) |
| Phase 0 `createResponse()` refactoring | 7, Phase 0 | Separate plan (not blocking) |
