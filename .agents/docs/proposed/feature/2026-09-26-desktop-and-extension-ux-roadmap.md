---
created: 2026-09-26
status: proposed
---

# Desktop and extension UX: principles and work order

The desktop app and the VS Code extension share one conversation surface
(`<progress-app>` and its components), so most UX work lands in both at once.
This note records how UX work is prioritized against the logic, which is
still the product, and the order of the remaining items. The redesign around
code-as-tool (one noun per thing, one home per action, the script card, the
Plugins page, fork) landed and is described in
[the GUI on code-as-tool](../../implemented/feature/2026-10-02-gui-code-as-tool.md).

## Principles

The UI should be quiet and should never mislead the user. In priority order:

1. **Never mislead.** Surface every failure the user must act on. Say what
   a control actually does. A silent save failure or a mislabelled policy
   is a correctness bug, even though it shows up in the UI.
2. **One name per thing.** Use one noun per concept across the command
   titles, the settings, the webviews and the docs. When two names exist,
   users assume there are two things.
3. **Help at the moment of need.** An empty screen should show one concrete
   next step, not a paragraph. Offer a button where it can act; don't point
   at a glyph.
4. **Restraint.** Add nothing a user did not need this week. No hover-only
   affordances for primary actions. No developer identifiers (run ids,
   camelCase agent names, log refs as the only message) in the main surface.
5. **Logic first.** A UX change that needs a data-model change goes through
   the model. Do not compensate at render time (CLAUDE.md, "UI
   anti-patterns"). UI polish never blocks or reshapes a run-loop change.

## Decided

- **The desktop wears the TeXRA brand**: warm paper surfaces, aubergine ink,
  and the logo purple `#6f387a` as the single interaction accent in both
  themes, as tokens in `packages/desktop/src/renderer/themeTokens.css`.
- **The VS Code extension stays native** to the editor theme. A brand accent
  inside someone's editor theme is noise, not identity.
- **The composer is the one home to attach files.** `<launch-attachments>`
  lists them as removable chips under it and makes it a drop target.
- **Autonomy uses the approval policy's own words** (Ask / Block /
  Auto-approve), never a second vocabulary. The composer's Approval chip
  offers the policy from Settings or Auto-approve for this task only, which
  can only loosen Ask; Block still blocks.
- **Not doing:** a redesign of the shell layout (the three-column frame and
  the shared conversation surface are sound), and hover-only reveal for a
  live call's controls, which would hide the only control over it.

## Open work, in order

Each item is independent and small enough for one PR.

1. **Selection-first path.** "Improve this passage" on a selection, with a
   before/after diff. It needs its own home in the composer first.
2. **Saved prompts.** Save a composer prompt as a named entry that runs
   with one click; settings-backed, one list per project. Its home is the
   same open question as 1.
3. **No-folder screen.** The desktop's "Open a project to start" card
   (`packages/desktop/src/renderer/main.ts`) could list recent projects; the
   data already feeds File › Open Recent.
4. **Command palette reach.** The palette
   (`packages/desktop/src/shared/desktopCommandSurface.ts`) has no Open
   Terminal / Files / Browser or switch-project commands.
5. **Settings search.** The settings view has no filter across its tabs.
   Paragraph-length descriptions that expose internals remain (for example
   "Interactions (submit + poll)" in `stateSettings.ts`). The owner has not
   decided whether the Agents › Advanced switches stay, so wait on that
   before polishing them.
6. **Loading and failure placeholders.** "Error loading content"
   (`packages/extension/src/common/webview/BundledViewContentProvider.ts`)
   has no retry or log link.
7. **Desktop pane polish.**
   - Restart button on an exited terminal (`terminalPane.ts` prints only
     the exit code).
   - PDF error state and "Open externally" (`pdfPane.ts`).
   - Styled dialogs instead of `window.confirm` (`main.ts`,
     `workbenchController.ts`).
