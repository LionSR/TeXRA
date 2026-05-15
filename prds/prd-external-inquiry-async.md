# PRD: Non-blocking `inquiry` — Async Q&A with the User

**Status:** Draft (v0.1)
**Owner:** TBD
**Date:** 2026-05-15
**Related issue:** [#4023 — external_inquiry should not block](https://github.com/LionSR/TeXRA/issues/4023)

> **Naming.** The model-facing tool is renamed from `external_inquiry` to `inquiry` — shorter, parallel with `odyssey`/`memory`/`executions`, and "external" was implicit. Internal class/file names (`ExternalInquiryTool.ts`, `ExternalInquiryPanel.ts`, schema names like `ExternalInquiryThreadManifestSchema`) keep their current names for diff-locality; a mechanical rename pass is an independent follow-up.

## 1. Summary

Today the `external_inquiry` tool blocks the agent's tool-use cycle on an in-memory Promise. The user must paste an external-model answer back before any further work can happen, and closing the tab or restarting VS Code abandons the wait. This makes the tool brittle for its actual usage pattern: the user copies the question to ChatGPT/Gemini/Claude, waits minutes for an answer, then comes back.

This PRD makes the tool — renamed `inquiry` — **non-blocking and durable**. The tool returns `dispatched` immediately. The user can paste the answer hours later — even after a reload. When the answer lands, a continuation message is injected into the originating stream's follow-up queue and the agent auto-resumes. Multiple inquiries dispatched in the same turn live independently; each resumes the agent on arrival.

Mechanism mirrors **Odyssey's** continuation-injection pattern (`ToolUseFollowUpQueue.appendFollowUp`) — no new runtime, no polling, no background worker.

## 2. Goals

- `inquiry` returns immediately with a `dispatched` marker; the cycle does not wait on a human round-trip to ChatGPT.
- An answer submitted at any later time (including after extension reload) reaches the originating stream and auto-resumes the agent.
- Open inquiries are discoverable in the existing Background Tasks panel alongside subagents and bash sessions.
- Multi-turn inquiries on the same `thread_id` render as a conversation transcript.
- Zero new infrastructure: reuse the durable thread manifest already on disk and the existing follow-up queue.

## 3. Non-goals

- **No user-initiated inquiries.** The tool stays agent-driven. The user cannot start a thread from the panel.
- **No per-inquiry directives** (Wait / Work-in-parallel / Queries-OK). Tried during design; collapsed away. The agent's tool description teaches it not to re-dispatch on an open thread; if the user is overwhelmed, the fix is the prompt, not a runtime flag.
- **No stream-level toggle for parallel inquiries.** Same reason.
- **No new "Sent" acknowledgement step.** Whether the user has actually pasted into ChatGPT is invisible to the system and irrelevant to the agent.
- **No batching/debouncing of continuations.** Two near-simultaneous answers enqueue two continuations; they drain together at the wait node naturally.
- **No drop-feedback text** beyond a status flag.

## 4. Background — current behavior

`ExternalInquiryTool.execute()` (src/tools/inquiry/ExternalInquiryTool.ts:250) creates a Promise stored in an in-memory `pendingInquiries: Map`. `awaitExternalInquiryResponse` emits `showExternalInquiry`, then awaits. The Promise resolves when the user clicks Submit/Reject in the panel.

`ToolUseDispatchNode` (src/agent/core/flows/ToolUseCycleFlow.ts:546) runs _independent_ inquiry calls concurrently via a special carve-out, but the cycle still joins on `Promise.all` — every inquiry must settle before the next turn.

`cleanupApprovalsForStream` (src/tools/approval/index.ts:41) rejects all pending inquiries when a stream is cleaned up. Pending state is purely in-memory, so reload also abandons the wait.

Durable on-disk state already exists (`src/tools/inquiry/externalInquiryStorage.ts`): per-thread manifest with question + answer + session links + per-turn directories under `ei_threads/<id>/`.

## 5. Lifecycle

```
                  ┌─ recordOpenQuestion ────► OPEN
   agent ─────►   │                            │
   dispatches     │                            ├──► Submit answer ──► ANSWERED
                  │                            │      │
                  │                            │      └─► enqueueContinuation(parentStream)
                  │                            │           │
                  │                            │           └─► cycle resumes
                  │                            │
                  │                            └──► Reject (Drop) ──► DROPPED
                  │                                   │
                  │                                   └─► enqueueContinuation("dropped")
```

Three statuses: `open`, `answered`, `dropped`. Transitions are append-only on disk.

## 6. Architecture

### 6.1 Data model

Extend `ExternalInquiryThreadManifestSchema` in `src/tools/inquiry/externalInquiryStorage.ts`:

```typescript
const ExternalInquiryThreadManifestSchema = z.looseObject({
  threadId: ExternalInquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema, // NEW
  status: z.enum(['open', 'answered', 'dropped']), // NEW
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
});
```

Per-turn record gains an optional `answer` — a turn with `answer === undefined` is the open turn. Legacy single-shot turns (always atomic Q+A) load as `answered` via a Zod union/transform per the project's backward-compat pattern.

Optional per-turn `draft: { answer: string; sessionLinks: string }` field to persist the panel's textarea state across reloads (debounced write). Replaces the in-module `draftCache` in `ExternalInquiryPanel.ts`.

New shared schema in `src/shared/schemas/`:

```typescript
const ExternalInquiryThreadSummarySchema = z.object({
  threadId: ExternalInquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema,
  status: z.enum(['open', 'answered', 'dropped']),
  lastQuestionPreview: z.string(),
  lastActivityIso: z.iso.datetime(),
  turnCount: z.int().nonnegative(),
});
```

Cheap to render in the Background Tasks section without loading full Q/A bodies.

### 6.2 Storage helpers

Additions in `externalInquiryStorage.ts`:

```typescript
recordOpenQuestion({threadId?, parentStreamId, question, context, attachFiles, ...})
  ─► PersistedOpenTurn

recordAnswerForOpenTurn({threadId, answer, sessionLinks})
  ─► PersistedAnsweredTurn

markDropped({threadId})
  ─► void

listOpenThreads(): Promise<ExternalInquiryThreadSummary[]>
listOpenThreadsForStream(streamId): Promise<ExternalInquiryThreadSummary[]>
```

Existing `persistExternalInquiryTurn` (atomic Q+A) becomes a thin shim around the two split calls, or is removed if no other caller needs it.

### 6.3 Tool behavior

The tool gains a subcommand shape — see §14. Below describes the `ask` subcommand (default, current dispatch behavior).

`ExternalInquiryTool.execute({command: 'ask', …})`:

1. `recordOpenQuestion()` capturing `parentStreamId = context.streamId`.
2. Emit existing `showExternalInquiry` event so the panel appears.
3. Emit new `inquiryThreadUpdated` event for the Background Tasks panel.
4. Return `ToolResult` immediately:
   ```typescript
   {
     status: 'dispatched',
     thread_id,
     message:
       'Question dispatched to the user. The tool returned without waiting. ' +
       'You will be woken with a continuation message when an answer arrives. ' +
       'Do NOT re-dispatch on this thread_id. ' +
       'If your next step depends on this answer, end your turn now; ' +
       'otherwise proceed with independent work.',
   }
   ```

Delete `pendingInquiries: Map`, `awaitExternalInquiryResponse`, `_rejectPendingInquiriesForStream`, `_rejectAllPendingInquiries`.

### 6.4 Action handler

`handleExternalInquiryAction(payload)` becomes purely persistence + continuation:

- Submit: `recordAnswerForOpenTurn()` → `enqueueContinuationForAnsweredThread(threadId)`.
- Reject: `markDropped()` → `enqueueContinuationForDroppedThread(threadId)`.

### 6.5 Continuation injection

New file `src/tools/inquiry/inquiryContinuation.ts` — single-purpose, ~30 lines. **No PocketFlow changes** — we ride on the existing static `ToolUseFollowUpQueue.enqueue` already used by Odyssey and the GitHub subscription registry.

```typescript
export async function enqueueContinuationForAnsweredThread(
  threadId: ExternalInquiryThreadId,
): Promise<void> {
  const manifest = await readExternalInquiryThread(threadId);
  if (!manifest) return;

  const lastTurn = manifest.turns.at(-1);
  if (!lastTurn?.answer) return;

  const stillOpenOnStream = await listOpenThreadsForStream(
    manifest.parentStreamId,
  );

  const text = buildContinuationText({
    answered: {
      id: threadId,
      question: lastTurn.question,
      answer: lastTurn.answer,
    },
    stillOpen: stillOpenOnStream,
  });

  // Returns false (and logs/discards) if the parent stream was released.
  // That's our "parent gone" signal — answer stays on disk, UI badges the
  // thread as "answered · parent finished" and no resume fires.
  ToolUseFollowUpQueue.enqueue(manifest.parentStreamId, text);
}
```

**Why this works without touching PocketFlow.** `ToolUseFollowUpQueue.enqueue` is non-blocking and handles all three relevant cases for us:

- Stream parked at `ToolUseWaitNode` → queue notifies waiter → cycle wakes naturally.
- Stream mid-turn → followup sits in the buffer; drained at the next `ToolUseWaitNode` boundary.
- Stream released → returns `false`; we treat as persist-only.

The mechanism is identical to how Odyssey's `appendFollowUp` and the GitHub `StreamSubscriptionRegistry` already drive resumption. No node behavior changes, no new accessor, no preemption.

The injected text is enqueued as a **user-role** message via `ToolUseFollowUpQueue.enqueue(parentStreamId, text)` (same role used by Odyssey continuations and `appendFollowUp`).

Continuation text shape — three variants, deterministic templates.

**Variant A — answered, other inquiries still open on this stream:**

```
[inquiry] ei_b22c answered.
Q: <question, truncated to 400 chars>
A: <answer, truncated to 2000 chars; full text via inquiry { command: 'read', thread_id }>

Still open on this stream:
  - ei_a1f0  "Prove Lemma 3.2 …"  (dispatched 12m ago)

Proceed using the new answer. Do not re-dispatch any open thread_id.
```

**Variant B — answered, no other inquiries open on this stream:**

```
[inquiry] ei_b22c answered.
Q: <question, truncated to 400 chars>
A: <answer, truncated to 2000 chars; full text via inquiry { command: 'read', thread_id }>

No other open inquiries on this stream.

Proceed using the new answer.
```

**Variant C — dropped by user:**

```
[inquiry] ei_b22c dropped by user.
Q: <question, truncated to 400 chars>

Still open on this stream:
  - ei_a1f0  "Prove Lemma 3.2 …"  (dispatched 12m ago)

Proceed without this answer — either re-formulate (new thread) or take an
alternate approach. Do not re-dispatch ei_b22c.
```

(The "Still open" block is omitted in the dropped variant when no other open inquiries exist, parallel to Variant B.)

All three variants are produced by `buildContinuationText({ event, manifest, stillOpenOnStream })` where `event` is `'answered' | 'dropped'`. The "still open" list and the recovery instruction are the only dynamic pieces; the `[inquiry]` prefix, the `Q:` / `A:` lines, and the truncation policy are fixed.

### 6.6 Cycle changes

`src/agent/core/flows/ToolUseCycleFlow.ts`: delete the entire concurrent-inquiry block (`CONCURRENT_EXTERNAL_INQUIRY_TOOL`, `_concurrentCallIds`, `_duplicateCallIds`, `buildConcurrentCallIds`, `getExternalInquiryFollowupThreadKey`, `isConcurrentExternalInquiryCall`, `buildConcurrentFailureResult`) — roughly lines 460–600. Net deletion; nothing replaces it. The tool no longer blocks, so the cycle's default sequential dispatch is fine.

### 6.7 Cleanup

`src/tools/approval/index.ts` (lines 41, 55): remove `_rejectPendingInquiriesForStream` and `_rejectAllPendingInquiries` calls. Closing a tab no longer rejects open inquiries; the durable thread keeps them addressable. Orphaned threads (parent stream gone) stay listed in the inquiries section; their answers persist to disk but no continuation fires.

### 6.8 UI — Background Tasks section

`packages/extension/src/progressView/frontend/components/BackgroundTasksPanel.ts` gains a third sub-section parallel to `SUBAGENTS` and `BASH`:

```
▼ ❓ INQUIRIES · 2 OPEN · 1 ANSWERED
    💬 "Sobolev constant on bounded Ω"   open  (12m)
    💬 "Prove Lemma 3.2 …"               open  (12m)
    💬 "Series convergence rate"         ✓ answered  (1h)
```

Click → focuses the inquiry panel for that thread. Hydration on extension activation via `listOpenThreads()`. One new event type `inquiryThreadUpdated` carries `ExternalInquiryThreadSummary` payloads.

### 6.9 UI — inquiry panel

`packages/extension/src/progressView/frontend/components/ExternalInquiryPanel.ts`. Two targeted changes:

1. **Conversation view.** Render the full transcript as alternating agent-question / user-answer bubbles, in chronological order. The open turn (if any) is the last entry, with the question bubble visible and the answer area below it. No collapsing of prior turns — this is a conversation, not a log. Auto-scroll to the open turn on focus.
2. **Persistent draft.** Move draft state from the in-module `draftCache: Map` to the manifest's open-turn `draft` field, debounced (~500ms).

Buttons unchanged: `Copy` (on the open question), `Submit Answer`, `Reject` (→ `dropped`). No new buttons. Copy buttons on prior agent questions remain for re-querying the external model on a follow-up.

## 7. Mockups

### 7.1 State machine

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  agent calls inquiry { command: 'ask', … }                       │
   │  └─► recordOpenQuestion                                          │
   │      └─► status=OPEN; manifest written; tool returns "dispatched"│
   │          └─► cycle continues; this turn ends idle                │
   └─────────────────────────────────────────────────────────────────-┘
                          │
                          │   (minutes or hours pass)
                          │
   ┌──────────────────────▼───────────────────────────────────────────┐
   │  user opens panel, pastes answer, clicks Submit                  │
   │  └─► recordAnswerForOpenTurn                                     │
   │      └─► status=ANSWERED                                         │
   │          └─► enqueueContinuationForAnsweredThread                │
   │              └─► ToolUseFollowUpQueue.enqueue(parent, text)      │
   │                  └─► cycle wakes; next turn starts with the      │
   │                      synthesized "[inquiry] …" message  │
   └──────────────────────────────────────────────────────────────────┘
```

### 7.2 Before / after timeline

```
  CURRENT (blocking):
  T0  agent: inquiry { command: 'ask', question: 'Sobolev constant…' }
  T0  tool emits showExternalInquiry, awaits Promise
       ┊  ░░░░░░░░░░░░░░░░░░░  cycle paused (in-memory)
       ┊                       user cannot run another agent on this tab
       ┊                       reload → answer lost
  T+45m user submits answer
  T+45m Promise resolves, tool returns, cycle continues

  PROPOSED (async):
  T0  agent: inquiry { command: 'ask', question: 'Sobolev constant…' }
  T0  recordOpenQuestion; tool returns {dispatched}
  T0  cycle continues; agent does Turn 7, 8, …
       ┊  (other independent work runs in parallel)
       ┊  if reload happens here → inquiry still in INQUIRIES section
  T+45m user submits answer
  T+45m enqueueContinuation → cycle wakes
  T+45m Turn N starts with "[inquiry] ei_… answered. Q: … A: …"
```

### 7.3 Background Tasks panel — new section

```
┌─ Background Tasks ────────────────────────────────────────[▼]─┐
│ ▼ ▣ SUBAGENTS · 4 ACTIVE · 5 DONE                             │
│     🤖 leanSearch  (Auditing FT completion path…)    waiting  │
│     🤖 lean        (Implementing Phase D…)           waiting  │
│     🤖 lean        (Assembling global gauge X…)      running  │
│     🤖 lean        (Finishing global gauge X…) (1s)  running  │
│                                                               │
│ ▼ ❓ INQUIRIES · 2 OPEN · 1 ANSWERED                  ← NEW   │
│     💬 "Sobolev constant on bounded Ω"     open      (12m)    │
│     💬 "Prove Lemma 3.2 from manuscript"   open      (12m)    │
│     💬 "Series convergence rate"           ✓ answered (1h)    │
│                                                               │
│ ▶ >_ BASH · 2 RUNNING · 18 DONE                               │
└───────────────────────────────────────────────────────────────┘
```

### 7.4 Inquiry panel — open, single question

```
┌─ 💬 ei_b22c · inquiry ───────────────────────────────────[×]──┐
│ parent: ch3-revisions · dispatched 12m ago                    │
│ ────────────────────────────────────────────────────────────  │
│                                                               │
│  Q1  (open)                                                   │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Cross-check the Sobolev inequality constant on a       │  │
│  │ bounded domain Ω ⊂ ℝⁿ. State whether the optimal C     │  │
│  │ for ‖u‖_{2*} ≤ C‖∇u‖₂ depends on |Ω| …                 │  │
│  └─────────────────────────────────────────────────────────┘  │
│  [📋 Copy]   [↗ ChatGPT]   [↗ Gemini]   search: yes           │
│  attach: ch3.tex, ch3-figs/                                   │
│                                                               │
│  Your answer:                                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ ▌                                                       │  │
│  │                                                         │  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
│  Session links (optional):                                    │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                                                         │  │
│  └─────────────────────────────────────────────────────────┘  │
│                          [Reject ▼]    [Submit Answer ▶]      │
└───────────────────────────────────────────────────────────────┘
```

### 7.5 Inquiry panel — full conversation view

All turns render as alternating bubbles. Agent questions left-aligned, user answers right-aligned and inset. The open turn (if any) is last, with its answer area inline below the question bubble. No collapsed/expandable summaries — every prior turn is fully visible.

```
┌─ 💬 ei_b22c · inquiry ─────────────────────────────────────[×]──┐
│ parent: ch3-revisions · 3 turns · last activity 30s ago         │
│ ──────────────────────────────────────────────────────────────  │
│                                                                 │
│  ◆ agent · Q1 · 1h ago                                          │
│  ╭─────────────────────────────────────────────────────╮        │
│  │ State the optimal Sobolev constant for Ω ⊂ ℝⁿ        │ [📋]   │
│  │ when sp < n, and identify any dependence on |Ω|.    │        │
│  ╰─────────────────────────────────────────────────────╯        │
│                                                                 │
│                              ◇ you · A1 · 45m ago ──────────╮   │
│                            ╭───────────────────────────────╮ │   │
│                            │ For sp < n, C = (n(n-sp))⁻¹ · │ │   │
│                            │ ω_n^{s/n}; depends only on    │ │   │
│                            │ n. Reference: Brezis, ch. 9.  │ │   │
│                            ╰───────────────────────────────╯ │   │
│                                          session: chatgpt.com │   │
│                                                                 │
│  ◆ agent · Q2 · 40m ago                                         │
│  ╭─────────────────────────────────────────────────────╮        │
│  │ Show the dimensional analysis derivation step by    │ [📋]   │
│  │ step, including the scaling argument.               │        │
│  ╰─────────────────────────────────────────────────────╯        │
│                                                                 │
│                              ◇ you · A2 · 32m ago ──────────╮   │
│                            ╭───────────────────────────────╮ │   │
│                            │ Take u_λ(x) = u(λx). Then     │ │   │
│                            │ ‖u_λ‖_{2*} = λ^{-n/2*}‖u‖…    │ │   │
│                            ╰───────────────────────────────╯ │   │
│                                                                 │
│  ◆ agent · Q3 · 30s ago    (open)                               │
│  ╭─────────────────────────────────────────────────────╮        │
│  │ Follow-up: does the same hold for fractional        │ [📋]   │
│  │ Sobolev W^{s,p} when sp < n?                        │        │
│  ╰─────────────────────────────────────────────────────╯        │
│  [↗ Continue ChatGPT]   suggest: search · attach: ch3.tex       │
│                                                                 │
│                              ◇ your answer ───────────────────╮ │
│                            ┌───────────────────────────────┐  │ │
│                            │ ▌                             │  │ │
│                            │                               │  │ │
│                            └───────────────────────────────┘  │ │
│                            session links: …                   │ │
│                                                                 │
│                              [Reject ▼]   [Submit Answer ▶]     │
└─────────────────────────────────────────────────────────────────┘
```

Notes:

- Each prior agent question keeps its own `[📋]` copy button so the user can re-query an external model on it.
- Prior answers show the session-link footer in compact form (one line).
- Scroll position defaults to the open turn on first focus; user can scroll up to review.
- For threads with many turns (>10), virtualize the older bubbles — same rendering, lazy mount.

### 7.6 Parent stream — compact inquiry cards

```
┌─ ch3-revisions ────────────────────────────────────[run]──┐
│ Turn 6                                                    │
│   agent: "I need two external checks before §4.3…"        │
│                                                           │
│   ┌─ 💬 ei_a1f0 ─────────────────── [Open panel ↗]─┐      │
│   │  "Prove Lemma 3.2 from manuscript"  open · 12m │      │
│   └────────────────────────────────────────────────┘      │
│   ┌─ 💬 ei_b22c ─────────────────── [Open panel ↗]─┐      │
│   │  "Sobolev constant on bounded Ω"    open · 12m │      │
│   └────────────────────────────────────────────────┘      │
│                                                           │
│ Turn 7   ⚡ auto-resumed from ei_b22c                      │
│   ✓ ei_b22c answered                                      │
│   ◐ ei_a1f0 still open                                    │
│   agent: "Applying C = π²/6 to estimate (4.2)…"           │
│   ✏ edit §4.tex                                           │
│                                                           │
│ Turn 8   ⚡ auto-resumed from ei_a1f0                      │
│   ✓ ei_a1f0 answered                                      │
│   agent: "Lemma 3.2 proof matches; finalizing §3…"        │
└───────────────────────────────────────────────────────────┘
```

### 7.7 What the agent receives on resume

```
┌─ injected as next user message ───────────────────────────┐
│ [inquiry] ei_b22c answered.                      │
│ Q: Cross-check the Sobolev inequality constant on a       │
│    bounded domain Ω ⊂ ℝⁿ. State whether the optimal C     │
│    for ‖u‖_{2*} ≤ C‖∇u‖₂ depends on |Ω| …                 │
│ A: For dimensions n ≥ 3, C = (n(n-2))⁻¹ · ω_n^{2/n}       │
│    depends only on n; independent of |Ω|. Brezis ch. 9 …  │
│                                                           │
│ Still open on this stream:                                │
│   - ei_a1f0  "Prove Lemma 3.2 from manuscript"            │
│     (dispatched 12m ago)                                  │
│                                                           │
│ Proceed using the new answer. Do not re-dispatch any      │
│ open thread_id.                                           │
└───────────────────────────────────────────────────────────┘
```

## 8. Edge cases

| Case                                                       | Behavior                                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension reload while inquiry open                        | Open inquiries hydrate into the Background Tasks section on next activation. Submitting still injects a continuation if the parent stream is alive.                    |
| Parent stream deleted while inquiry open                   | Thread stays listed (orphan badge). Submit persists answer to disk; no continuation fires.                                                                             |
| User submits empty answer                                  | Existing validation (`ToolError('External inquiry answer cannot be empty.')`) preserved.                                                                               |
| Two answers land within ms                                 | Two `ToolUseFollowUpQueue.enqueue` calls in order; the wait node's drain delivers both followups together at the next wait boundary. No special-case batching.         |
| Agent re-dispatches same `thread_id` while open            | Storage layer rejects with `ToolError('Thread already has an open question; wait for answer or call Drop.')`. Belt-and-suspenders with the tool-description guardrail. |
| Agent follows up on an `answered` thread via `ask`         | Status returns to `open`, new turn appended, `parentStreamId` updates to caller (§13.4). Panel reopens with prior turns rendered as conversation bubbles (§7.5).       |
| Agent follows up on a `dropped` thread via `ask`           | Storage layer rejects with `ToolError('Thread was dropped by user; start a new thread instead.')`. `dropped` is terminal.                                              |
| Follow-up from a different stream than the original        | Allowed. `parentStreamId` updates to the caller; continuation flows back to that stream (§13.5). Original stream retains its answered turns.                           |
| Agent dispatches multiple inquiries in one turn            | Each independently durable. Each answer arrival fires its own continuation; agent gets woken multiple times, last-open marker shrinks each time.                       |
| User submits answer for a thread whose parent has finished | Persist to disk; show "answered (no resume — parent finished)" badge in Background Tasks.                                                                              |

## 9. Migration

- **Manifest schema.** Existing manifests have no `parentStreamId` or `status`. Zod union/transform pattern (CLAUDE.md §"Backward Compatibility with Zod"): legacy form parses to `{status: 'answered', parentStreamId: null, …}`. `null` parent disables continuation but preserves history.
- **Existing in-flight inquiries on upgrade.** On extension upgrade with the new code, any in-memory `pendingInquiries` from a prior session are already gone (in-memory only). No-op.
- **Agent prompts.** Update the `inquiry` tool description to emphasize the non-blocking semantics (already done in §6.3 message field). Agent YAML tool lists referencing `external_inquiry` must be updated to `inquiry` (e.g., `packages/extension/resources/tool_use_agents/chat.yaml` and its inheritors).

## 10. Tests

Vitest (`src/test-kernel/`):

- `externalInquiryStorage.vitest.ts`: open → answer round-trip; dropped path; legacy manifest migration; concurrent-write lock for the same thread.
- `inquiryContinuation.vitest.ts`: continuation text shape (single-answer, partial-still-open, all-answered, dropped); parent-gone path returns `false` from `ToolUseFollowUpQueue.enqueue` and is a no-op.
- `ExternalInquiryTool.vitest.ts`: `ask` returns `dispatched` and never awaits; re-dispatch on open thread errors; follow-up on `answered` thread reopens with parent-stream update; follow-up on `dropped` thread errors; `read` returns full transcript; `list` filters correctly across status (`open`/`answered`/`dropped`/`any`) and scope (`stream`/`all`).

Mocha integration (`src/test/`):

- End-to-end: dispatch → reload → resume hydration shows open in Background Tasks → submit → continuation injected → cycle resumes.

## 11. Rollout

- Single PR or pair of small PRs (storage → tool/cycle/continuation → UI). Not feature-flagged. The change is internal to a tool that is already opt-in via the agent YAML (`tool_use_agents/chat.yaml` and any inheritors).
- CHANGELOG entry under "Features": _"External inquiries no longer block the agent — answers can be submitted at any time and resume the run automatically."_

## 12. File-by-file

| File                                                                              | Action                                                                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/inquiry/externalInquiryStorage.ts`                                     | Add `parentStreamId`, `status`, open-turn support, draft field, list helpers; Zod union for legacy migration               |
| `src/tools/inquiry/ExternalInquiryTool.ts`                                        | Return `dispatched` synchronously; delete pending-map + reject helpers; action handler delegates to storage + continuation |
| `src/tools/inquiry/inquiryContinuation.ts`                                        | **New** — continuation-text builder + queue injector                                                                       |
| `src/tools/inquiry/index.ts`                                                      | Drop reject exports                                                                                                        |
| `src/tools/approval/index.ts`                                                     | Drop inquiry reject calls in `cleanupApprovalsForStream` and `cleanupAllApprovals`                                         |
| `src/agent/core/flows/ToolUseCycleFlow.ts`                                        | Delete concurrent-inquiry block (~140 LoC deletion)                                                                        |
| `src/shared/schemas/inquiry.ts` (or wherever existing inquiry types live)         | Extend manifest schema; new `ExternalInquiryThreadSummarySchema`; `inquiryThreadUpdated` event payload                     |
| `src/eventBus/ProgressEventBus.ts`                                                | Add `inquiryThreadUpdated` event                                                                                           |
| `packages/extension/src/progressView/frontend/components/BackgroundTasksPanel.ts` | Add INQUIRIES section parallel to SUBAGENTS/BASH                                                                           |
| `packages/extension/src/progressView/frontend/components/ExternalInquiryPanel.ts` | Transcript view for prior turns; draft persistence to manifest                                                             |
| `packages/extension/src/progressView/frontend/components/RequestPanels.ts`        | Inline inquiry render → compact "Open panel" card                                                                          |
| `packages/extension/src/progressView/frontend/contexts/streamContexts.ts`         | Add `inquiryThreadContext`                                                                                                 |
| `packages/extension/src/progressView/frontend/slices/inquiryThreadsSlice.ts`      | **New** — subscribes to `inquiryThreadUpdated`, hydrates on first load                                                     |
| `packages/extension/src/progressView/ProgressViewProvider.ts`                     | Hydrate `listOpenThreads()` on activation; wire events                                                                     |

## 13. Subcommand surface (endpoint tool shape)

Reshape the tool (now `inquiry`) from a one-shot dispatch into a small command-style endpoint, parallel to `odyssey`, `memory`, `executions`. Single tool name, discriminated union input.

### 13.1 Commands

| Command         | Inputs                                                                      | Purpose                                               | Returns                                                                        |
| --------------- | --------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ask` (default) | `question`, optional `thread_id`, `context`, `suggestSearch`, `attachFiles` | Dispatch a new question (current behavior, now async) | `{status: 'dispatched', thread_id}`                                            |
| `read`          | `thread_id`                                                                 | Read full transcript of one thread, untruncated       | `{thread_id, status, turns: [{question, answer?, sessionLinks?, timestamp}…]}` |
| `list`          | optional `status`, `scope`                                                  | Enumerate inquiry threads by status                   | `{threads: ExternalInquiryThreadSummary[]}`                                    |

### 13.2 Schema

Each command and field carries a `.describe()` string so the model has enough guidance at call time without referring back to this PRD. Strings below are the spec — implementer should copy them verbatim into the Zod schema.

```typescript
const AskSchema = z.object({
  command: z
    .literal('ask')
    .prefault('ask')
    .describe(
      'Dispatch a question to the user (who will consult an external AI model). ' +
        'Returns immediately with {status: "dispatched", thread_id}. ' +
        'Do NOT wait — the answer arrives as a separate [inquiry] continuation message later.',
    ),
  question: z
    .string()
    .describe(
      'The self-contained question. The external model has NO context from this conversation; ' +
        'include all definitions, notation, and problem setup directly.',
    ),
  thread_id: ExternalInquiryThreadIdSchema.nullish().describe(
    'Omit to start a new thread. Pass an existing answered thread_id to ask a follow-up — ' +
      'prior Q/A in that thread is preserved and shown to the user. ' +
      'Passing a thread_id that is still open or dropped will error.',
  ),
  context: z
    .string()
    .nullish()
    .describe(
      'Short note shown to the user explaining why this question is being asked.',
    ),
  suggestSearch: z
    .boolean()
    .nullish()
    .describe(
      'Set true when the external model should enable web search for this question.',
    ),
  attachFiles: z
    .array(z.string())
    .nullish()
    .describe(
      'Workspace-relative paths the user should upload to the external model.',
    ),
});

const ReadSchema = z.object({
  command: z
    .literal('read')
    .describe(
      'Read the full untruncated transcript of one inquiry thread. ' +
        'Use this when a [inquiry] continuation truncated content you need, ' +
        'or when revisiting an earlier thread.',
    ),
  thread_id: ExternalInquiryThreadIdSchema.describe('The thread to read.'),
});

const ListSchema = z.object({
  command: z
    .literal('list')
    .describe(
      'Enumerate inquiry threads. Filter by status to find what is still pending, what has been ' +
        'answered, or what was dropped. Useful for self-orientation after multiple wake-ups, ' +
        'before starting a new turn after a long pause, or to recover a forgotten thread_id.',
    ),
  status: z
    .enum(['open', 'answered', 'dropped', 'any'])
    .prefault('open')
    .describe(
      '"open" → awaiting user answer (default — matches the most common need). ' +
        '"answered" → user has submitted an answer. ' +
        '"dropped" → user rejected the inquiry. ' +
        '"any" → all threads regardless of status.',
    ),
  scope: z
    .enum(['stream', 'all'])
    .prefault('stream')
    .describe(
      '"stream" → only threads belonging to this stream; "all" → every stream\'s threads.',
    ),
});

const ExternalInquiryInputSchema = z.discriminatedUnion('command', [
  AskSchema,
  ReadSchema,
  ListSchema,
]);
```

### 13.3 Why these three

- **`ask`** — the dispatch path, covering both new threads (omit `thread_id`) and follow-ups (pass `thread_id`). Default via `.prefault('ask')` so existing tool calls that omit `command` keep working without schema change. See §13.4 for follow-up semantics.
- **`read`** — recovers full Q/A bodies when the continuation message's truncation (Q ≤ 400, A ≤ 2000) would otherwise lose information. Mostly mitigates Open Question §14.2.
- **`list`** — lets the model self-orient when it has been woken multiple times across long-running work or after a long pause. `status='open'` is the most common need and the default; `status='answered'` recovers earlier-resolved threads (forgotten thread_id, cross-stream review); `status='dropped'` surfaces user-rejected inquiries the agent may want to retry differently; `status='any'` gives the full picture.

### 13.4 Follow-up semantics — `ask` with `thread_id`

A single `ask` call covers both new threads and follow-ups on existing ones. Behavior depends on the target thread's current status:

| Target status           | Behavior on `ask` with that `thread_id`                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(no thread_id)_        | Start a new thread; new `threadId` minted; `parentStreamId = context.streamId`.                                                                                                                                                                                                                                                                |
| `answered`              | **Follow-up turn.** Append a new open turn to existing manifest. Transition status `answered → open`. Update `parentStreamId` to the caller's stream (continuation flows back to the asker, even if a different stream than the original). Panel reopens; all prior turns render as conversation bubbles above the new open question per §7.5. |
| `open`                  | Reject with `ToolError('Thread already has an open question; wait for answer or call Drop.')`. Same guard as §8 edge case; belt-and-suspenders with the tool-description.                                                                                                                                                                      |
| `dropped`               | Reject with `ToolError('Thread was dropped by user; start a new thread instead.')`. `dropped` is terminal.                                                                                                                                                                                                                                     |
| _(thread_id not found)_ | Reject with `ToolError('External inquiry thread not found: <id>.')` (existing behavior in `resolveExistingThread`).                                                                                                                                                                                                                            |

The `recordOpenQuestion()` helper handles all four valid transitions atomically under the existing per-thread write lock. UI implications:

- A thread that goes `answered → open` re-appears in the Background Tasks INQUIRIES section as `open`, with `turnCount` incremented.
- The inquiry panel transcript (§6.9, §7.5) shows N prior turns as a conversation above the newly-open question.
- The previous parent stream sees no continuation for the new turn; only the new asker does. (Discussed in §13.6 below.)

### 13.5 Cross-stream follow-ups

A thread originally dispatched from stream A can be followed up from stream B. Use case: the user starts a chat in `ch3-revisions`, gets an answer, then later opens `ch4-revisions` and the agent there wants to dig deeper on the same external context.

- **`parentStreamId` always updates** to the caller on follow-up. The continuation flows to whoever just asked.
- Stream A retains the answered Q/A turns it dispatched; nothing is removed.
- The Background Tasks INQUIRIES section is scoped per-stream — the thread moves into stream B's list when reopened.
- `read` and `list` are stream-agnostic for inspection; either stream can `read` the full transcript or `list` with `scope='all'`.

### 13.6 What is NOT included

- **`drop`** — user-driven action only. The agent does not get to give up on an inquiry it dispatched; that would let it dodge its own questions.
- **`submit_answer`** — exclusively user-driven via the panel.
- **`update_question`** — the agent should issue a new follow-up turn on the same `thread_id` (via `ask`) instead, preserving history. Editing a prior question would break the audit chain.

### 13.7 Implementation

All three commands route through `ExternalInquiryTool.execute()` with a switch on `command`. `read` and `list` are pure storage reads — no UI emission, no continuation, no panel impact. `ask` handles new threads, follow-ups, and the three rejection cases in §13.4. Roughly +60 LoC in the tool, no change anywhere else.

## 14. Open questions

1. **Where draft state lives during edit.** Manifest field (debounced) is reload-safe but writes often. Alternative: keep in-memory until first blur, then persist. Recommendation: debounce on edit, persist on blur, both update the manifest.
2. **Truncation lengths in the continuation message.** Current draft: Q ≤ 400 chars, A ≤ 2000 chars, full text on disk. Open to tuning — long answers are the common case and we don't want the model to miss content. (See §13 — a subcommand `read` mostly mitigates this.)
3. **Inquiry panel placement.** Today it lives inside `RequestPanels`. Should it become a docked panel like bash, or stay in-place when clicked? Recommendation: keep in-place for v1; promote to docked panel if usage demands.
