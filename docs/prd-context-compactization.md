# PRD: Context Window Compactization

## Status: Draft
## Author: Claude
## Date: 2026-02-02

---

## 1. Problem Statement

TeXRA supports long-running agent conversations (multi-step research, tool-use cycles, reflection loops) that can exhaust a model's context window. Currently, each model handler has its own ad-hoc approach:

- **Anthropic**: Server-side clearing of tool uses and thinking blocks via `context_management` beta parameter
- **OpenAI Responses API**: Opaque `/responses/compact` endpoint that returns encrypted compacted state
- **OpenAI Chat / Google GenAI**: No compaction at all -- only dynamic `max_tokens` reduction, which eventually fails when input alone exceeds the window

This creates several issues:

1. **Inconsistent behavior**: Users on Google or OpenAI Chat models hit hard failures that Anthropic/OpenAI Responses users don't
2. **No user control**: Compaction happens silently; users can't inspect what was dropped or override decisions
3. **Opaque compaction**: OpenAI's encrypted compaction gives zero visibility into what was preserved
4. **No client-side fallback**: When provider-side compaction isn't available, there's no fallback strategy
5. **UI gaps**: The progress view shows compaction *events* but not the *state* of context -- users can't see what the model "remembers"

## 2. Goals

1. **Universal compaction**: Every model handler gets a compaction path, even if the provider doesn't natively support it
2. **Layered strategy**: Prefer provider-native compaction when available; fall back to client-side summarization
3. **User visibility**: Show what was compacted, what remains, and allow manual trigger
4. **Preserve existing behavior**: Provider-native compaction (Anthropic clearing, OpenAI `/compact`) stays as the primary path for those providers

## 3. Reference: neu-translator Approach

The [neu-translator](https://github.com/neutree-ai/neu-translator) project uses a clean client-side compaction design:

- **Dual message arrays**: `messages` (full history, immutable) and `activeMessages` (working set sent to model)
- **Dedicated compactor model**: Uses a cheap/fast model (Gemini Flash Lite) to summarize
- **Structured summary prompt** (`SYSTEM_COMPACT`): Enforces 8 sections -- primary request, key concepts, errors/resolutions, problem-solving, user messages, outstanding tasks, current work status, next steps. Requires `<analysis>` tags for chronological review before the summary.
- **Compaction output replaces `activeMessages`** with a single assistant message containing the summary
- **System prompt is rebuilt each call** via `SYSTEM_WORKFLOW` (incorporating memory + skills), so the model always gets fresh instructions alongside the compacted context

Key takeaway: the **system prompt is the right place** for compacted context. Rather than replacing conversation messages with a fake assistant message (which breaks tool-use chains and feels unnatural), the summary should be injected into the system prompt. The model then receives: `[enriched system prompt with summary] + [only the most recent messages]`. This is simpler, avoids broken message sequences, and works uniformly across all providers.

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
              ┌────────────┼────────────────┐
              ▼            ▼                ▼
     ┌────────────┐ ┌───────────┐  ┌──────────────┐
     │ Anthropic   │ │ OpenAI    │  │ Client-Side  │
     │ Strategy    │ │ Response  │  │ Summarization│
     │ (clearing)  │ │ Strategy  │  │ Strategy     │
     │             │ │ (compact) │  │ (fallback)   │
     └────────────┘ └───────────┘  └──────────────┘
```

### 4.2 Compaction Strategies

#### Strategy 1: OpenAI Responses API Compaction (existing, prioritized)
- Continue using `/responses/compact` endpoint.
- **Works well**: Opaque but effective — handles compaction server-side with good results.
- No changes needed.

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
    const nonToolBlocks = lastMsg.content.filter(b => b.type !== 'tool_use');
    if (nonToolBlocks.length > 0) {
      lastMsg.content = nonToolBlocks;
    } else {
      cleanedMessages.pop();
    }
  }

  // 3. Append summary prompt as user message
  cleanedMessages.push({ role: 'user', content: DEFAULT_SUMMARY_PROMPT });

  // 4. Call API (non-streaming) with cheaper model
  const response = await createResponse(compactionModel, cleanedMessages, { stream: false });

  // 5. Replace ALL messages with single user message containing summary
  const summary = response.content[0].text;
  return {
    compacted: true,
    newMessages: [{ role: 'user', content: summary }]
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

| Provider | Strategy |
|----------|----------|
| OpenAI Responses API | Native `/responses/compact` (keep existing) |
| Anthropic | Client-side (uses Haiku for summaries) |
| Google GenAI (Gemini) | Client-side (uses Flash Lite for summaries) |
| DeepSeek | Client-side (same model, no cheaper option) |
| Kimi (Moonshot) | Client-side (uses moonshot-v1-8k) |
| OpenAI Chat Completions | Client-side (uses gpt-4.1-mini) |

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

**Compaction event logging:**

When compaction occurs, emit a special message type (like existing `CONTEXT_MANAGEMENT`) with the summary inside:

```typescript
// In src/shared/schemas/contextManagement.ts
export const CompactionEventSchema = z.object({
  action: z.literal('compaction'),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  contextWindow: z.number(),
  utilizationBefore: z.number(),
  utilizationAfter: z.number(),
  summary: z.string(),  // The full summary text
  compactionModel: z.string(),
});

// Logger call
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
- `ModelHandlerAnthropic` → returns `AnthropicClearingStrategy` (existing behavior, no change -- compaction handled server-side)
- `ModelHandlerOpenAIResponse` → returns `OpenAICompactStrategy` (existing behavior, no change)
- `ModelHandlerOpenAI` → returns `null` → triggers system-prompt summarization
- `ModelHandlerGoogleGenAI` → returns `null` → triggers system-prompt summarization
- `ModelHandlerDeepSeek` → returns `null` → triggers system-prompt summarization
- `ModelHandlerKimi` → returns `null` → triggers system-prompt summarization
- Any new handler → returns `null` by default (safe fallback)

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

### 4.6 Message History Preservation

**Single source of truth**: `allMessages` is the only persistent message array. There is no separately-maintained "active messages" array that could diverge.

**How it works:**

1. `allMessages`: Append-only array containing the full conversation history. This is the sole source of truth, persisted to agent execution state.

2. At each API call, the messages to send are **derived** (not stored separately):
   - Before compaction: send `allMessages` directly
   - After compaction: send `[summary message]` — old messages are dropped, summary provides context

3. The derivation logic is a pure function:
   ```typescript
   function getMessagesToSend(allMessages: Message[], compactionState: CompactionState | null): Message[] {
     if (compactionState === null) {
       return allMessages; // No compaction yet — send everything
     }
     // Post-compaction — return only the summary message
     // The current user message is appended by the caller
     return [{
       role: 'user', // or 'developer' for OpenAI
       content: `<conversation-summary>${compactionState.summary}</conversation-summary>`
     }];
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

### 4.7 Auto-Compact Toggle (like YOLO mode)

Add an **Auto-Compact toggle button** in the toolbar, following the same pattern as the YOLO mode button (`src/progressView/frontend/constants.ts:154-163`).

**Button definition:**

```typescript
// In src/progressView/frontend/constants.ts
const AUTO_COMPACT_TOGGLE_BUTTON = Object.freeze({
  id: ELEMENT_IDS.AUTO_COMPACT_TOGGLE_BTN,
  icon: 'fold',                    // collapsed state icon
  iconActive: 'unfold',            // expanded/active state icon
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
  AUTO_COMPACT_TOGGLE_BUTTON,  // New
  RESTORE_STATE_BUTTON,
  { ...OPEN_TASK_STORAGE_BUTTON },
];
```

**Behavior:**

| Auto-Compact State | Threshold Exceeded | Action |
|--------------------|-------------------|--------|
| OFF | Yes | Hard fail with "context window exceeded" error |
| ON | Yes | Trigger compaction automatically, then continue |
| ON | No | Normal operation |

### 4.8 Manual "Compact Now" Button

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

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `texra.model.compactionThresholdPercent` | number | 75 | Existing. Threshold for auto-compaction. 0 = disabled. |

Compaction model is determined by constant map (`COMPACTION_MODEL_MAP`), not configurable.

## 7. Implementation Plan

### Phase 0: Refactor createResponse for Modularity

The `createResponse()` methods in model handlers (especially `modelHandlerAnthropic.ts:580+`) are monolithic, mixing:
- Parameter building
- Token counting
- Context management setup
- Streaming vs non-streaming logic
- Response handling

**Proposed refactoring:**

```typescript
// Extract into composable phases
class ModelHandlerAnthropic {
  async createResponse(...) {
    // Phase 1: Build
    const params = this.buildRequestParams(messages, options);

    // Phase 2: Count & Validate (optional)
    const validation = await this.validateContext(params);

    // Phase 3: Compact if needed (NEW)
    if (validation.shouldCompact && this.autoCompactEnabled) {
      const compacted = await this.compactContext(messages);
      params.messages = compacted.messages;
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

| Risk | Mitigation |
|------|------------|
| Client-side summary loses critical context | Structured prompt with mandatory sections; user can scroll up to see full history |
| Compactor model call adds latency | Use cheapest/fastest available model |
| Double-compaction (native + client-side) | Strategy selection is exclusive — never both |

## 9. Success Metrics

- Users on Google/OpenAI Chat models can run conversations 3x longer before hitting context errors
- Compaction events are visible in UI with < 2 clicks
- No regression in Anthropic or OpenAI Responses compaction behavior
- Client-side summarization completes in < 5 seconds with the default compactor model

## 10. Out of Scope

- Cross-session memory / persistent knowledge base (like neu-translator's `Memory` class)
- Automatic prompt optimization / compression (token-level compression)
- Streaming compaction (compacting while the model is still generating)
