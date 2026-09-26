---
created: 2026-09-26
status: proposed
---

# Desktop and extension UX: principles and work order

The desktop app and the VS Code extension share one conversation surface
(`<progress-app>` and its components), so most UX work lands in both at once.
This note records how UX work is prioritized against the logic, which is
still the product, and the order of the remaining items. It came from a
read-through audit of `packages/desktop/src/renderer/` and
`packages/extension/src/{progressView,settingsView}/frontend/`, plus design
harness screenshots (`packages/desktop/design-harness/`).

## Principles

The UI should be quiet and should never mislead the user. In priority order:

1. **Never mislead.** Surface every failure the user must act on. Say what
   a control actually does. A silent save failure or a mislabelled policy
   is a correctness bug, even though it shows up in the UI.
2. **One name per thing.** Use one noun per concept across the command
   titles, the settings, the webviews and the docs. When two names exist,
   users assume there are two things.
3. **Help at the moment of need.** An empty screen should show one concrete
   next step, not a paragraph. Examples and starters beat descriptions.
   Offer a button where it can act; don't point at a glyph.
4. **Restraint.** Add nothing a user did not need this week. No hover-only
   affordances for primary actions. No developer identifiers (run ids,
   camelCase agent names, log refs as the only message) in the main surface.
5. **Logic first.** A UX change that needs a data-model change goes through
   the model. Do not compensate at render time (CLAUDE.md, "UI
   anti-patterns"). UI polish never blocks or reshapes a run-loop change.

## Done in the first pass

- **Starter prompts on New task.** The hero now offers four one-click
  starters: polish, referee review, proof check and related work
  (`src/ui/copy/newTaskStarters.ts`, `NewTaskHero.ts`). A starter fills the
  composer and never sends.
- **Approval policy wording.** "Never" is now **Block**, because it denies,
  and a user reads "Never" as "never ask". The "Under Ask: … Inert under …"
  wording is gone from the two toggles, which only render under Ask anyway.
  The stored values (`never`/`ask`/`yolo`) are unchanged.
- **API-key banner.** After a skipped onboarding, the banner offers
  ChatGPT sign-in as well as an API key, so it no longer contradicts the
  welcome card.
- **Desktop editor.** A failed load, open or save now shows an inline
  notice, with "Try again" for a failed save. Previously these went to the
  console only (`editorFileNotice.ts`).
- **Desktop onboarding.**
  - The tips no longer describe controls that don't exist.
  - The team chooser asks "What kind of work do you do?" instead of
    repeating the New-task question.
  - Its command is now "Choose Agent Team".
- **Copy and accessibility.**
  - "Copy to new task" and "Edit as new task" are one action with one name.
  - The workflow board's "Retry" on a running call is now **Restart**, with
    tooltips.
  - "Run latexFixer" is now "Fix compile errors".
  - Run ids are gone from tooltips.
  - "child" jargon is gone from the Subagents tab.
  - One name each for the side panel and the bottom panel.
  - Accessible names added to the session filters and the composer chips.
  - Send is labelled "Start task".
  - The empty Review tab explains itself.

## Second pass: identity and cuts

- **The desktop wears the TeXRA brand.** It had been achromatic, ChatGPT
  style, with a black "T" square for a logo. It now uses the palette the
  logo and texra.ai already use:
  - warm paper surfaces;
  - aubergine ink for text;
  - the logo purple `#6f387a` as the single interaction accent, in both
    themes.

  It is a token change in `themeTokens.css`: every shared component reskins
  from it. The sidebar shows the real `{T}` mark. Sidebar rows are no longer
  semibold. The composer is the one bright card on the page.

- **The VS Code extension stays native** to the editor theme. A brand accent
  inside someone's editor theme is noise, not identity.
- **Cut: the "Attachments" row for interactive tasks.** It was a second way
  to attach beside the composer's paperclip, collapsed and rarely noticed.
  The composer is now the one home: `<launch-attachments>` lists attached
  files as removable chips under it and makes it a drop target. Document
  passes keep their Input/Context section, which they need.
- **Fixed: open terminals kept their palette when the theme changed.**

## Third pass: autonomy and the loop as one dial

Notion's AI design principles mapped onto TeXRA:

- **Right tool at the right moment, from context.** Starter prompts on an
  empty task. The getting-started card when a folder has no LaTeX yet.
  Setup while the funnel is pending.
- **Pre-built skills and plain prompts share one interface.** Starters fill
  the same composer a typed prompt uses; follow-ups refine.
- **Compare before replacing.** Edits arrive as diffs to accept or merge.

Beyond Notion, TeXRA has to work **autonomously when asked**. The composer
now has an Autonomy chip beside agent and model:

- **Ask me** follows the approval policy.
- **Autonomous** starts the run with its delegated-work bypass on: the state
  the run header's "agent work" switch already owns. The header shows it
  for the run's whole life, and the user can take it back mid-run.

Block remains the floor. The bypass is written in `onRun`, before the run
body; a regression test in `SessionResultEvent.vitest.ts` pins that order.

Next in this line, in order:

1. **Context-aware starters.** Starters that name the open `.tex` file,
   plus a selection-first path ("Improve this passage", with a before/after
   diff), the way Notion keys its menu on empty, content, or selection.
2. **Saved prompts (favorites).** Save a composer prompt as a named
   starter; it appears beside the built-in four and runs with one click.
   Settings-backed, one list per project.

## Open work, in order

Each item is independent and small enough for one PR.

1. **Unify the unit-of-work noun.** The UI says "task", "session" and "run"
   for the same thing: "New task", "Sessions", "No runs yet", "Stop run",
   "Open run folder". Pick _task_ for what the user starts and _session_ for
   the list, and retire _run_ from user-facing copy. This touches
   `RunTabs.ts`, `BaseRequestPanel.ts`, `progressView/frontend/constants.ts`
   and `packages/extension/package.json` command titles.
2. **Unify the agent-category names.** The composer says "Interactive" /
   "Document passes". Settings says "Tool-use agents" / "Workflow agents".
   Setting titles say "chat agents" and "tool-use agents". Choose one pair.
3. **Round labels.** Replace `r1`/`[r1]` with "Round 1" in webview surfaces
   (`formatRoundStageLabel` in `src/shared/runs/runStatusDisplay.ts` is
   shared with the CLI, so split the display, not the data). Replace the
   `plus` icon on "Compare with previous round".
4. **No-folder screen.** List recent projects on the desktop "Open a folder
   to start" card; the data already feeds File > Open Recent. Check for the
   placeholder flash at startup (`main.ts` `rerenderShell` before the project
   list arrives).
5. **Command palette reach.** Add Open Terminal / Files / Browser and switch
   project. Show command descriptions. Rename the "TeXRA" group heading.
6. **Settings search and the Advanced tab.** Add a filter box across the 15
   sub-tabs. Give Agents › Advanced a heading and a description. Rewrite the
   paragraph-length descriptions that expose internals: concurrency
   "in-band", "Interactions (submit + poll)", "model_context_window".
7. **Loading and failure placeholders.** The progress view renders nothing
   until its first snapshot arrives. "Error loading content"
   (`BundledViewContentProvider.ts`) needs a retry and a log link.
8. **Desktop pane polish.**
   - Restart button on an exited terminal.
   - PDF error state and "Open externally".
   - Keyboard path to "Move to…" on a tab.
   - Styled dialogs instead of `window.confirm`.
   - Visible `+` on the active project row.
9. **Team chooser safety.** Re-running the chooser applies a preset over a
   customized team on first click. Confirm before overwriting.
10. **Roster chips.** Show readable names instead of preset ids
    (`latexFixer`, `progressCheck`) in the onboarding roster.

## Not doing

- A redesign of the shell layout. The three-column frame and the
  shared conversation surface are sound; the problems are copy, feedback and
  naming.
- Hover-only reveal for the workflow board's Restart/Skip. It would reduce
  noise, but it hides the only control over a live call.
