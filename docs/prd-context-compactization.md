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
- **Structured summary prompt**: Enforces sections (Primary Request, Key Concepts, Errors/Fixes, Pending Tasks, Current Work) to retain critical context
- **Manual trigger**: Caller decides when to compact, not automatic

Key takeaway: client-side summarization with a structured prompt is viable and provides full transparency.

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

#### Strategy 1: Anthropic Server-Side Clearing (existing)
- No changes. Continue using `context_management` parameter with `clear_tool_uses` and `clear_thinking`.
- Already well-integrated.

#### Strategy 2: OpenAI Responses API Compaction (existing)
- No changes. Continue using `/responses/compact` endpoint.
- Already well-integrated.

#### Strategy 3: Client-Side Summarization (new -- fallback for all providers)

This is the new capability, used when:
- Provider is OpenAI Chat Completions (no native compaction)
- Provider is Google GenAI (no native compaction)
- Provider is any other handler without native support
- User explicitly requests client-side compaction (override)

**Implementation:**

1. When `shouldCompact()` returns true and no native strategy is available:
2. Take current `messages` array
3. Send to a designated **compactor model** (configurable, defaults to a cheap/fast model) with a structured summarization prompt
4. Replace messages with: `[system_prompt, {role: "assistant", content: summary}]` + any pending user message
5. Record compaction metadata (tokens before/after, what was summarized)

### 4.3 Compactor Model Selection

Add a new configuration:

```json
"texra.model.compactorModel": {
  "type": "string",
  "default": "auto",
  "description": "Model used for client-side context summarization. 'auto' uses the cheapest available model from the active provider, or 'same' uses the current model."
}
```

**"auto" resolution order:**
1. If Anthropic key available: `claude-haiku-4-0`
2. If OpenAI key available: `gpt-4.1-mini`
3. If Google key available: `gemini-2.5-flash-lite`
4. Fall back to current model

### 4.4 Structured Summary Prompt

The compaction prompt must preserve:

| Section | Purpose |
|---------|---------|
| **Task Objective** | Original user request and constraints |
| **Key Decisions** | Important choices made during execution |
| **Tool Results Summary** | Condensed results from tool calls (file contents, search results) |
| **Errors & Corrections** | What went wrong and how it was fixed |
| **Current State** | Exact point of progress, including verbatim code/text being worked on |
| **Pending Work** | What still needs to be done |

The prompt should be defined in a dedicated file (`src/agent/modelHandlers/compactionPrompt.ts`) so it can be iterated on independently.

### 4.5 Integration with ModelHandler Base Class

Extend `ModelHandler.ts`:

```typescript
// New abstract-optional methods
protected getCompactionStrategy(): CompactionStrategy | null {
  return null; // Providers override if they have native support
}

public async compactIfNeeded(messages: Message[]): Promise<CompactionResult> {
  // 1. Check threshold
  // 2. Try native strategy first
  // 3. Fall back to client-side summarization
  // 4. Log compaction event
  // 5. Return new messages + metadata
}
```

Each handler overrides `getCompactionStrategy()`:
- `ModelHandlerAnthropic` → returns `AnthropicClearingStrategy` (existing behavior, no change)
- `ModelHandlerOpenAIResponse` → returns `OpenAICompactStrategy` (existing behavior, no change)
- `ModelHandlerOpenAI` → returns `null` (uses client-side fallback)
- `ModelHandlerGoogleGenAI` → returns `null` (uses client-side fallback)

### 4.6 Message History Preservation

Following neu-translator's pattern, maintain two representations:

1. **Full history** (`allMessages`): Never modified. Used for display and re-compaction.
2. **Active context** (`activeMessages`): Sent to the model. Replaced on compaction.

This is a change from current behavior where messages are mutated in place. The full history must be persisted to the agent execution state so it survives VS Code restarts.

### 4.7 Automatic vs Manual Trigger

- **Automatic**: Existing threshold-based trigger (`compactionThresholdPercent` setting, default 75%) applies to all strategies
- **Manual**: Add a command `texra.compactContext` that users can invoke mid-conversation
  - Useful when users notice the model "forgetting" things
  - Always uses client-side summarization (gives user full visibility)

## 5. UI Changes

### 5.1 Context Utilization Bar (Progress View)

**Current state**: The `UsagePanel` shows token counts and "context left" percentage. The `ContextManagement` component shows compaction events in a log format.

**Proposed changes:**

1. **Context bar indicator**: Add a visual progress bar showing context utilization (green < 50%, yellow 50-75%, red > 75%)
2. **Compaction badge**: When compaction has occurred, show a badge with "Compacted" and the compression ratio (e.g., "72K -> 18K tokens")
3. **Expandable compaction details**: Click the badge to see:
   - Summary text (for client-side compaction)
   - Strategy used (clearing / compact / summarization)
   - What was dropped (tool results count, thinking blocks count)

### 5.2 Chat View (Webview)

1. **Compaction divider**: Insert a visual divider in the chat when compaction occurs, similar to "older messages cleared" in chat apps
   - Shows: "Context compacted -- {strategy} -- {tokens freed}"
   - Collapsed by default; expandable to show summary
2. **Faded messages**: Messages that were compacted away should appear faded/collapsed above the divider (sourced from `allMessages`)
   - Users can scroll up to see full history even though the model no longer "sees" it
   - Clear visual distinction between "in context" and "compacted away"

### 5.3 Manual Compact Command

- Add button in the chat toolbar (next to existing action buttons)
- Tooltip: "Compact conversation context"
- Disabled when utilization is below 25% (compaction would be wasteful)
- Shows confirmation with estimated token savings before executing

## 6. Configuration Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `texra.model.compactionThresholdPercent` | number | 75 | Existing. Threshold for auto-compaction. 0 = disabled. |
| `texra.model.compactorModel` | string | "auto" | New. Model for client-side summarization. |
| `texra.model.enableClientSideCompaction` | boolean | true | New. Enable client-side fallback when native compaction unavailable. |
| `texra.model.enableThinkingClearing` | boolean | false | Existing. Anthropic thinking block clearing. |

## 7. Implementation Plan

### Phase 1: Client-Side Summarization Engine
- Create `CompactionStrategy` interface and `ClientSideSummarizationStrategy`
- Create compaction prompt template
- Add compactor model selection logic
- Add `allMessages` / `activeMessages` split to message management
- Wire into `ModelHandler.compactIfNeeded()`

### Phase 2: Integration with OpenAI Chat & Google Handlers
- Enable auto-compaction for `ModelHandlerOpenAI` and `ModelHandlerGoogleGenAI`
- Add token counting fallback (character-based heuristic) for providers without native counting
- Ensure existing Anthropic and OpenAI Responses paths are unaffected

### Phase 3: UI -- Compaction Visibility
- Add context utilization bar to progress view
- Add compaction divider to chat webview
- Implement faded/collapsed messages for compacted history
- Add compaction badge with expandable details

### Phase 4: Manual Compact Command
- Register `texra.compactContext` command
- Add toolbar button to chat view
- Add confirmation dialog with token savings estimate

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Client-side summary loses critical context | Structured prompt with mandatory sections; user can scroll up to see full history |
| Compactor model call adds latency | Use cheapest/fastest available model; run async before next request |
| Compactor model unavailable (no API key) | Fall back to naive truncation (drop oldest tool results first) |
| Double-compaction (native + client-side) | Strategy selection is exclusive -- never both |
| `allMessages` grows unbounded in memory | Cap at ~500 messages; beyond that, persist to disk and load on demand |

## 9. Success Metrics

- Users on Google/OpenAI Chat models can run conversations 3x longer before hitting context errors
- Compaction events are visible in UI with < 2 clicks
- No regression in Anthropic or OpenAI Responses compaction behavior
- Client-side summarization completes in < 5 seconds with the default compactor model

## 10. Out of Scope

- Cross-session memory / persistent knowledge base (like neu-translator's `Memory` class)
- Automatic prompt optimization / compression (token-level compression)
- Streaming compaction (compacting while the model is still generating)
