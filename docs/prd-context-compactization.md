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

#### Strategy 1: Anthropic Server-Side Clearing (existing)
- No changes. Continue using `context_management` parameter with `clear_tool_uses` and `clear_thinking`.
- Already well-integrated.

#### Strategy 2: OpenAI Responses API Compaction (existing)
- No changes. Continue using `/responses/compact` endpoint.
- Already well-integrated.

#### Strategy 3: Client-Side Summarization via System Prompt Injection (new -- fallback for all providers)

This is the new capability, used when:
- Provider is OpenAI Chat Completions (no native compaction)
- Provider is Google GenAI (no native compaction)
- Provider is any other handler without native support
- User explicitly requests client-side compaction (override)

**Core insight: inject the summary into the system prompt, not into messages.**

Replacing conversation messages with a fake assistant summary message is problematic:
- Breaks tool-use call/result pairs (providers validate these sequences)
- Creates an unnatural message history (assistant "remembering" things it didn't say)
- Requires complex logic to decide which messages to keep vs. replace

Instead, the approach is:

1. When `shouldCompact()` returns true and no native strategy is available:
2. Send the full message history to a **compactor model** with a structured summarization prompt
3. **Append the summary to the system prompt** as a `<conversation-summary>` section
4. **Drop old messages**, keeping only the most recent N turns (configurable, default: last 2 user/assistant pairs)
5. The model now receives: `[system prompt + summary] + [recent messages only]`
6. Record compaction metadata (tokens before/after, summary text)

**Why the system prompt?**
- All providers support system prompts uniformly
- No message sequence validation issues
- The model treats it as authoritative context (system > conversation history)
- Easy to re-summarize: just replace the `<conversation-summary>` section on next compaction
- Works identically across Anthropic, OpenAI, Google, and any future provider

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
  // 4. Return { systemPrompt: systemPrompt + summary, messages: recentOnly, metadata }
}
```

Each handler overrides `getCompactionStrategy()`:
- `ModelHandlerAnthropic` → returns `AnthropicClearingStrategy` (existing behavior, no change -- compaction handled server-side)
- `ModelHandlerOpenAIResponse` → returns `OpenAICompactStrategy` (existing behavior, no change)
- `ModelHandlerOpenAI` → returns `null` → triggers system-prompt summarization
- `ModelHandlerGoogleGenAI` → returns `null` → triggers system-prompt summarization

**System prompt mutation flow:**

```
Original system prompt:
  "You are a LaTeX research assistant..."

After compaction:
  "You are a LaTeX research assistant...

  <conversation-summary>
  ## Task Objective
  User asked to rewrite Section 3 of their paper on quantum error correction...

  ## Current State
  Completed rewrite of 3.1 and 3.2. Working on 3.3 (stabilizer codes).
  Last generated text: "The stabilizer formalism provides..."

  ## Pending Work
  - Complete section 3.3
  - Add citations for [Gottesman1997] and [Knill2005]
  </conversation-summary>"
```

### 4.6 Message History Preservation

Maintain two representations:

1. **Full history** (`allMessages`): Append-only. Used for UI display and for generating the next compaction summary (so repeated compactions don't lose information through summarization-of-summaries).
2. **Active messages** (`activeMessages`): The truncated recent messages actually sent to the model alongside the enriched system prompt.

On each compaction:
- `allMessages` remains unchanged (append-only)
- `activeMessages` is replaced with only the last N turns
- The system prompt gains/updates a `<conversation-summary>` block
- On subsequent compactions, the compactor model receives `allMessages` (not `activeMessages`), so it always works from the full history

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
