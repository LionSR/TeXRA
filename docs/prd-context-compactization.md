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

This is the new capability. It covers all providers that lack a native compaction API:

| Provider | Native Compaction | Needs Client-Side |
|----------|------------------|-------------------|
| Anthropic | Server-side clearing (`context_management`) | No (but available as optional override) |
| OpenAI Responses API | `/responses/compact` endpoint | No (but available as optional override) |
| OpenAI Chat Completions | None | **Yes** |
| Google GenAI (Gemini) | None | **Yes** |
| DeepSeek | None | **Yes** |
| Kimi (Moonshot) | None | **Yes** |
| Any future provider | None by default | **Yes** |

This makes client-side summarization the **default compaction strategy** for the majority of providers. Only Anthropic and OpenAI Responses have native paths.

**Core insight: inject the summary into the system prompt, not into messages.**

Replacing conversation messages with a fake assistant summary message is problematic:
- Breaks tool-use call/result pairs (providers validate these sequences)
- Creates an unnatural message history (assistant "remembering" things it didn't say)
- Requires complex logic to decide which messages to keep vs. replace

Instead, the approach is:

1. When `shouldCompact()` returns true and no native strategy is available:
2. Send the full message history to a **compactor model** with a structured summarization prompt
3. The compactor returns the summary inside a `<conversation-summary>` XML tag
4. Parse the summary using the existing `extractTextFromTag()` utility (`src/utils/text/xmlExtraction.ts:55`)
5. **Drop all old messages**
6. **Prepend the summary as a message** — the original system prompt remains unchanged
7. The model receives: `[original system prompt]` + `[summary message, current user message]`
8. Record compaction metadata (tokens before/after, summary text)

**Post-compaction message structure:**

```
System prompt: "You are a LaTeX research assistant..."  ← unchanged

Messages: [
  { role: "user", content: "<conversation-summary>...[summary content]...</conversation-summary>" },
  { role: "user", content: "[current user request]" }
]
```

For providers supporting developer/system messages in the array (OpenAI), the summary can use `role: "developer"` for clearer separation.

**Why a separate summary message (not injected into system prompt)?**
- System prompt remains stable — agent identity and instructions don't change
- No string manipulation or replacement of `<conversation-summary>` blocks needed
- Clear separation: system prompt = instructions, summary message = context
- The summary is explicitly "context from previous conversation", not part of core instructions

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

Adapted from [neu-translator's `COMPACT_INSTRUCTION`](https://github.com/neutree-ai/neu-translator/blob/main/packages/core/src/prompts/system.compact.ts), modified for TeXRA's XML conventions (output tag is `<conversation-summary>` instead of `<summary>`).

**System prompt for compactor model:**

```
You are a helpful AI assistant tasked with summarizing conversations.
```

**Compaction instruction (sent as user message after the conversation history):**

```
Your task is to create a detailed summary of the conversation so far, paying close
attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing the details that would be essential for
continuing work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize
your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each
   section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions
   - Specific details
   - Pay special attention to specific user feedback that you received, especially
     if the user told you to do something differently.

2. Double-check for accuracy and completeness, addressing each required element
   thoroughly.

Your summary should include the following sections:
1. Primary Request and Intent: Capture all of the user's explicit requests and intents
   in detail
2. Key Concepts: List all important concepts and topics discussed.
3. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay
   special attention to specific user feedback that you received, especially if the
   user told you to do something differently.
4. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
5. All user messages: List ALL user messages that are not tool results. These are
   critical for understanding the users' feedback and changing intent.
6. Pending Tasks: Outline any pending tasks that you have explicitly been asked to
   work on.
7. Current Work: Describe in detail precisely what was being worked on immediately
   before this summary request.
8. Optional Next Step: List the next step that you will take that is related to the
   most recent work you were doing. If your last task was concluded, then only list
   next steps if they are explicitly in line with the users request. Do not start on
   tangential requests without confirming with the user first.

If there is a next step, include direct quotes from the most recent conversation
showing exactly what task you were working on and where you left off. This should be
verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<conversation-summary>
1. Primary Request and Intent:
   [Detailed description]
2. Key Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]
3. Errors and fixes:
   - [Detailed description of error 1]:
   - [How you fixed the error]
   - [User feedback on the error if any]
   - [...]
4. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]
5. All user messages:
   - [Detailed non tool use user message]
   - [...]
   [Should ignore the user message that triggered this compaction]
6. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]
7. Current Work:
   [Precise description of current work]
8. Optional Next Step:
   [Optional next step to take]
</conversation-summary>
</example>

Please provide your summary based on the conversation so far, following this structure
and ensuring precision and thoroughness in your response.
```

**Notes:**
- Output tag is `<conversation-summary>` (parsed via `extractTextFromTag()`)
- The `<analysis>` block is discarded — only `<conversation-summary>` content is injected into the system prompt
- The prompt is stored in `src/agent/modelHandlers/compactionPrompt.ts` so it can be iterated independently

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
