---
created: 2026-04-13
updated: 2026-04-15
---

# PRD: Orchestrator-First UI Redesign

## Status: Draft

## Problem

TeXRA's main view presents a form-like "launcher" interface: file selectors on top, an instruction textarea in the middle, and banners at the bottom. Users coming from Claude Code, Codex, or ChatGPT expect a chat-first interface where they type a request and hit Enter. The current UX has several friction points:

1. **The Interactive/Workflow radio toggle** uses domain jargon that new users don't understand.
2. **The orchestrator** (the most powerful mode) is buried as one agent in a dropdown, with only a dismissable banner explaining it.
3. **File selectors** take up most of the viewport but are `display: none` in Interactive mode -- wasted prime space.
4. **Two hidden agent dropdowns** swap visibility depending on mode -- disorienting.
5. **No keyboard shortcut** to execute (Ctrl+Enter is expected by Claude Code / Codex users).
6. **No explanation of what the orchestrator does** -- users don't learn it handles deep research, analytical review, and long writing tasks.

The orchestrator is already the default (`toolUseAgent: 'orchestrator'`, `sessionType: 'toolUse'`), but the UX doesn't reflect that. This PRD proposes making the orchestrator the hero experience.

---

## Orchestrator Education Copy (shared across all designs)

All designs need a way to tell new users what the orchestrator does.
The copy adapts to context but the core message is the same:

> **Orchestrator** -- for deep research, analytical review, and long
> writing tasks. Describe what you need, hit Execute, then approve
> individual tasks in the Progress board.
>
> Examples: "Review my paper and suggest improvements",
> "Research recent work on transformer architectures",
> "Write a related-work section covering diffusion models"

This copy appears as an **inline tip** (dismissable, persisted via
`orchestratorTipDismissed` in state). It is NOT in the banner group --
it lives inside the instruction panel, right below the textarea,
so the user sees it in context while typing.

---

## Current Layout

### Default state (Interactive mode, orchestrator selected)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌─ File Selection Group ──────────────────┐ │
│  │                                         │ │
│  │  (entirely hidden via display:none      │ │
│  │   in Interactive mode -- but this div   │ │
│  │   sits ABOVE the instruction panel in   │ │
│  │   the DOM, so the panel is pushed down) │ │
│  │                                         │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ┌─ Instruction Panel ─────────────────────┐ │
│  │                                         │ │
│  │  (o) Interactive   ( ) Workflow         │ │
│  │                         [✨] [🎤] [🗑] │ │
│  │                                         │ │
│  │  ┌───────────────────────────────────┐  │ │
│  │  │                                   │  │ │
│  │  │  Leave blank -- the orchestrator  │  │ │
│  │  │  will figure out what to do.      │  │ │
│  │  │                                   │  │ │
│  │  │                                   │  │ │
│  │  │                                   │  │ │
│  │  │                                   │  │ │
│  │  │                                   │  │ │
│  │  │                                   │  │ │
│  │  └───────────────────────────────────┘  │ │
│  │                                         │ │
│  │  [✨ orchestrator ▾]  [🤖 model ▾]  [▶]│ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ┌─ Banner Group ──────────────────────────┐ │
│  │ ┌─ Orchestrator Banner ───────────────┐ │ │
│  │ │ ℹ  Orchestrator selected. Hit       │ │ │
│  │ │ Execute to analyze your paper and   │ │ │
│  │ │ generate improvement tasks.         │ │ │
│  │ │ Customize in Multi-Agent settings.  │ │ │
│  │ │                          [Got it]   │ │ │
│  │ └────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### Problems

1. Radio toggle "Interactive / Workflow" is domain jargon
2. Placeholder says "Leave blank" -- confusing, doesn't explain value
3. Orchestrator banner is BELOW the fold, easily dismissed and gone forever
4. Two separate agent dropdowns (only one visible at a time) -- disorienting
5. No Ctrl+Enter shortcut to execute
6. File selectors hidden but still above instruction panel in DOM
7. No explanation of what the orchestrator actually does (deep research, analysis, long writing)

---

## Design A: "Unified Dropdown" (agent selection implies mode)

**Concept:** Remove the radio toggle entirely. One agent dropdown with
section headers contains both interactive and workflow agents. Selecting
a workflow agent auto-reveals file selectors; selecting an interactive
agent hides them. The textarea is the hero element.

### A-1. Default state (orchestrator selected, first visit)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  What would you like to do?        │  ││
│  │  │  (e.g. "Review my paper and        │  ││
│  │  │  suggest improvements")            │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  ┌─ ℹ  ────────────────────────────────┐ ││
│  │  │ Orchestrator: for deep research,    │ ││
│  │  │ analytical review, and long writing │ ││
│  │  │ tasks. Describe what you need, hit  │ ││
│  │  │ Execute, then approve individual    │ ││
│  │  │ tasks in Progress.       [Got it]   │ ││
│  │  └─────────────────────────────────────┘ ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [🎯 orchestrator ▾]  [🤖 model ▾]  [▶] ││
│  │                          Ctrl+Enter ↗    ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### A-2. Default state (returning user, tip dismissed)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  Review my paper and suggest       │  ││
│  │  │  improvements to the methodology   │  ││
│  │  │  section, focusing on statistical  │  ││
│  │  │  rigor and reproducibility.        │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [🎯 orchestrator ▾]  [🤖 model ▾]  [▶] ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### A-3. Unified dropdown expanded

```
  [🎯 orchestrator ▾]
  ┌─────────────────────────────────────┐
  │                                     │
  │  ── Chat & Research ──              │   ← disabled, styled as
  │  🎯 orchestrator                    │     section header
  │     chat                            │
  │     research                        │
  │                                     │
  │  ── Document Processors ──          │   ← disabled, styled as
  │     correct                         │     section header
  │     polish                          │
  │     review                          │
  │     translate                       │
  │     merge                           │
  │                                     │
  └─────────────────────────────────────┘
```

### A-4. After selecting "correct" (workflow agent) -- files appear

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  Fix grammar, tighten phrasing,    │  ││
│  │  │  and ensure consistent notation... │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [📄 correct ▾]     [🤖 model ▾]    [▶] ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ┌─ Files (animated slide-down) ────────────┐│
│  │                                          ││
│  │  📄 Input      [main.tex            ▾]  ││
│  │  📚 Reference  [refs.bib            ▾]  ││
│  │  📎 Auxiliary   (none selected)          ││
│  │  🖼 Media       (none selected)          ││
│  │  📤 Output     [main_corrected.tex   ]  ││
│  │                                          ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### A-5. Back to orchestrator -- files collapse away

```
  (User picks "orchestrator" from dropdown)
  Files section animates closed (max-height → 0).
  Returns to layout A-2 above.
```

**Pros:**

- Cleanest UI, zero jargon, mode is implicit from agent choice
- Closest to Claude Code / ChatGPT feel
- Education tip is inline, contextual, dismissable
- Single dropdown is simpler to reason about

**Cons:**

- Users might not discover workflow agents (buried in dropdown)
- Grouped dropdown (`<optgroup>`-style) is non-standard for @vscode-elements
- No visual separation between modes -- could confuse power users who think in "chat vs document"

---

## Design B: "Smart Tabs" (Chat | Document tabs replace radio)

**Concept:** Replace the "Interactive / Workflow" radio toggle with two
clearly-labeled tabs: "Chat" and "Document". Each tab shows its own
agent dropdown and adapts the UI below. The textarea remains hero.
Education tip lives inside the Chat tab.

### B-1. Chat tab selected (default, first visit)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │                                          ││
│  │  ┌──────────────┐┌──────────────┐        ││
│  │  │   💬 Chat    ││  📄 Document │        ││
│  │  └──────────────┘└──────────────┘        ││
│  │  ════════════════                        ││
│  │    (active tab)                          ││
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  What would you like to do?        │  ││
│  │  │  (e.g. "Review my paper and        │  ││
│  │  │  suggest improvements")            │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  ┌─ ℹ  ────────────────────────────────┐ ││
│  │  │ Orchestrator: for deep research,    │ ││
│  │  │ analytical review, and long writing │ ││
│  │  │ tasks. Describe what you need, hit  │ ││
│  │  │ Execute, then approve individual    │ ││
│  │  │ tasks in Progress.       [Got it]   │ ││
│  │  └─────────────────────────────────────┘ ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [🎯 orchestrator ▾]  [🤖 model ▾]  [▶] ││
│  │                          Ctrl+Enter ↗    ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### B-2. Chat tab (returning user, tip dismissed, "chat" agent)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │  ┌──────────────┐┌──────────────┐        ││
│  │  │   💬 Chat    ││  📄 Document │        ││
│  │  └──────────────┘└──────────────┘        ││
│  │  ════════════════                        ││
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  Explain the difference between    │  ││
│  │  │  LASSO and ridge regression in     │  ││
│  │  │  the context of my model...        │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [💬 chat ▾]         [🤖 model ▾]   [▶] ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### B-3. Document tab selected

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │  ┌──────────────┐┌══════════════┐        ││
│  │  │   💬 Chat    ││  📄 Document │        ││
│  │  └──────────────┘└══════════════┘        ││
│  │                   ════════════════        ││
│  │                     (active tab)         ││
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  Fix grammar, tighten phrasing,    │  ││
│  │  │  and ensure consistent notation... │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [📄 correct ▾]     [🤖 model ▾]    [▶] ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ┌─ Files ──────────────────────────────────┐│
│  │                                          ││
│  │  📄 Input      [main.tex            ▾]  ││
│  │  📚 Reference  [refs.bib            ▾]  ││
│  │  📎 Auxiliary   (none selected)          ││
│  │  🖼 Media       (none selected)          ││
│  │  📤 Output     [main_corrected.tex   ]  ││
│  │                                          ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### B-4. Document tab dropdown (only workflow agents)

```
  [📄 correct ▾]
  ┌──────────────────────────┐
  │  correct                 │  ← selected
  │  polish                  │
  │  review                  │
  │  translate               │
  │  merge                   │
  └──────────────────────────┘
```

**Pros:**

- "Chat" vs "Document" is immediately clear -- no jargon
- Familiar tab pattern (VS Code users know tabs)
- Each tab shows only relevant agents -- no mixed dropdown
- Education tip lives naturally in Chat tab
- Smallest conceptual change from current radio toggle

**Cons:**

- Still a mode switch -- user must understand two modes exist
- Two agent dropdowns still exist in code (one per tab)
- Tabs add vertical space above the textarea

---

## Design C: "Minimal Chat + Expander" (Claude Code style)

**Concept:** Maximum simplicity. The UI collapses to a minimal chat
input with a toolbar below it. Agent/model are compact inline labels.
An "Attach files" button reveals the file panel. Education happens
through a centered hero card on first visit.

### C-1. First visit (hero welcome + education)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│              ┌────────────────────┐          │
│              │                    │          │
│              │       TeXRA        │          │
│              │  Research Assistant │          │
│              │                    │          │
│              └────────────────────┘          │
│                                              │
│  ┌─ What can I do? ────────────────────────┐ │
│  │                                         │ │
│  │  🔬  Deep Research                      │ │
│  │  "Research recent work on transformer   │ │
│  │   architectures and summarize trends"   │ │
│  │                                         │ │
│  │  📝  Analytical Review                  │ │
│  │  "Review my paper and suggest           │ │
│  │   improvements to methodology"          │ │
│  │                                         │ │
│  │  ✍️   Long-Form Writing                  │ │
│  │  "Write a related-work section          │ │
│  │   covering diffusion models"            │ │
│  │                                         │ │
│  │  📄  Document Processing                │ │
│  │  "Correct grammar and fix citations"    │ │
│  │  (attach files below)                   │ │
│  │                                         │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │                                        │  │
│  │  What would you like to do?            │  │
│  │                                        │  │
│  │                                        │  │
│  ├────────────────────────────────────────┤  │
│  │ 📎  🎯 orchestrator   🤖 gpt-4o  [▶] │  │
│  └────────────────────────────────────────┘  │
│                                              │
└──────────────────────────────────────────────┘
```

### C-2. Returning user (hero dismissed, just the input)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│                                              │
│                                              │
│                                              │
│                                              │
│                                              │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │                                        │  │
│  │  Review my paper and suggest           │  │
│  │  improvements to the methodology       │  │
│  │  section, focusing on statistical      │  │
│  │  rigor and reproducibility.            │  │
│  │                                        │  │
│  │                                        │  │
│  ├────────────────────────────────────────┤  │
│  │ 📎  🎯 orchestrator   🤖 gpt-4o  [▶] │  │
│  └────────────────────────────────────────┘  │
│                                              │
│                                              │
└──────────────────────────────────────────────┘
```

### C-3. After clicking 📎 Attach (file chips appear below input)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │                                        │  │
│  │  Fix grammar, tighten phrasing,        │  │
│  │  and ensure consistent notation...     │  │
│  │                                        │  │
│  │                                        │  │
│  │  ┌─────────────┐ ┌────────────┐        │  │
│  │  │ 📄 main.tex ✕│ │📚 refs.bib ✕│        │  │
│  │  └─────────────┘ └────────────┘        │  │
│  │                                        │  │
│  ├────────────────────────────────────────┤  │
│  │ 📎  📄 correct     🤖 gpt-4o     [▶] │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### C-4. Agent picker (clicking agent name in toolbar)

```
  ├────────────────────────────────────────┤
  │ 📎  [🎯 orchestrator ▾]  🤖 gpt  [▶] │
  │      ┌─────────────────────────────┐   │
  │      │                             │   │
  │      │  ── Chat & Research ──      │   │
  │      │  🎯 orchestrator            │   │
  │      │     chat                    │   │
  │      │     research                │   │
  │      │                             │   │
  │      │  ── Document Processors ──  │   │
  │      │     correct                 │   │
  │      │     polish                  │   │
  │      │     review                  │   │
  │      │     translate               │   │
  │      │                             │   │
  │      └─────────────────────────────┘   │
  └────────────────────────────────────────┘
```

### C-5. Full file panel (clicking 📎 when workflow agent selected)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │                                        │  │
│  │  (instruction text here)               │  │
│  │                                        │  │
│  ├────────────────────────────────────────┤  │
│  │ 📎  📄 correct     🤖 gpt-4o     [▶] │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ┌─ Files ────────────────────────────────┐  │
│  │                                        │  │
│  │  📄 Input      [main.tex          ▾]  │  │
│  │  📚 Reference  [refs.bib          ▾]  │  │
│  │  📎 Auxiliary   (none selected)        │  │
│  │  🖼 Media       (none selected)        │  │
│  │  📤 Output     [main_corrected.tex ]  │  │
│  │                                        │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

**Pros:**

- Most minimal, maximum focus on the input
- Feels exactly like Claude Code / ChatGPT
- Hero welcome card teaches all capabilities at once
- File attachment is opt-in -- no wasted space
- Toolbar is compact: everything in one row

**Cons:**

- Biggest redesign effort (new toolbar component, file chips, hero card)
- Loses structured file-type separation (input/ref/aux/media) in chip mode
- TeXRA power features harder to discover
- Current users may feel disoriented by the radical change

---

## Design D: "Orchestrator Hero + Workflow Below" (progressive disclosure)

**Concept:** Both modes are always visible as separate sections -- no
toggle at all. The orchestrator gets a prominent hero card at the top.
Workflow agents live in a collapsible section below. Education is built
into the hero card itself. New users see only the hero; power users
expand the workflow section.

### D-1. Default state (new user, workflow collapsed)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌─ Ask TeXRA ──────────────────────────────┐│
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  What would you like to do?        │  ││
│  │  │  (e.g. "Review my paper and        │  ││
│  │  │  suggest improvements")            │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  ┌─ ℹ  ────────────────────────────────┐ ││
│  │  │ For deep research, analytical       │ ││
│  │  │ review, and long writing tasks.     │ ││
│  │  │ Describe what you need, hit         │ ││
│  │  │ Execute, then approve individual    │ ││
│  │  │ tasks in Progress.       [Got it]   │ ││
│  │  └─────────────────────────────────────┘ ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [🎯 orchestrator ▾]  [🤖 model ▾]  [▶] ││
│  │                          Ctrl+Enter ↗    ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ Process a Document                        │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### D-2. Returning user (tip dismissed)

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌─ Ask TeXRA ──────────────────────────────┐│
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  Research recent work on           │  ││
│  │  │  transformer architectures and     │  ││
│  │  │  summarize the key trends since    │  ││
│  │  │  2023...                           │  ││
│  │  │                                    │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [🎯 orchestrator ▾]  [🤖 model ▾]  [▶] ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ Process a Document                        │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### D-3. "Process a Document" expanded

```
┌──────────────────────────────────────────────┐
│  [Launcher]  [Progress]              [⚙] [↗]│
├──────────────────────────────────────────────┤
│                                              │
│  ┌─ Ask TeXRA ──────────────────────────────┐│
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │  (instruction for orchestrator)    │  ││
│  │  └────────────────────────────────────┘  ││
│  │  [✨] [🎤] [🗑]                          ││
│  │  [🎯 orchestrator ▾]  [🤖 model ▾]  [▶] ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▾ Process a Document                        │
│  ┌──────────────────────────────────────────┐│
│  │                                          ││
│  │  Run a single-pass agent on your LaTeX   ││
│  │  file to correct, polish, review, or     ││
│  │  translate it.                           ││
│  │                                          ││
│  │  ┌────────────────────────────────────┐  ││
│  │  │                                    │  ││
│  │  │  Fix grammar and tighten           │  ││
│  │  │  phrasing...                       │  ││
│  │  │                                    │  ││
│  │  └────────────────────────────────────┘  ││
│  │                                          ││
│  │  [✨] [🎤] [🗑]                          ││
│  │                                          ││
│  │  [📄 correct ▾]     [🤖 model ▾]    [▶] ││
│  │                                          ││
│  │  ── Files ──                             ││
│  │  📄 Input      [main.tex            ▾]  ││
│  │  📚 Reference  [refs.bib            ▾]  ││
│  │  📎 Auxiliary   (none selected)          ││
│  │  🖼 Media       (none selected)          ││
│  │  📤 Output     [main_corrected.tex   ]  ││
│  │                                          ││
│  └──────────────────────────────────────────┘│
│                                              │
│  ▸ LaTeX Diffs                               │
└──────────────────────────────────────────────┘
```

### D-4. Workflow agent dropdown (only document processors)

```
  [📄 correct ▾]
  ┌──────────────────────────┐
  │  correct                 │  ← selected
  │  polish                  │
  │  review                  │
  │  translate               │
  │  merge                   │
  └──────────────────────────┘
```

**Pros:**

- Both modes always visible -- zero discovery problem
- No toggle, no mode confusion
- Orchestrator hero is the obvious default for new users
- Workflow section has its own education copy ("single-pass agent")
- Least disruptive to existing code structure (collapsible = existing pattern)

**Cons:**

- Two textareas, two execute buttons, two model dropdowns -- duplication
- Uses more vertical space when both sections open
- Users might be confused about which section to use
- Two instruction states to persist and manage

---

## Comparison Matrix

```
                    │  A: Unified   │  B: Tabs    │  C: Minimal  │  D: Hero+Below │
                    │    Dropdown   │             │    Chat      │                │
────────────────────┼───────────────┼─────────────┼──────────────┼────────────────┤
Radio toggle gone?  │  Yes          │  Renamed    │  Yes         │  Yes           │
Mode discovery      │  In dropdown  │  Visible    │  In dropdown │  Visible       │
Education placement │  Inline tip   │  Inline tip │  Hero card   │  Section header│
Duplicated controls │  None         │  None       │  None        │  Everything    │
Implementation size │  Medium       │  Small      │  Large       │  Medium        │
Feels like ChatGPT  │  Yes          │  Somewhat   │  Most        │  No            │
Power user friction │  Low          │  Low        │  Medium      │  Low           │
New user onboarding │  Good         │  Good       │  Best        │  Good          │
```

---

## Recommendation

**Design A** (Unified Dropdown) is recommended: cleanest UX, eliminates
the toggle, inline education, and closest to the Claude Code mental model.
Moderate implementation effort with no architectural rework.

**Design B** (Smart Tabs) is the quick-win fallback: smallest change,
just relabel the toggle to "Chat" / "Document" and add the inline tip.

**Design C** (Minimal Chat) is the aspirational north star: best
onboarding, most modern feel, but biggest redesign risk.

**Design D** (Hero + Below) is safest for preserving both modes but
has the duplication cost.

---

## Implementation Details (for chosen design)

The implementation steps below assume Design A is chosen. They apply
with minor adjustments to B or D as well.

### 1. Reorder the Main Layout (MainApp.ts)

**File:** `src/webview/frontend/MainApp.ts` (render at line 1878)

Move `<instruction-panel>` above the file selection group:

```
Tab bar (Launcher | Progress)
  Banner group (API key, login, dependency -- blocking issues first)
  Instruction panel  <-- hero element, always visible immediately
  File selection group (hidden when interactive, shown when workflow)
LaTeX diffs section
```

### 2. Remove the Interactive/Workflow Radio Toggle (InstructionPanel.ts)

**File:** `src/webview/frontend/components/InstructionPanel.ts` (lines 321-351)

Remove the `.instruction-session-toggle` div. Mode switching is driven
implicitly by agent selection. Restructure `.instruction-box`:

```
Textarea (hero, first thing you see)
Orchestrator education tip (inline, dismissable)
Action buttons row (polish, record, erase)
Controls footer: [agent dropdown] [model dropdown] [Execute button]
```

### 3. Unify the Agent Dropdowns (InstructionPanel.ts, selectTemplates.ts)

Replace two hidden `<vscode-single-select>` elements with a single
unified dropdown. Add `renderGroupedAgentOptions()` in
`selectTemplates.ts` with disabled options styled as section headers.

### 4. Move Orchestrator Banner Inline (InstructionPanel.ts, BannerGroup.ts)

Move `<orchestrator-banner>` out of `BannerGroup` and into
`InstructionPanel` as an inline tip between textarea and controls.
Update education copy to explain deep research / analytical / writing.

### 5. Add Ctrl+Enter Keyboard Shortcut (InstructionPanel.ts)

Add `keydown` handler on textarea for Ctrl+Enter / Cmd+Enter.
Update Execute button title to `"Execute (Ctrl+Enter)"`.

### 6. Smooth File Selection Collapse (styles.ts)

Replace `display: none` with animated `max-height` transition.

### 7. Update Placeholder Text (store.ts)

Replace `'Leave blank -- the orchestrator will figure out what to do.'`
with actionable examples like `'What would you like to do?'`.

---

## Files Modified

| File                                                  | What Changes                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/webview/frontend/MainApp.ts`                     | Reorder render. Add `isOrchestratorSelected` to session context.                                 |
| `src/webview/frontend/components/InstructionPanel.ts` | Remove radio toggle. Textarea first. Unify agent dropdowns. Inline orchestrator tip. Ctrl+Enter. |
| `src/webview/frontend/styles.ts`                      | Animated collapse for file-selection-group.                                                      |
| `src/webview/frontend/components/BannerGroup.ts`      | Remove `orchestratorSelected` prop and `<orchestrator-banner>`.                                  |
| `src/shared/utils/selectTemplates.ts`                 | Add `renderGroupedAgentOptions()`.                                                               |
| `src/webview/frontend/store.ts`                       | Update orchestrator placeholder text.                                                            |
| `src/shared/schemas/mainView.ts`                      | Add `orchestratorTipDismissed` boolean to `MainViewPersistedStateSchema`.                        |

## Files NOT Modified

- `src/webview/frontend/sessionDefaults.ts` -- per-mode behavior unchanged
- Backend/agent code -- purely UI/UX changes

---

## Implementation Order

1. **Ctrl+Enter shortcut** -- smallest, independent, immediate value
2. **Placeholder text** -- single file, text-only
3. **Layout reorder** -- simple DOM reorder in render()
4. **Orchestrator education tip inline** -- move + rewrite one component
5. **Smooth collapse animation** -- CSS-only
6. **Remove radio toggle + restructure InstructionPanel** -- moderate
7. **Unified agent dropdown** -- most complex, depends on step 6

Steps 1-5 are quick independent changes. Steps 6-7 are the core
redesign and should be done together.

---

## Verification

1. `npm run compile:fast` -- no build errors
2. `npm run typecheck` -- no type errors
3. `npm run lint` -- no lint errors
4. Manual testing in VS Code Extension Development Host:
   - Instruction panel appears immediately (no scrolling)
   - Ctrl+Enter triggers execution
   - Unified dropdown shows grouped agents with section headers
   - Selecting a workflow agent smoothly reveals file selectors
   - Selecting an interactive agent collapses file selectors
   - Orchestrator education tip appears on first visit, dismissable
   - Placeholder text is actionable and rotates correctly
   - Persisted state restores correctly after close/reopen
   - All banners (API key, dependency, etc.) still display above instruction panel
