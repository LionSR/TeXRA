---
created: 2026-02-02
updated: 2026-02-10
---

# PRD: Context Window Compactization

## Status: Draft

## Author: Claude

## Date: 2026-02-02

---

## 1. Problem Statement

TeXRA supports long-running agent conversations (multi-step research, tool-use cycles, reflection loops) that can exhaust a model's context window. Currently, each model handler has its own ad-hoc approach:

- **Anthropic**: Server-side clearing of tool uses and thinking blocks via `context_management` beta parameter (opaque — user can't see what was removed)
- **OpenAI Responses API**: `/responses/compact` endpoint that works well but returns encrypted compacted state
- **OpenAI Chat / Google GenAI / DeepSeek / Kimi**: No compaction at all — only dynamic `max_tokens` reduction, which eventually fails when input alone exceeds the window

This creates several issues:

1. **Inconsistent behavior**: Users on Google or OpenAI Chat models hit hard failures that Anthropic/OpenAI Responses users don't
2. **No user control**: Compaction happens silently; users can't inspect what was dropped or override decisions
3. **Opaque compaction**: Both Anthropic's clearing and OpenAI's encrypted compaction give zero visibility into what was preserved
4. **No client-side fallback**: When provider-side compaction isn't available, there's no fallback strategy
5. **UI gaps**: The progress view shows compaction _events_ but not the _state_ of context — users can't see what the model "remembers"

## 2. Goals

1. **Universal compaction**: Every model handler gets a compaction path, even if the provider doesn't natively support it
2. **Client-side summarization**: Use the same visible summarization approach for all providers except OpenAI Responses API
3. **User visibility**: Show what was compacted, what remains, and allow manual trigger
4. **OpenAI Responses keeps native**: Only OpenAI Responses API continues using `/responses/compact` (it works well)

## 3. Reference: neu-translator Approach

The [neu-translator](https://github.com/neutree-ai/neu-translator) project uses a clean client-side compaction design:

- **Dual message arrays**: `messages` (full history, immutable) and `activeMessages` (working set sent to model)
- **Dedicated compactor model**: Uses a cheap/fast model (Gemini Flash Lite) to summarize
- **Structured summary prompt** (`SYSTEM_COMPACT`): Enforces 8 sections -- primary request, key concepts, errors/resolutions, problem-solving, user messages, outstanding tasks, current work status, next steps. Requires `<analysis>` tags for chronological review before the summary.
- **Compaction output replaces `activeMessages`** with a single assistant message containing the summary
- **System prompt is rebuilt each call** via `SYSTEM_WORKFLOW` (incorporating memory + skills), so the model always gets fresh instructions alongside the compacted context

**Note:** neu-translator injects summaries into the system prompt. We chose a different approach: replace all messages with a single **user message** containing the summary (following the Anthropic SDK pattern). This keeps the system prompt focused on agent identity and avoids mutating it during the conversation. See Section 4.2 for details.

## 4. Proposed Design

### 4.1 Architecture

```
                    ┌──────────────────────┐
                    │   CompactionManager   │  (new, in src/agent/modelHandlers/)
                    │                      │
                    │  shouldCompact()     │
                    │  compact()           │
                    │  getCompactionState()│
                    └──────┬───────────────┘
                           │
              ┌────────────┴────────────────┐
              ▼                             ▼
     ┌───────────────────┐     ┌──────────────────────┐
     │ OpenAI Responses  │     │ Client-Side          │
     │ Strategy          │     │ Summarization        │
     │ (/compact)        │     │ (all other providers)│
     └───────────────────┘     └──────────────────────┘
```

**Note:** Anthropic's server-side `context_management` (clearing tool uses/thinking blocks) is **not used**. All providers except OpenAI Responses API use client-side summarization for consistent, visible compaction.

### 4.2 Compaction Strategies

#### Strategy 1: OpenAI Responses API Compaction (existing, prioritized)

- Continue using `/responses/compact` endpoint.
- **Works well**: Opaque but effective — handles compaction server-side with good results.
- **Token count after compaction**: Count the actual tokens of the compacted messages via `estimateTokenCount()` (the `/responses/input_tokens` endpoint). The compact response's `usage.input_tokens` is the cost of the compact operation's input (original messages), and `usage.output_tokens` may not match the actual input token cost when the compacted items are re-submitted. Direct counting gives the accurate number.
- **Still emit CONTEXT_MANAGEMENT**: Even though compaction is server-side, emit the event for UI visibility using the token counts from the response. The summary field will note "Server-side compaction (details not available)".

```typescript
// Existing implementation in modelHandlerOpenAIResponse.ts
const compactedResponse = await client.responses.compact(compactParams);
const compactedMessages =
  compactedResponse.output as unknown as ResponseInputItem[];
const tokensAfter = await this.estimateTokenCount(compactedMessages, {
  client,
  signal,
  systemPrompt,
  tools: convertedTools,
});

this.logger.logContextManagement(
  `Compacted: ${tokensBefore} → ${tokensAfter} tokens`,
  {
    action: 'compaction',
    tokensBefore,
    tokensAfter,
    contextWindow,
    utilizationBefore,
    utilizationAfter,
    summary: 'Server-side compaction (details not available)',
    compactionModel: this.config.model,
  },
);
```

#### Strategy 2: Client-Side Summarization (for all other providers)

Copy the Anthropic SDK's `_check_and_compact()` pattern but make it work for **all providers** (Anthropic, DeepSeek, Kimi, Gemini, OpenAI Chat, etc.).

**Implementation (from Anthropic SDK `_beta_runner.py`, adapted for TeXRA):**

```typescript
async function checkAndCompact(
  messages: Message[],
  lastUsage: TokenUsage,
  threshold: number,
  compactionModel: string,
): Promise<{ compacted: boolean; newMessages: Message[] }> {
  // 1. Check if compaction needed
  const tokensUsed = lastUsage.inputTokens + lastUsage.outputTokens;
  if (tokensUsed < threshold) {
    return { compacted: false, newMessages: messages };
  }

  // 2. Remove pending tool_use blocks from last message
  const cleanedMessages = [...messages];
  const lastMsg = cleanedMessages[cleanedMessages.length - 1];
  if (lastMsg?.role === 'assistant') {
    const nonToolBlocks = lastMsg.content.filter((b) => b.type !== 'tool_use');
    if (nonToolBlocks.length > 0) {
      lastMsg.content = nonToolBlocks;
    } else {
      cleanedMessages.pop();
    }
  }

  // 3. Append summary prompt as user message
  cleanedMessages.push({ role: 'user', content: DEFAULT_SUMMARY_PROMPT });

  // 4. Call API (non-streaming) with cheaper model
  const response = await createResponse(compactionModel, cleanedMessages, {
    stream: false,
  });

  // 5. Replace ALL messages with single user message containing summary
  const summary = response.content[0].text;
  return {
    compacted: true,
    newMessages: [{ role: 'user', content: summary }],
  };
}
```

**Key change: Check AFTER tool results are added, BEFORE next createResponse.**

The current flow has a gap:

```
1. createResponse() → validates tokens → sends request
2. Model returns tool_use
3. Tool executes → produces result (potentially large)
4. Result appended to messages  ← TOKENS INCREASE HERE
5. createResponse() → [MAY OVERFLOW]
```

**New flow with token count check:**

```
1. createResponse() → sends request
2. Model returns tool_use + usage stats
3. Tool executes → produces result
4. Result appended to messages
5. TOKEN COUNT CHECK  ← NEW
6. If exceeds threshold → compact
7. createResponse() → now within limits
```

**Insertion point:** `ToolUseDispatchNode.post()` in `src/agent/core/flows/ToolUseCycleFlow.ts:764`

```typescript
// In ToolUseDispatchNode.post(), after line 764 (after all follow-up messages pushed)
// and before line 778 (return FlowTransition.CONTINUE)

// NEW: Token count check after tool results attached
const tokenCount = await services.modelHandler.estimateTokenCount(shared.messages);
const threshold = getCompactionThreshold(services.modelHandler.config.contextWindow);

this.logger.logContextState({
  inputTokens: tokenCount,
  contextWindow: services.modelHandler.config.contextWindow,
  utilizationPercent: (tokenCount / services.modelHandler.config.contextWindow) * 100,
});

if (tokenCount > threshold) {
  // Trigger compaction before next createResponse
  const compactionResult = await checkAndCompact(shared.messages, tokenCount, threshold, ...);
  if (compactionResult.compacted) {
    shared.messages = compactionResult.newMessages;
    this.logger.logContextManagement('Context compacted', { ... });
  }
}

return FlowTransition.CONTINUE;
```

This gives visibility into token count right after tool results are attached, and allows compaction before the next API call.

| Provider                | Strategy                                    |
| ----------------------- | ------------------------------------------- |
| OpenAI Responses API    | Native `/responses/compact` (keep existing) |
| Anthropic               | Client-side (uses Haiku for summaries)      |
| Google GenAI (Gemini)   | Client-side (uses Flash Lite for summaries) |
| DeepSeek                | Client-side (same model, no cheaper option) |
| Kimi (Moonshot)         | Client-side (uses moonshot-v1-8k)           |
| OpenAI Chat Completions | Client-side (uses gpt-4.1-mini)             |

**Only OpenAI Responses uses native compaction.** All other providers use the same client-side implementation with provider-appropriate cheaper models.

**Post-compaction state (following Anthropic SDK pattern):**

```
System prompt: "You are a LaTeX research assistant..."  ← unchanged

Messages: [
  { role: "user", content: "[summary from compactor model]" }
]
```

- Replace ALL messages with a single user message containing the summary
- System prompt remains unchanged (agent identity preserved)
- The next user request is appended after the summary message

**Compaction event logging (applies to ALL models):**

When compaction occurs for **any model** (Anthropic, OpenAI Chat, Gemini, DeepSeek, Kimi), emit a `CONTEXT_MANAGEMENT` message with the summary. This creates a visible event in the progress view that users can expand to see what context was preserved.

```typescript
// In src/shared/schemas/contextManagement.ts
export const CompactionEventSchema = z.object({
  action: z.literal('compaction'),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  contextWindow: z.number(),
  utilizationBefore: z.number(),
  utilizationAfter: z.number(),
  summary: z.string(), // The full summary text
  compactionModel: z.string(),
});

// Logger call (same for all providers)
this.logger.logContextManagement('Context compacted', {
  action: 'compaction',
  tokensBefore: 72000,
  tokensAfter: 3000,
  contextWindow: 200000,
  utilizationBefore: 36,
  utilizationAfter: 1.5,
  summary: summaryText,
  compactionModel: 'claude-sonnet-4-5',
});
```

**UI display:** The progress view renders this as a special collapsible block:

- Header: "Context compacted: 72K → 3K tokens (1.5% utilization)"
- Expandable body: Shows the full summary text
- Badge: Shows compaction model used

This makes the summary visible in the progress view and preserves it for debugging/review.

**Why this is simple:**

- No streaming — single blocking call to compactor model
- No message surgery — drop everything, replace with summary
- Works identically across all providers
- Summary preserved in logs for visibility

### 4.3 Compaction Model Selection

Simple constant map — use a capable but faster/cheaper model from the same family:

```typescript
const COMPACTION_MODEL_MAP: Record<string, string> = {
  // Anthropic: opus → sonnet (both 4.5, sonnet is faster)
  'claude-opus-4-5': 'claude-sonnet-4-5',
  'claude-sonnet-4-5': 'claude-sonnet-4-5',

  // OpenAI: gpt-5.2 → gpt-5.2 (same model, summarization uses fewer thinking tokens)
  'gpt-5.2': 'gpt-5.2',

  // Google: pro → flash
  'gemini-3-pro': 'gemini-3-flash',
  'gemini-2.5-pro': 'gemini-2.5-flash',

  // DeepSeek: same model (no cheaper option)
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-chat',

  // Kimi: same model
  'kimi-k2': 'kimi-k2',
  'kimi-k1.5-long': 'kimi-k1.5-long',
};

function getCompactionModel(primaryModel: string): string {
  return COMPACTION_MODEL_MAP[primaryModel] ?? primaryModel;
}
```

Fallback: if model not in map, use the same model.

**No thinking mode for summarizer.** The Anthropic SDK's compaction call doesn't pass thinking parameters — summarization is straightforward and doesn't need extended thinking. Keeps compaction faster and cheaper.

### 4.3.1 DRY Implementation for OpenAI-Compatible Providers

Kimi, DeepSeek, and OpenAI Chat Completions all use the same OpenAI-compatible API format. To avoid code duplication:

```typescript
// src/agent/modelHandlers/compaction/openaiCompatibleCompaction.ts

/**
 * Shared compaction implementation for OpenAI-compatible providers.
 * Used by: ModelHandlerOpenAI, ModelHandlerDeepSeek, ModelHandlerKimi
 */
export async function compactOpenAICompatible(
  client: OpenAI, // OpenAI SDK client (works with any OpenAI-compatible endpoint)
  messages: ChatCompletionMessageParam[],
  compactionModel: string,
  summaryPrompt: string,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> {
  // Append summary prompt as user message
  const compactionMessages = [
    ...messages,
    { role: 'user' as const, content: summaryPrompt },
  ];

  // Non-streaming call to compaction model
  const response = await client.chat.completions.create({
    model: compactionModel,
    messages: compactionMessages,
    stream: false,
  });

  const summary = response.choices[0]?.message?.content ?? '';
  return {
    summary,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}
```

Each handler calls this shared function with its own client:

```typescript
// In ModelHandlerKimi
const result = await compactOpenAICompatible(
  this.client, // Kimi client (OpenAI SDK pointing to Kimi endpoint)
  messages,
  getCompactionModel(this.config.model),
  DEFAULT_SUMMARY_PROMPT,
);

// In ModelHandlerDeepSeek
const result = await compactOpenAICompatible(
  this.client, // DeepSeek client
  messages,
  getCompactionModel(this.config.model),
  DEFAULT_SUMMARY_PROMPT,
);
```

**Anthropic and Google** have different SDK shapes, so they need their own implementations (but follow the same pattern).

### 4.4 Structured Summary Prompt

**Use the Anthropic SDK's `DEFAULT_SUMMARY_PROMPT`** (from `_beta_compaction_control.py`):

```
You have been working on the task described above but have not yet completed it.
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

Wrap your summary in <summary></summary> tags.
```

This is better than neu-translator's prompt — it's more actionable and focused on task continuation.

**Notes:**

- The SDK prompt uses `<summary></summary>` tags, but the SDK code doesn't actually extract from tags — it takes the raw response text
- For consistency with TeXRA's patterns, we can use `<summary>` tags and extract via `extractTextFromTag()`
- Store prompt in `src/agent/modelHandlers/compactionPrompt.ts` so it can be iterated independently

### 4.5 Current Context Validation (Gap Analysis)

**Where validation currently happens:**

Context overflow is checked in `createResponse()` methods **before each API call**:

```
modelHandlerAnthropic.ts:620-631   → estimateTokenCount() → validateTokenLimits()
modelHandlerOpenAI.ts:395-411     → estimateTokenCount() → validateTokenLimits()
modelHandlerGoogleGenAI.ts:491-503 → estimateTokenCount() → validateTokenLimits()
modelHandlerOpenAIResponse.ts:994-1003 → estimateTokenCount() → validateTokenLimits()
```

**Current gap: Tool results can overflow BETWEEN validation and append.**

The tool-use flow is:

```
1. createResponse() → validates tokens → sends request
2. Model returns tool_use
3. Tool executes → produces result (potentially large)
4. Result appended to messages
5. createResponse() → validates tokens → [MIGHT OVERFLOW HERE]
```

The problem: between steps 4 and 5, the messages array grows with potentially large tool results. If the result pushes total tokens over the context window, step 5 will hard-fail.

**How compaction addresses this:**

With auto-compact enabled, step 5 becomes:

```
5. createResponse():
   a. estimateTokenCount()
   b. IF tokens > threshold: compactIfNeeded() → summarize → replace messages
   c. validateTokenLimits() → now passes
   d. send request
```

Compaction happens **before validation**, so large tool results trigger compaction rather than failure.

### 4.6 Integration with ModelHandler Base Class

Extend `ModelHandler.ts`:

```typescript
// New methods on ModelHandler base class
protected getCompactionStrategy(): CompactionStrategy | null {
  return null; // Providers override if they have native support
}

public async compactIfNeeded(
  systemPrompt: string,
  messages: Message[]
): Promise<CompactionResult> {
  // 1. Check threshold via estimateTokenCount()
  // 2. If native strategy exists (Anthropic/OpenAI Responses), defer to it (no-op here)
  // 3. Otherwise: send messages to compactor model → get summary
  // 4. Return { systemPrompt: systemPrompt + summary, messages: [], metadata }
  //    All old messages are dropped; only the current user message will be appended by the caller
}
```

Each handler overrides `getCompactionStrategy()`:

- `ModelHandlerOpenAIResponse` → returns `OpenAICompactStrategy` (existing `/responses/compact` endpoint)
- `ModelHandlerAnthropic` → returns `null` → triggers client-side summarization
- `ModelHandlerOpenAI` → returns `null` → triggers client-side summarization
- `ModelHandlerGoogleGenAI` → returns `null` → triggers client-side summarization
- `ModelHandlerDeepSeek` → returns `null` → triggers client-side summarization
- `ModelHandlerKimi` → returns `null` → triggers client-side summarization
- Any new handler → returns `null` by default (safe fallback)

**Why not use Anthropic's `context_management`?** The server-side clearing (removing tool uses and thinking blocks) is opaque and loses context. Client-side summarization preserves the conversation summary visibly in the message history, giving users transparency into what the model "remembers".

**Example post-compaction API call:**

```
System prompt (unchanged):
  "You are a LaTeX research assistant. Help the user with their academic writing..."

Messages array:
  [
    {
      role: "user",
      content: "<conversation-summary>
        1. Primary Request: Rewrite Section 3 on quantum error correction
        2. Key Concepts: stabilizer codes, Gottesman-Knill theorem
        3. Errors and fixes: Fixed citation format per user feedback
        4. Current Work: Completed 3.1 and 3.2, working on 3.3
        5. Pending Tasks: Complete 3.3, add citations [Gottesman1997], [Knill2005]
        </conversation-summary>"
    },
    {
      role: "user",
      content: "Continue with section 3.3 on stabilizer codes"
    }
  ]
```

### 4.7 Message History Preservation

**Single source of truth**: `allMessages` is the only persistent message array. There is no separately-maintained "active messages" array that could diverge.

**How it works:**

1. `allMessages`: Append-only array containing the full conversation history. This is the sole source of truth, persisted to agent execution state.

2. At each API call, the messages to send are **derived** (not stored separately):
   - Before compaction: send `allMessages` directly
   - After compaction: send `[summary message]` — old messages are dropped, summary provides context

3. The derivation logic is a pure function:
   ```typescript
   function getMessagesToSend(
     allMessages: Message[],
     compactionState: CompactionState | null,
   ): Message[] {
     if (compactionState === null) {
       return allMessages; // No compaction yet — send everything
     }
     // Post-compaction — return only the summary message
     // The current user message is appended by the caller
     return [
       {
         role: 'user', // or 'developer' for OpenAI
         content: `<conversation-summary>${compactionState.summary}</conversation-summary>`,
       },
     ];
   }
   ```

**Why not a dual-array design?**

Maintaining two arrays (`allMessages` + `activeMessages`) creates an invariant that every append must update both. This is error-prone — any code path that forgets to update both causes silent divergence. By deriving the active set from `allMessages` + compaction state, correctness is guaranteed.

On each compaction:

- `allMessages` remains unchanged (append-only)
- `compactionState` is updated with the new summary and timestamp
- The system prompt remains unchanged — summary is prepended as a message
- Subsequent compactions re-summarize from `allMessages` (the full history), avoiding lossy summarization-of-summaries

**UI display**: The webview renders from `allMessages`, showing the full conversation with a visual divider indicating which messages are "in context" vs "compacted away".

### 4.8 Auto-Compact Toggle (like YOLO mode)

Add an **Auto-Compact toggle button** in the toolbar, following the same pattern as the YOLO mode button (`src/progressView/frontend/constants.ts:154-163`).

**Button definition:**

```typescript
// In src/progressView/frontend/constants.ts
const AUTO_COMPACT_TOGGLE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.AUTO_COMPACT_TOGGLE_BTN,
  icon: 'fold', // collapsed state icon
  iconActive: 'unfold', // expanded/active state icon
  command: COMMANDS.TOGGLE_AUTO_COMPACT,
  title: 'Enable auto-compact (summarize context when threshold exceeded)',
  titleActive: 'Auto-compact active - click to disable',
  className: 'auto-compact-toggle-button',
  isToggle: true,
});

// Add to TOOL_USE_TOOLBAR alongside YOLO button
const TOOL_USE_TOOLBAR = [
  STOP_STREAM_BUTTON,
  YOLO_TOGGLE_BUTTON,
  AUTO_COMPACT_TOGGLE_BUTTON, // New
  RESTORE_STATE_BUTTON,
  { ...OPEN_TASK_STORAGE_BUTTON },
];
```

**Behavior:**

| Auto-Compact State | Threshold Exceeded | Action                                          |
| ------------------ | ------------------ | ----------------------------------------------- |
| OFF                | Yes                | Hard fail with "context window exceeded" error  |
| ON                 | Yes                | Trigger compaction automatically, then continue |
| ON                 | No                 | Normal operation                                |

### 4.9 Manual "Compact Now" Button

In addition to the auto-compact toggle in the toolbar, add a **Compact Now** button in the **follow-up input section** alongside the existing action buttons (Polish, Record, Clear, Send).

**Location:** `src/progressView/frontend/components/FollowUpInput.ts:196-237`

The follow-up input has a vertical action column:

```
┌─────────────────────────────────────────┐
│ [Textarea]            │ [Polish]        │
│                       │ [Record]        │
│                       │ [Clear]         │
│                       │ [Compact] ← NEW │
│                       │ [Send]          │
└─────────────────────────────────────────┘
```

**Button definition:**

```typescript
// In FollowUpInput.ts render() method, add to .follow-up-actions
<vscode-toolbar-button
  id=${ELEMENT_IDS.COMPACT_NOW_BTN}
  icon="fold-down"
  label="Compact context"
  title="Compact conversation context (summarize history to free tokens)"
  @click=${this.emitCompact}
></vscode-toolbar-button>
```

**Behavior:**

- Visible when stream is in tool-use mode (not workflow)
- Always enabled (no threshold check — user decides when to compact)
- On click: dispatches `COMPACT_NOW` command
- Shows progress ring during compaction (like Polish button)

**Why in follow-up input area?**

- User is actively chatting → compaction is a chat-related action
- Follows the existing pattern (Polish, Record, Clear, Send are all chat actions)
- Auto-compact toggle stays in toolbar (system-level setting)
- Compact Now is contextual to the current input

## 5. UI Changes

### 5.1 Auto-Compact Toggle Button (StreamHeader Toolbar)

Location: `src/progressView/frontend/components/StreamHeader.ts`

**Single new toggle button** (like YOLO):

- Toggle button with active/inactive states
- Visual glow when active (blue instead of red)
- Persisted per-stream
- Located in toolbar next to YOLO toggle

**Styling:**

```css
.auto-compact-toggle-button {
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.auto-compact-toggle-button.is-active {
  color: var(--color-info);
  background-color: color-mix(in srgb, var(--color-info) 15%, transparent);
  border-radius: var(--border-radius);
  box-shadow: 0 0 8px color-mix(in srgb, var(--color-info) 40%, transparent);
}
```

### 5.2 Compact Now Button (FollowUpInput)

Location: `src/progressView/frontend/components/FollowUpInput.ts`

Added to the vertical action column alongside Polish, Record, Clear, Send. See section 4.8 for details.

### 5.3 Context Utilization Indicator

Existing `UsagePanel` already shows token counts. After compaction, show "Compacted: 72K → 18K" badge.

### 5.4 Chat View Compaction Divider

1. **Visual divider**: When compaction occurs, insert a divider in the message list
   - Text: "Context compacted — {tokens freed} tokens freed"
   - Expandable to show summary
2. **Faded messages**: Messages above the divider appear faded (from `allMessages`)
   - User can scroll up to see full history
   - Clear visual distinction: "in context" vs "compacted away"

## 6. Configuration Summary

| Setting                                  | Type   | Default | Description                                            |
| ---------------------------------------- | ------ | ------- | ------------------------------------------------------ |
| `texra.model.compactionThresholdPercent` | number | 75      | Existing. Threshold for auto-compaction. 0 = disabled. |

Compaction model is determined by constant map (`COMPACTION_MODEL_MAP`), not configurable.

## 7. Implementation Plan

### Phase 0: Refactor createResponse for Modularity

The `createResponse()` methods in model handlers (especially `modelHandlerAnthropic.ts:580+`) are monolithic, mixing:

- Parameter building
- Token counting (with provider-specific tools)
- Context management setup
- Streaming vs non-streaming logic
- Response handling

**Why this is the right place for compaction:** The `createResponse()` method has access to:

1. Provider-specific tool format (e.g., `anthropicTools`)
2. Full token count including tools, system prompt, thinking config
3. Context window limits and validation

The token check in `ToolUseDispatchNode.post()` only provides a lower-bound estimate without tools. The actual compaction trigger must happen in `createResponse()` where we have full context.

**Proposed refactoring:**

```typescript
// Extract into composable phases
class ModelHandlerAnthropic {
  async createResponse(...) {
    // Phase 1: Build
    const params = this.buildRequestParams(messages, options);

    // Phase 2: Count & Validate
    const validation = await this.validateContext(params);

    // Phase 3: Compact if needed (NEW - before throwing context window error)
    if (validation.shouldCompact && this.autoCompactEnabled) {
      const compacted = await this.compactContext(messages);
      params.messages = compacted.messages;
      // Re-validate after compaction
    }

    // Phase 4: Execute
    return this.executeRequest(params, options);
  }
}
```

This makes compaction a clean plug-in phase rather than deeply embedded logic.

### Phase 1: Client-Side Summarization Engine

- Create `ContextCompactor` class in `src/agent/modelHandlers/contextCompaction/`
- Implement `COMPACTOR_SYSTEM_PROMPT` and `COMPACT_INSTRUCTION` prompts
- Add `extractTextFromTag()` call for `<conversation-summary>`
- Add `compactionState` to agent execution state schema

### Phase 2: Auto-Compact Toggle

- Add `AUTO_COMPACT_TOGGLE_BTN` to `constants.ts` (following YOLO pattern)
- Add `TOGGLE_AUTO_COMPACT` command
- Wire toggle state through `ProgressViewMessageHandler`
- Persist per-stream (like YOLO state)

### Phase 3: Integration with Handlers

- Add `compactIfNeeded()` to `ModelHandler` base class
- Integrate into OpenAI Chat, Google GenAI, DeepSeek, Kimi handlers
- Ensure Anthropic and OpenAI Responses use their native paths

### Phase 4: UI -- Compaction Visibility

- Add context utilization bar to `UsagePanel`
- Add compaction divider to chat webview
- Implement faded messages for compacted history
- Add compaction badge with expandable summary

## 8. Risks and Mitigations

| Risk                                       | Mitigation                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Client-side summary loses critical context | Structured prompt with mandatory sections; user can scroll up to see full history |
| Compactor model call adds latency          | Use cheapest/fastest available model                                              |
| Double-compaction (native + client-side)   | Strategy selection is exclusive — never both                                      |

## 9. Success Metrics

- Users on Anthropic/Google/OpenAI Chat models can run conversations 3x longer before hitting context errors
- Compaction events are visible in UI with < 2 clicks
- No regression in OpenAI Responses compaction behavior
- Client-side summarization completes in < 5 seconds with the default compactor model

## 10. Out of Scope

- Cross-session memory / persistent knowledge base (like neu-translator's `Memory` class)
- Automatic prompt optimization / compression (token-level compression)
- Streaming compaction (compacting while the model is still generating)

## 11. Implementation Progress

### Completed

- **Token count check after tool results** (2026-02-03): Added token count logging in `ToolUseDispatchNode.post()` at `src/agent/core/flows/ToolUseCycleFlow.ts:778-808`. Only runs for providers with native token counting support (`supportsTokenCounting`). Logs context utilization after tool results are attached and before the next `createResponse()`.

  **Limitation:** This is a lower-bound estimate (messages + systemPrompt only). Tool definitions are not included because each provider uses a different format (`anthropicTools`, etc.). Full accuracy requires the compaction check to happen inside `createResponse()` where provider-specific tools are already built — see Phase 0 refactoring.

- **Retired diagnostic logging for token count investigation** (added 2026-02-03; retired 2026-08-01): Temporary `[TOKEN_DIAG]` logs compared the pre-flight estimate with response usage. They were removed after the investigation scaffolding had no active consumer or regression test and required hidden cross-method state with five cleanup paths.

  Current debug observability retains the pre-flight count and an explicit record when response usage omits `input_tokens`, alongside the existing max-token-reduction and unsafe-chaining records. It does not retain the former paired difference, percentage, message/tool-count, reasoning-token, output-token, or context-utilization fields. If this investigation resumes with a current reproduction, add structured, test-backed observability rather than searching for `[TOKEN_DIAG]`.

- **~~Fix: estimateContextTokens() for correct delta handling~~** (2026-02-03): REMOVED. This method was added to fix delta handling in `ToolUseCycleFlow`, but the entire token counting block in `ToolUseCycleFlow` was subsequently removed (see below), making this method dead code.

- **Fix: Pass tools to token counting endpoint** (2026-02-03): Updated `ModelHandlerOpenAIResponse.estimateTokenCount()` to accept and pass `tools` and `systemPrompt` to OpenAI's `/responses/input_tokens` endpoint. Previously, only `input` and `previous_response_id` were passed, causing the count to miss tool definition tokens.
  - `estimateTokenCount()` now builds params matching the actual API call (model, input, previous_response_id, instructions, tools)
  - `createResponse()` now passes `systemPrompt` and `convertedTools` to `estimateTokenCount()`

- **Cleanup: Remove redundant token counting from ToolUseCycleFlow** (2026-02-03): Removed the token counting block from `ToolUseDispatchNode.post()`. This code was redundant because:
  1. **createResponse() already does accurate token counting**: The flow is Prep → Call → Process → Dispatch → (loop), where Call invokes `createResponse()` which performs accurate token counting with all parameters (tools, systemPrompt, previous_response_id)
  2. **Redundant API calls**: ToolUseCycleFlow's token counting added an extra `/responses/input_tokens` call on every iteration
  3. **Less accurate**: ToolUseCycleFlow couldn't pass tools (requires provider-specific conversion done in createResponse), making it a lower-bound estimate

  Also removed the now-unused `estimateContextTokens()` method from `ModelHandler` and `ModelHandlerOpenAIResponse`.

### In Progress

- PRD finalization and review

### Pending

- Phase 0: Refactor createResponse for modularity
- Phase 1: Client-side summarization engine
- Phase 2: Auto-compact toggle
- Phase 3: Integration with handlers
- Phase 4: UI — compaction visibility

### Known Issues

- ~~**BUG: Token count mismatch between ToolUseCycleFlow and createResponse**~~ **RESOLVED** (2026-02-03): Removed the redundant token counting from ToolUseCycleFlow entirely. The authoritative token counting happens inside `createResponse()`, which has access to all parameters (tools, systemPrompt, previous_response_id).

- **ARCHIVED INVESTIGATION: OpenAI Responses API token counting mismatch** (recorded 2026-02-03; diagnostic retired 2026-08-01): A historical report using `previous_response_id` showed the UI at "32% context left" before the API returned `context_length_exceeded`. No current reproduction or automated regression remains attached to this PRD, so the temporary paired `[TOKEN_DIAG]` instrumentation was retired rather than kept as permanent logging.

  OpenAI's `/responses/input_tokens` documentation says that conversation items are prepended for a response request, and the current pre-flight call includes provider-formatted tools and instructions. If the mismatch recurs, open a current issue with a minimal reproduction and add structured observability that compares the immediate pre-flight estimate, response usage (including reasoning/output tokens), and error token details. Do not rely on the removed `[TOKEN_DIAG]` text logs.

### Future Optimizations

- **Token counting latency**: ~~Currently `estimateTokenCount()` is called after every tool completion.~~ RESOLVED: Removed redundant token counting from ToolUseCycleFlow. The authoritative token counting in `createResponse()` already happens per iteration and includes all parameters. Future optimization: track cumulative token usage from API responses (`lastUsage`) and skip the pre-flight `estimateTokenCount()` call when utilization is low (e.g., <50%).
- **Configurable compaction model**: Add `compactionModel` property to `ModelConfig` (requires llm-zoo changes).
- **Button icons**: Consider using `layers` or `archive` codicons instead of `fold/unfold` for clearer compaction metaphor.
