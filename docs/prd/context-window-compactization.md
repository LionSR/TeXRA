# PRD: Context Window Compactization

## Implementation Status

| Item                                          | Severity | Status   | Notes                                              |
| --------------------------------------------- | -------- | -------- | -------------------------------------------------- |
| Anthropic: server-side only, no summarization | HIGH     | Proposed | Clears thinking/tool blocks but doesn't summarize  |
| Google: no compaction at all                  | HIGH     | Proposed | Only reduces max_tokens, no context reduction       |
| OpenAI Chat: heuristic counting, no compaction| HIGH     | Proposed | gpt-tokenizer approximation, no reduction           |
| OpenAI Response: native counting + compaction | MEDIUM   | Exists   | Uses `inputTokens.count()` + `/responses/compact`   |
| No unified compaction strategy across handlers| HIGH     | Proposed | Each handler has different (or no) approach          |
| Progress view: no compaction summary display  | MEDIUM   | Proposed | Events logged but no summary text shown              |
| Session snapshots store full uncompacted history | LOW   | Proposed | Resume after compaction may re-inflate context       |

## Scope: Tool-Use Agents Only

Compactization targets **tool-use agents** exclusively. Here's why:

### Why Tool-Use Agents Need Compaction

Tool-use sessions are **append-only and unbounded**. The `ToolUseCycleFlow` loop
(`PrepNode → CallNode → ProcessNode → DispatchNode → CONTINUE`) accumulates messages
indefinitely: each tool call adds a request + result pair via `DispatchNode.post()`
(L782, L795), each user follow-up is injected by `PrepNode` (L229). Sessions with
20+ cycles are common, and each cycle adds tool call content, tool results (up to
`MAX_TOOL_RESULT_TEXT_LENGTH` = 200K chars), model responses, and thinking blocks.

The conversation is stored as `messages: ProviderMessage[]` in `ToolUseSessionSnapshot`
(v2 flat format) and persisted for resume. Without compaction, long sessions will
overflow the context window and fail.

### Why Workflow Agents Don't Need It

Workflow agents (`ReflectionFlow`) have **fixed round counts** defined in agent YAML
configs. While they do accumulate messages across rounds via `createRoundMessages()`,
the round count is bounded (typically 2–4 rounds). The conversation grows linearly and
predictably — system prompt + user request + N round responses. This fits comfortably
within any model's context window.

Additionally, workflow rounds are semantically complete — each round produces a full
output (e.g., a rewritten document). There's no interleaved tool use or user feedback
to preserve across many turns. The existing `max_tokens` reduction is sufficient.

## Overview

TeXRA's tool-use agent sessions can exhaust the context window during long interactions.
Currently, each model handler has a different (and often incomplete) approach to managing
context pressure:

- **Anthropic** uses server-side `context_management` beta to clear thinking blocks and
  tool results, but never summarizes or removes conversation turns.
- **OpenAI Response API** uses the `/responses/compact` endpoint which produces an
  encrypted compacted representation — effective but opaque and provider-locked.
- **OpenAI Chat API** and **Google GenAI** have no compaction at all. They only reduce
  `max_tokens` when utilization is high, which delays the problem but doesn't solve it.

This PRD proposes a unified, provider-agnostic compaction strategy that works across all
model handlers, with proper progress view feedback and session persistence support.

## Goals

1. Prevent context window overflow across all providers during long tool-use sessions
2. Preserve conversation coherence after compaction (key decisions, pending tasks, user feedback)
3. Provide clear progress view feedback when compaction occurs and what was removed/summarized
4. Maintain session resume fidelity — compacted sessions should resume correctly
5. Maximize prompt cache hit rates after compaction

## Non-Goals

- Compaction for workflow agents (bounded rounds, not needed)
- Automatic prompt optimization or compression
- Changing the agent YAML prompt structure
- Token-level optimization of system prompts

## Current State Analysis

### Per-Provider Token Counting and Compaction

All model handlers now follow a unified **4-phase pattern** inside `createResponse()`:
Build → Count → Validate → Execute (see `docs/prd-token-counting-refactor.md`). Token
counting is separated from the API call, with centralized validation via
`ModelHandler.validateTokenLimits()`.

| Provider        | Count Phase (`estimateTokenCount`)           | Compaction Method              | Limitation                              |
| --------------- | -------------------------------------------- | ------------------------------ | --------------------------------------- |
| Anthropic       | Native API (`countTokens()`)                 | Server-side clearing (beta)    | Only clears blocks, no summarization    |
| OpenAI Response | Native API (`responses.inputTokens.count()`) | `/responses/compact` endpoint  | Opaque encrypted output, no custom control |
| OpenAI Chat     | Heuristic (`gpt-tokenizer`)                  | None                           | Only reduces max_tokens; ~5K buffer     |
| Google GenAI    | Native API (`models.countTokens()`)          | None                           | Only reduces max_tokens                 |
| Kimi            | Native API (via OpenAI Chat override)        | None                           | Only reduces max_tokens                 |

**Key base handler infrastructure:**

- `estimateTokenCount(messages, options?)` — overridable per provider; returns input
  token count. Available to callers outside `createResponse()`.
- `validateTokenLimits(inputTokens, maxTokens, contextWindow)` — centralized in
  `ModelHandler.ts`; returns `TokenValidationResult` with `adjustedMaxTokens`,
  `inputTokens`, `utilizationPercent`.
- `supportsTokenCounting` getter — `true` for Anthropic, Google, OpenAI Response, Kimi;
  `false` for OpenAI Chat (heuristic fallback).

### Existing ToolUseCycleFlow Timing

Understanding the exact call sequence is critical for placing compaction correctly:

```
┌─ ToolUsePrepNode ─────────────────────────────────────────────┐
│  prep():  Check interruption, drain queued follow-ups (L208)  │
│  post():  Inject follow-up messages into shared.messages      │
│           (L229-233 via createUserFollowUpMessages)            │
└───────────────────────────────────────────────┬───────────────┘
                                                ▼
┌─ ToolUseCallNode ─────────────────────────────────────────────┐
│  exec():  modelHandler.createResponse(options) (L288-294)     │
│           ├─ Phase 1 BUILD:  Construct request params          │
│           ├─ Phase 2 COUNT:  estimateTokenCount() (if supported)│
│           ├─ Phase 3 VALIDATE: validateTokenLimits()           │
│           └─ Phase 4 EXECUTE: API call (stream or create)      │
└───────────────────────────────────────────────┬───────────────┘
                                                ▼
┌─ ToolUseProcessNode ──────────────────────────────────────────┐
│  exec():  Extract tool calls, text, server tool data          │
│           normalizeUsage(usage, responseTimeMs) (L454)        │
│           → NormalizedUsage with inputTokens, cachedInputTokens│
│  post():  run.recordCycleMetrics() (L511)                     │
│           Store cycleNormalizedUsage in shared state (L505)   │
└───────────────────────────────────────────────┬───────────────┘
                                                ▼
┌─ ToolUseDispatchNode ─────────────────────────────────────────┐
│  exec():  Execute tool calls batch                            │
│  post():  Push follow-up messages to shared.messages          │
│           (L782 batched, L795 sequential)                     │
│           Return CONTINUE → back to PrepNode                  │
└───────────────────────────────────────────────┘
```

**Key timing insight:** Actual token utilization (via `NormalizedUsage`) is only known
AFTER `ProcessNode` completes. The Count phase inside `createResponse()` runs pre-flight
but is internal to the handler. The flow-level decision point for compaction must use the
**previous cycle's** `NormalizedUsage`.

**Alternative: use `estimateTokenCount()` directly.** Since `estimateTokenCount()` is
now a public method on the base `ModelHandler`, `PrepNode` can call it directly on the
current messages to get an exact pre-compaction token count — without entering
`createResponse()`. This is more accurate than relying on the previous cycle's count
(which doesn't account for new tool results added by `DispatchNode`). However, it costs
an additional API call for providers with native counting. The trade-off:

| Approach                        | Accuracy         | Cost                    |
| ------------------------------- | ---------------- | ----------------------- |
| Previous cycle's `NormalizedUsage` | Slightly stale   | Free (already computed) |
| `estimateTokenCount()` in PrepNode | Exact (current)  | Extra API call per cycle |

**Recommendation:** Use previous cycle's `NormalizedUsage` as the primary trigger. Only
call `estimateTokenCount()` when utilization is near the threshold (e.g., 55–80%) to
confirm whether compaction is actually needed. This avoids unnecessary API calls while
preventing false negatives from stale counts.

### Existing Infrastructure

The codebase already has scaffolding for context management:

- **`contextManagementConstants.ts`** — `DEFAULT_COMPACTION_THRESHOLD_PERCENT` (75%),
  `TOKEN_SAFETY_BUFFER` (10), `HEURISTIC_TOKEN_BUFFER` (5000), `computeReducedMaxTokens()`
- **`ContextManagementData` schema** (AgentLogger L49-68) — supports actions: `compaction`,
  `clear_tool_uses`, `clear_thinking`, `truncation`, `max_tokens_reduced`
- **`ContextStateData` schema** (AgentLogger L76-83) — tracks `inputTokens`, `contextWindow`,
  `utilizationPercent`
- **`updateContextState` event** — emitted via `AgentLogger.logContextState()` (L388-403),
  handled by `UsageEventHandlers` (L55-64)
- **`CONTEXT_MANAGEMENT` message type** — rendered via `formatContextManagementTemplate`
- **`ContextManagement` component** — collapsible display with action icon, stats items
- **`UsagePanel` component** — stream footer showing token counts and context utilization
- **`RunUsageAccumulator`** — tracks `totalCacheReadInputTokens`, `totalCacheCreationInputTokens`

### Reference: neu-translator Approach

The [neu-translator](https://github.com/neutree-ai/neu-translator) project implements a
simple but effective compaction strategy:

- **Manual trigger** via `/compact` command (no automatic detection)
- **Dual-array architecture**: `messages` (full history, never modified) vs `activeMessages`
  (what the model sees, replaced on compaction)
- **Dedicated cheap model** (`gemini-2.5-flash-lite`) for summarization
- **Structured summary prompt** with sections: primary request, key concepts, errors/fixes,
  pending tasks, current work, verbatim user messages

## Proposed Design

### Strategy: Tiered Compaction Pipeline

Compaction operates in escalating tiers, each triggered at a higher utilization threshold:

| Tier | Trigger (% of context) | Action                                    | Reversibility |
| ---- | ---------------------- | ----------------------------------------- | ------------- |
| 0    | < 60%                  | No action                                 | N/A           |
| 1    | 60–75%                 | Clear thinking blocks and tool results    | Reversible    |
| 2    | 75–85%                 | Summarize early conversation turns        | Lossy         |
| 3    | > 85%                  | Aggressive summarization + truncation     | Lossy         |

Tier 1 is already partially implemented for Anthropic (server-side clearing). The main
new work is Tier 2 and Tier 3 — LLM-based summarization.

### Architecture

#### 1. `ContextCompactor` (New — Provider-Agnostic)

A new class in `src/agent/core/` that encapsulates the compaction logic:

```
src/agent/core/ContextCompactor.ts
```

**Responsibilities:**
- Accept `ProviderMessage[]` and current token count / utilization
- Decide which compaction tier to apply
- For Tier 1: delegate to provider-specific clearing (Anthropic beta, or client-side
  removal of thinking/tool blocks for other providers)
- For Tier 2/3: invoke an LLM to produce a structured summary of early turns, then
  replace those turns with a single summary message
- Return compacted `ProviderMessage[]` and metadata about what was removed

**Key design decisions:**
- The compactor operates on `ProviderMessage[]` — each model handler converts to/from
  its native message format
- Summarization uses a **configurable secondary model** (default: a fast/cheap model)
  rather than the primary agent model. This avoids spending expensive tokens on summaries
  and avoids recursive context pressure.
- The compactor preserves the **first user message** (original request) and the **last N
  turns** (recent context), summarizing only the middle.

#### 2. Exact Integration Point and Timing

Compaction must be placed carefully relative to token counting, API calls, and retries.
The decision is informed by when utilization data becomes available.

**Where utilization is known:**

| Source                         | When Available                  | Accuracy         | Provider                                |
| ------------------------------ | ------------------------------- | ---------------- | --------------------------------------- |
| Previous `NormalizedUsage`     | Start of next cycle (PrepNode)  | Exact (post-hoc) | All                                     |
| `estimateTokenCount()` (public)| Callable from PrepNode          | Exact (pre-flight)| Anthropic, Google, OpenAI Response, Kimi|
| Count phase (inside `createResponse`) | Inside `CallNode.exec()` | Exact (pre-flight)| Same as above                          |
| Heuristic estimation           | Inside `CallNode.exec()`        | Approximate      | OpenAI Chat (gpt-tokenizer)             |
| Response `usage` field         | After API returns               | Exact (post-hoc) | All                                     |

**Decision: Compact at `ToolUsePrepNode`, triggered by previous cycle's `NormalizedUsage`.**

This is the correct integration point because:

1. **Previous cycle's usage is exact.** `ProcessNode` (L454) normalizes usage from the
   actual API response. By the time `PrepNode` runs for the next cycle, we have accurate
   `inputTokens` / `contextWindow` from the last call.

2. **`estimateTokenCount()` is now publicly accessible.** The phased architecture
   refactor exposes this method on the base `ModelHandler`. For providers with native
   counting (Anthropic, Google, OpenAI Response, Kimi), `PrepNode` can call it directly
   to get an exact current count before deciding to compact. This avoids the staleness
   issue of relying on previous cycle counts when large tool results were added since.

3. **Cycle boundary is natural.** `PrepNode` already handles follow-up injection (L229).
   Adding compaction here means messages are compacted before any new content is added,
   giving the most accurate view of what the model will see.

4. **Retry safety.** Compaction at `PrepNode` means it runs once per cycle, not on retries.
   The `RetryableInvocationNode` pattern retries `CallNode.exec()` — if compaction were
   inside the call, it would re-run on each retry attempt.

5. **Separate from `validateTokenLimits()`.** The centralized `validateTokenLimits()`
   in the base `ModelHandler` handles max_tokens reduction as a safety net during the
   Validate phase. Compaction is a higher-level concern that runs before entering
   `createResponse()` at all — it reduces the message array itself rather than adjusting
   output token budgets.

**Concrete flow with compaction:**

```
ToolUsePrepNode.prep():
  1. Check interruption
  2. Drain queued follow-ups (L208)

ToolUsePrepNode.post():
  3. Read shared.cycleNormalizedUsage from previous cycle
  4. Compute estimated utilization = inputTokens / contextWindow
  5. IF utilization near threshold (55-80%):
     a. Call modelHandler.estimateTokenCount(shared.messages) for exact count
     b. Update utilization with exact count
  6. IF utilization > compaction threshold:
     a. Invoke ContextCompactor on shared.messages
     b. Replace shared.messages with compacted result
     c. Log CONTEXT_MANAGEMENT event with summary
     d. Update shared.compactionMetadata
  7. Inject follow-up messages into (possibly compacted) shared.messages (L229)
  8. Reset cycle state
```

**Interaction with handler phases:** Compaction in `PrepNode` runs BEFORE
`createResponse()`. The handler's internal phases still execute normally on the
(possibly compacted) messages:
- **Build** constructs params from compacted messages
- **Count** runs `estimateTokenCount()` on the already-compacted messages (redundant
  with step 5a above, but serves as validation)
- **Validate** calls `validateTokenLimits()` — should pass easily after compaction
- **Execute** sends the compacted messages to the API

**Exception:** Anthropic's server-side `context_management` and OpenAI Response's
`/responses/compact` remain in their respective handlers as Tier 1 — they're provider
features that operate at the API level. The `ContextCompactor` handles Tier 2/3 as a
layer above, only when provider-native Tier 1 is insufficient.

#### 3. Per-Handler Tier 1 Responsibilities

| Handler              | Tier 1 Implementation                           | Tier 2/3 Implementation               |
| -------------------- | ------------------------------------------------ | -------------------------------------- |
| Anthropic            | Existing `context_management` beta (server-side) | `ContextCompactor` via PrepNode        |
| OpenAI Response      | Existing `/responses/compact` endpoint           | `ContextCompactor` (fallback)          |
| OpenAI Chat          | Client-side thinking/tool block removal (new)    | `ContextCompactor` via PrepNode        |
| Google GenAI         | Client-side thinking/tool block removal (new)    | `ContextCompactor` via PrepNode        |

#### 4. Summarization Prompt

The summarization prompt produces a structured summary preserving:

1. **Original user request** — verbatim or near-verbatim
2. **Key decisions made** — what was decided and why
3. **Errors encountered and resolved** — to avoid repeating mistakes
4. **Current state** — files modified, tools used, intermediate results
5. **Pending tasks** — explicitly requested work still outstanding
6. **User feedback** — corrections, preferences expressed by the user

The prompt follows the neu-translator pattern of using `<analysis>` (scratchpad) and
`<summary>` (output) XML tags for structured extraction.

### Prompt Caching Synergy

Compaction creates a major opportunity for prompt caching savings. After compaction, the
message array has a structure that is naturally cache-friendly:

```
[System prompt]              ← cached (existing)
[User: original request]     ← cached (existing)
[User: conversation summary] ← NEW stable prefix after compaction
[Recent turns...]            ← changes each cycle
```

The summary message becomes a **stable prefix** that doesn't change between cycles. For
providers with prompt caching, this means subsequent cycles after compaction get cache
hits on the summary — dramatically reducing input token costs.

#### Anthropic Cache Integration

Anthropic's prompt caching uses `cache_control: { type: 'ephemeral' }` markers on
content blocks. Currently, markers are placed on the last eligible block per message
(L1110 in `modelHandlerAnthropic.ts`), with a maximum of 4 cached blocks per request
(L808-846).

**After compaction:**

1. Place `cache_control` on the summary message's text block. Since the summary is
   stable across subsequent cycles, this becomes a **persistent cache hit**.
2. The existing logic already assigns markers to the latest user content block. After
   compaction, the summary IS the latest user content in the prefix section, so it
   naturally gets a marker without special handling.
3. Cost benefit: instead of paying for growing `cache_creation_input_tokens` each cycle
   as the context grows, pay once for the summary and then get `cache_read_input_tokens`
   (discounted) on all subsequent cycles.

#### OpenAI and Google Cache Integration

OpenAI automatic caching works on prefix matches — no explicit markers needed. After
compaction, the stable summary prefix naturally gets cached by OpenAI's system. Google's
`cachedContentTokenCount` similarly benefits from stable prefixes.

**Compaction + caching cost model:**

| Phase           | Without Compaction          | With Compaction                      |
| --------------- | --------------------------- | ------------------------------------ |
| Cycle N (compact)| N/A                        | Summary LLM call cost (cheap model)  |
| Cycle N+1       | Full context (growing)      | Summary (cached) + recent turns      |
| Cycle N+2       | Full context (growing more) | Summary (cached) + recent turns      |
| ...             | Eventually overflows         | Stable until next compaction needed   |

The summary generation cost is amortized across all subsequent cycles that hit the
cache. With a cheap summarization model, this is typically paid back within 1–2 cycles.

### Persistence and Session Resume

#### Snapshot Schema Changes

The `ToolUseSessionSnapshot` (v2 flat format in `ToolUseSessionTypes.ts` L44-55)
currently stores only `messages: ProviderMessage[]`. After compaction, we need to
distinguish between full history and the compacted view.

**Schema extension:**

```typescript
export const ToolUseSessionSnapshotSchema = z.object({
  version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
  // ... existing fields ...
  messages: z.array(ProviderMessageSchema),           // Full history (append-only)
  compactedMessages: z.array(ProviderMessageSchema).optional(), // What the model sees
  compactionSummary: z.string().optional(),            // Last summary text
  compactionCycleIndex: z.number().optional(),         // Cycle at which compaction occurred
  lastUpdated: z.number(),
});
```

**Design decisions:**

- `messages` remains the full append-only history. It is never modified by compaction.
  New messages from `DispatchNode.post()` are pushed to BOTH `messages` and
  `compactedMessages`.
- `compactedMessages` is what `CallNode.exec()` passes to `createResponse()`. Before
  first compaction, it is `undefined` and `messages` is used directly.
- `compactionSummary` and `compactionCycleIndex` are metadata for the progress view
  and for re-compaction decisions on resume.

#### Resume Strategies

When a session is resumed via `SessionResumeRetrieval.ts` (L189-245), the system must
decide how to reconstruct the active message array:

| Strategy                    | When to Use                                    | Trade-off                     |
| --------------------------- | ---------------------------------------------- | ----------------------------- |
| Resume from `compactedMessages` | Default; compacted state is recent and valid | Fast, may miss some context   |
| Resume from `messages` + re-compact | User changed direction or model changed   | Slower, more accurate summary |
| Resume from `messages` (no compaction) | Context fits without compaction          | Full fidelity, only if it fits |

**Default behavior:** Resume from `compactedMessages` if present. The compacted state
already contains the summary + recent turns, and new follow-ups will be injected by
`PrepNode` on top of this. Re-compaction from full history is only needed if the model
or context window changed between sessions.

**Implementation in `SessionResumeRetrieval`:**

```typescript
// In retrieveToolUseResumeData():
const snapshot = ToolUseSessionSnapshotSchema.parse(rawSnapshot);
// If compactedMessages exists, use it as the active message array
// Otherwise, fall back to messages (no prior compaction)
const activeMessages = snapshot.compactedMessages ?? snapshot.messages;
```

#### Backward Compatibility

Use Zod `z.union()` + `.transform()` to handle snapshots from before compaction was
added (following the existing backward compatibility pattern from CLAUDE.md):

```typescript
// New format (has compaction fields)
const NewSnapshotSchema = z.object({ ..., compactedMessages: ..., compactionSummary: ... });
// Legacy format (no compaction fields) transforms to new with defaults
const LegacySnapshotSchema = z.object({ ..., messages: ... })
  .transform((s) => ({ ...s, compactedMessages: undefined, compactionSummary: undefined }));
const SnapshotSchema = z.union([NewSnapshotSchema, LegacySnapshotSchema]);
```

### Robustness

#### Compaction Failure Handling

The summarization call is itself an LLM API call that can fail. The system must handle
failures gracefully without blocking the tool-use session.

**Failure modes and mitigations:**

| Failure Mode                   | Detection                          | Mitigation                                  |
| ------------------------------ | ---------------------------------- | ------------------------------------------- |
| Summarization model unavailable | API error (401, 429, 503)         | Fall back to Tier 1 only; log warning       |
| Summarization times out        | AbortSignal timeout (30s default) | Fall back to Tier 1 only; log warning       |
| Malformed summary output       | XML extraction returns empty       | Retry once with simpler prompt; else Tier 1 |
| Summary too large              | Token count > threshold            | Truncate summary; log warning               |
| Context still too large after Tier 2 | Post-compaction count > window | Escalate to Tier 3 (aggressive truncation)  |

**Key principle:** Compaction is best-effort. If it fails, the session continues with
uncompacted messages and the handler's existing `max_tokens` reduction prevents immediate
overflow. The next cycle will re-attempt compaction.

**Implementation pattern:**

```typescript
// In PrepNode.post():
try {
  const result = await compactor.compact(shared.messages, utilization, signal);
  shared.compactedMessages = result.messages;
  logger.logContextManagement({ action: 'compaction', ... });
} catch (err) {
  // Compaction failed — continue with original messages
  logger.warn(`Compaction failed, continuing with full context: ${err.message}`);
  // Handler's pre-flight token counting will still reduce max_tokens as a safety net
}
```

#### Idempotency

Compaction must be safe to run multiple times on the same messages:

- If `compactedMessages` already starts with a summary message and utilization is below
  threshold, skip compaction entirely.
- The summary message is identified by a marker (e.g., a `[context-summary]` prefix or a
  metadata field) so the compactor knows not to re-summarize its own output.
- If utilization is still above threshold after previous compaction, the compactor
  summarizes the summary + subsequent turns together (progressive compaction).

#### Race Conditions

- **Follow-up injection during compaction:** `PrepNode` drains follow-ups (L208) BEFORE
  compaction runs. This ensures the compactor sees all pending messages.
- **Concurrent sessions:** Each tool-use session has its own `shared.messages` array.
  No cross-session concerns.
- **Snapshot persistence during compaction:** Snapshots are written by `PersistedFlow`
  at cycle boundaries. Since compaction also runs at cycle boundaries (in `PrepNode`),
  the snapshot always reflects the post-compaction state.

### Progress View Display

The progress view is the primary UI surface for tool-use sessions. Compaction events
must integrate naturally into its existing patterns.

#### 5. Context Utilization in UsagePanel (Stream Footer)

The `UsagePanel` component already displays context state as text:
`{inputTokens} / {contextWindow} ({utilizationPercent}%)`.

**Enhancement:** Add a thin progress bar below the text with color coding:

| Utilization | Color  | Meaning                    |
| ----------- | ------ | -------------------------- |
| < 60%       | Green  | Healthy                    |
| 60–75%      | Yellow | Tier 1 clearing may occur  |
| 75–85%      | Orange | Summarization active       |
| > 85%       | Red    | Aggressive compaction      |

The bar uses the existing `ContextStateData` emitted via the `updateContextState` event.
No new events needed — just a visual enhancement to `UsagePanel`.

**Tooltip** on hover: `{inputTokens} / {contextWindow} tokens ({utilizationPercent}%)`

#### 6. Compaction Events as Log Entries

Compaction events are displayed as `LogEntry` items within the tool-use session's
message stream, using the existing `CONTEXT_MANAGEMENT` message type and
`ContextManagement` component. They appear inline at the point where compaction occurred.

**Tier 1 events** (clearing — already partially supported):

Rendered by the existing `ContextManagement` component as a collapsible `<details>`:
- **Header:** Codicon icon + "Context cleared" label with action-specific color
- **Stats:** Tokens before → after, utilization %, context window size
- **Details field:** "Cleared {N} thinking blocks, {M} tool results"

This already works for Anthropic. Extend to Google and OpenAI Chat when Tier 1 is added.

**Tier 2/3 events** (summarization — new):

Extend the `ContextManagement` component to handle a new `summary` field in
`ContextManagementData`:

```
┌─ 🔄 Context compacted (75% → 42%)                    [▾]
│  ┌──────────────────────────────────────────────────┐
│  │ Tokens: 45,200 → 25,100 (44% reduction)         │
│  │ Turns summarized: 12 of 18                       │
│  │ Context: 25,100 / 60,000 tokens                  │
│  │ Cache: summary prefix will be cached              │
│  ├──────────────────────────────────────────────────┤
│  │ Summary                                     [▾]  │
│  │ ┌────────────────────────────────────────────┐   │
│  │ │ User requested implementation of a caching │   │
│  │ │ layer for the API client. Created cache.ts │   │
│  │ │ with LRU eviction. User corrected the TTL  │   │
│  │ │ from 5m to 15m. Tests passing. Pending:    │   │
│  │ │ integration with the retry middleware.      │   │
│  │ └────────────────────────────────────────────┘   │
│  └──────────────────────────────────────────────────┘
└─────────────────────────────────────────────────────────
```

**Implementation in existing components:**

- `ContextManagementDataSchema` — add optional `summary: z.string()` and
  `turnsSummarized: z.number()` fields
- `formatContextManagementTemplate` — detect `summary` field; when present, render a
  secondary collapsible section inside the existing `ContextManagement` component
- `ContextManagement` component — add a `summary` slot/property that renders as a
  nested `<details>` with monospace text, collapsed by default

The outer `<details>` shows the stats (same as Tier 1). The inner `<details>` contains
the summary text — collapsed by default to avoid cluttering the log, but available for
users who want to verify what was preserved.

#### 7. TaskGroup Integration

Compaction events do NOT create new task groups. They are ungrouped log messages that
appear in the tool-use session's flat message stream, consistent with how `STATISTICS`
and existing `CONTEXT_MANAGEMENT` messages are rendered. The `TaskGroupList` component
already handles ungrouped messages first for tool-use sessions (its `isToolUse` flag).

If a compaction event occurs during a tool call cycle, the `groupId` from the current
cycle stage should be attached so it appears within that stage's group rather than
floating as an orphan.

#### 8. StreamHeader Status Indicator

Add a compact context indicator to the `StreamHeader` component, adjacent to the
existing status dot:

- **No indicator** when utilization < 60% (don't clutter the header)
- **Small pill badge** when utilization ≥ 60%: `CTX 72%` with color matching the
  utilization tier (yellow/orange/red)
- Updates reactively via the existing `updateContextState` event

This gives users an at-a-glance signal without needing to scroll to the footer
`UsagePanel`.

### Settings

| Setting                                    | Type    | Default                          | Description                        |
| ------------------------------------------ | ------- | -------------------------------- | ---------------------------------- |
| `texra.model.compactionThresholdPercent`   | number  | 75 (existing)                    | Utilization % to trigger Tier 1    |
| `texra.model.summarizationThresholdPercent`| number  | 80                               | Utilization % to trigger Tier 2    |
| `texra.model.compactionModel`             | string  | `""` (use provider default)      | Model ID for summarization calls   |
| `texra.model.compactionEnabled`           | boolean | true                             | Master toggle for all compaction   |

## Implementation Plan

### Phase 1: Unified Tier 1 (Client-Side Clearing)

Implement client-side thinking/tool block clearing for Google and OpenAI Chat handlers,
matching what Anthropic does server-side. This gives all providers basic context reduction
during tool-use sessions.

**Files to modify:**
- `src/agent/modelHandlers/modelHandlerGoogleGenAI.ts` — add clearing logic
- `src/agent/modelHandlers/modelHandlerOpenAI.ts` — add clearing logic
- `src/agent/modelHandlers/contextManagementConstants.ts` — add Tier 1 threshold if distinct

### Phase 2: ContextCompactor + Summarization (Tier 2/3)

Build the provider-agnostic `ContextCompactor` class and integrate at `PrepNode` in
`ToolUseCycleFlow`. Leverage the phased token counting architecture: use the public
`estimateTokenCount()` method from `PrepNode` for exact pre-compaction counts, and let
the handler's internal Validate phase (`validateTokenLimits()`) serve as a safety net.

**New files:**
- `src/agent/core/ContextCompactor.ts` — core compaction logic
- `src/agent/core/compactionPrompt.ts` — summarization prompt template

**Files to modify:**
- `src/agent/core/flows/ToolUseCycleFlow.ts` — add compaction step to `ToolUsePrepNode.post()`
  after follow-up drain, before message injection; call `estimateTokenCount()` when
  utilization is near threshold for exact counts
- `src/shared/schemas/contextManagement.ts` (in AgentLogger) — extend
  `ContextManagementData` with `summary` and `turnsSummarized` fields

### Phase 3: Session Persistence

Extend snapshot schema and resume logic to support compacted state.

**Files to modify:**
- `src/agent/implementations/flows/tooluse/ToolUseSessionTypes.ts` — add optional
  `compactedMessages`, `compactionSummary`, `compactionCycleIndex` to snapshot v2 schema
  (use Zod union for backward compatibility with snapshots without these fields)
- `src/agent/runtime/SessionResumeRetrieval.ts` — prefer `compactedMessages` over
  `messages` when present; fall back to full history if model/window changed

### Phase 4: Progress View Enhancements

Add context utilization bar, summary display, and header indicator.

**Files to modify:**
- `src/progressView/frontend/components/UsagePanel.ts` — add utilization progress bar
  with color tiers
- `src/progressView/frontend/components/StreamHeader.ts` — add context utilization pill
  badge
- `src/progressView/frontend/components/ContextManagement.ts` — add `summary` property
  with nested collapsible display
- `src/progressView/frontend/formatters/logFormatters/contextManagementFormatters.ts` —
  build summary stat items and pass to component

## Risks and Mitigations

| Risk                                        | Mitigation                                          |
| ------------------------------------------- | --------------------------------------------------- |
| Summary loses critical context              | Preserve first + last N turns; structured prompt     |
| Summarization model unavailable/errors      | Graceful fallback to Tier 1 only; log warning; session continues |
| Double-counting tokens (summary + original) | Replace in `compactedMessages`, never modify `messages` |
| Provider-specific message format breakage   | Compactor works on `ProviderMessage[]`, handlers adapt |
| Cost of summarization calls                 | Use cheap/fast model; amortized by cache savings in 1–2 cycles |
| Compaction during active tool call          | Only compact at cycle boundary (PrepNode), never mid-call |
| Snapshot backward compatibility             | Zod union with legacy transform; `compactedMessages` optional |
| Re-compaction after resume                  | Default to `compactedMessages`; re-compact only if model changed |
| Summary too large to fit in context         | Truncate summary; escalate to Tier 3 |

## Success Metrics

- No context window overflow errors during 20+ cycle tool-use sessions
- Compaction reduces token count by at least 40% when triggered
- Users can see what was compacted via the progress view summary
- All four model handlers support at least Tier 1 compaction for tool-use sessions
- Cache hit rate increases after compaction (measurable via `cachedInputTokens` in `NormalizedUsage`)
- Workflow agents remain unaffected (no compaction overhead)
- Session resume from compacted snapshots works without re-generating summaries
