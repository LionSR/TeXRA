---
created: 2026-05-15
updated: 2026-05-15
---

# 10 · Session resume

> **Status: UX target for a follow-up PRD, not v1.** Per [10-architecture § Session resume](../2026-05-14-10-architecture.md#session-resume-deferred-to-a-separate-prd), today's persistence layer does not back this mockup — `HistoryItem` carries only `{id, timestamp, agentConfig, description?}`, `StreamLogStore` is in-memory, and the existing restore re-runs rather than replays. The session-record shape described in § Backing data below is the **target schema for that follow-up PRD's new persistence layer**, not what exists today. The resume identifier itself should be the existing `HistoryItem.id` (an exec id), not a new "session-id" concept.

A session is the unit of conversation history TeXRA already persists today (via the extension's history browser). The CLI gains three entry points to resume:

1. **`texra chat --continue`** — pick the most recent session, no UI.
2. **`texra chat --resume <session-id>`** — direct resume, no UI.
3. **`/resume` slash command** — opens a structured form (per [§ Slash command forms](../2026-05-14-10-architecture.md#slash-command-forms)) listing recent sessions.

The `/resume` form (most common path):

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ────────────────────────────────╮
│                                                                                      │
│  ◇ chat                                                                            │
│    (current session above, dimmed)                                                   │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  › /resume                                                                           │
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   Resume session                                                                     │
│   Replay a prior transcript into this TUI. Agent and model selection restore from    │
│   the session. New turns append to the same session id.                              │
│                                                                                      │
│   ─── recent ────────────────────────────────────────────────────────────────────    │
│   › 1. quantum-walks §3.2 tighten lemma     · chat   · opus-4-7  · 18 turns  · 2 m ago│
│     2. figure 4-a placement debug           · chat   · sonnet    ·  6 turns  · 1 h ago│
│     3. abstract rewrite                     · chat   · opus-4-7  ·  4 turns  · 3 h ago│
│     4. bibliography cleanup                 · chat   · haiku     ·  2 turns  · 1 d ago│
│                                                                                      │
│   ─── older (5 more) ────────────────────────────────────────────────────────────    │
│     ↑ ↓ to expand                                                                    │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│   1-9 select   ·   ↑ ↓ navigate   ·   Enter resume   ·   Esc cancel                  │
╰──────────────────────────────────────────────────────────────────────────────────────╯
```

After `Enter`, the form unmounts and the conversation pane re-renders with the resumed transcript flushed into the `<Static>` region (no re-streaming — each turn renders fully and instantly). Header `agent` / `model` slots update to the session's stored values; a one-line banner pins the resumed state:

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ─── 18 turns · $1.42 · resumed ─╮
│                                                                                      │
│  ── resumed: quantum-walks §3.2 tighten lemma (2 m ago) ─────────────────────────    │  ← one-line banner; dim
│                                                                                      │
│  ◆ you                                                                               │
│    (turn 1 of the resumed session, replayed from storage)                            │
│                                                                                      │
│  ◇ chat                                                                            │
│    (turn 2…)                                                                         │
│                                                                                      │
│   …                                                                                  │
│                                                                                      │
│  ◇ chat                                                                            │
│    (last turn from the resumed session)                                              │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ○ idle · queued: 0 · yolo off                                                       │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ › _ continue the conversation…                                                       │
╰────── enter send · ctrl-j newline · ctrl-p palette · ctrl-f search · ? help ─────────╯
```

## Layout notes

- **List row format:** `N. <session name> · <agent> · <model> · <turn count> · <age>`. Session name is either user-set (via a future `/rename` form) or auto-derived from the first user turn (e.g., "quantum-walks §3.2 tighten lemma" from `rewrite section 3.2 so the lemma proof is tighter`).
- **Recent vs older** — top-4 most-recent sessions in the always-expanded "recent" group. The rest live in "older" which expands on `↑` `↓` (so a user with hundreds of sessions doesn't see a wall of rows by default).
- **Numbered selection** `1.`–`9.` per [§ Intuitiveness conventions](../2026-05-14-10-architecture.md#intuitiveness-conventions) — digit shortcuts jump directly.
- **Resumed banner** is a one-line dim divider in the conversation pane, sitting above the replayed turn 1. Persists until the user starts a new session (`/new` slash command, not in v1 scope) or quits.

## Backing data

- Session list reads from the extension's existing history storage. The CLI lifts the path lookup into `platform().storage` so both hosts share it (no duplicate persistence).
- Each session record carries: `sessionId`, `name` (optional), `agentId`, `modelId`, `turnCount`, `lastActivityAt`, `totalCost`, and the turn-by-turn log entries.
- Resume replays `StreamLogStore` entries for the matching `sessionId`. New turns append, extending the same session — they are **not** forked.

## Failure modes

- **Stale session (agent or model no longer registered).** Show an inline warning at the top of the resumed transcript and ask the user to pick a substitute agent/model via the same `/agent` and `/model` forms. New turns then use the substitute.
- **Corrupt session log.** Surface as an error in the form's selected-row description; `Enter` disabled until another row is picked.
- **Concurrent edit.** If the same session is also open in the VS Code extension, both hosts read the same log; appends are sequential through the shared store. (Detached subagents within a session are **not** re-attached — see [§ 8 multi-agent](../2026-05-14-10-architecture.md#8-multi-agent-specifics).)

## Open questions for review

1. Should `texra chat` (bare command) default to resume-most-recent like a shell session-restore, or always start fresh (current mockup)? Risk: surprising the user with old context.
2. The `/resume` form lists by recency. Should there be a search input at the top for sessions by name/agent/file? Out of scope for v1 unless many sessions become routine.
3. Auto-naming: derive the name from the first user turn (current proposal), the agent's first response, or always require manual `/rename`?
4. When the user resumes and then sends a new turn that contradicts the resumed context (e.g., "ignore the above"), should the CLI offer a "fork from here" option? Out of scope for v1; note for later.
5. Cross-host: if the same session is open in VS Code, should the CLI show a `(also in VS Code)` indicator on the row?
