# Responsibility audit: what the 2026-11-28 run left open

Date: 2026-11-28
Status: proposed
Origin: the scheduled audit for confused or overlapping responsibilities,
on `main` at `5b7f63e`. It started from the open items of
`2026-11-27-responsibility-audit-left-open.md` and checked each against the
tree before acting.

The PR that adds this note lands four of them, one commit each:

- Item 2, a plan's usage: `PlanUsage`
  (`packages/texra/src/shared/model/subscriptionUsage.ts`) is the one
  record, built by `planUsageOf`
  (`packages/texra/src/controllers/modelAccess/subscriptionUsage/subscriptionUsage.ts`),
  and `packages/texra/src/ui/copy/subscriptionUsage.ts` owns the plan's
  name, the windows still running and the limiting window.
- Item 3, `renderPrompt`: deleted with the `nunjucks` dependency. Reading it
  found more than a misplaced caller: a child's system text is the calling
  model's (the `agent` tool's `system` argument) or an installed plugin's,
  and `latex.tikzTemplate` is a setting a project's config file can answer,
  so both ran text nobody on this machine wrote through a template engine
  whose expressions reach the `Function` constructor. The system text is
  now sent as written and the TikZ template's `{{ tikzpicture }}` slot is a
  plain replacement (`packages/texra/src/latex/tikzPictures.ts`).
- Item 4, first half: `externalRoots.ts` is
  `packages/harness/src/utils/files/canonicalPath.ts`.
- Item 8: a tool declares `command` (`ToolCommand`,
  `packages/harness/src/tools/core/ToolTypes.ts`), not a `guard` that holds
  one.

## Open

1. **The prompt still says "Accessible external directories"** (item 4,
   second half): `ACCESSIBLE_EXTERNAL_DIRS_HEADING` and
   `EXTERNAL_ROOT_TOOLS` in
   `packages/harness/src/agent/prompt/workspaceInfo.ts` list only the
   memory folders, and the memory section refers to the heading. Renaming
   it is a prompt change: it wants the resolved prompt read as a whole and
   the golden database fixture
   (`src/test-kernel/fixtures/storage/golden-1.0.sql`) written again.
2. **A plan has two keys.** A coding plan is named by its route
   (`kimi-code-subscription`) and by a second id (`kimiCode`,
   `SUBSCRIPTION_USAGE_PROVIDERS` in
   `packages/texra/src/shared/model/subscriptionUsage.ts`), which keys the
   settings page's usage record and the refresh message. `PlanUsage.plan`
   already carries the route, so the settings page could take a list as the
   status bar does, and the second id would be left to the code that reads
   the plan's key.
3. **The screenshot spec set a usage card on the wrong element.**
   `packages/desktop/tests/e2e/screenshots.spec.ts` assigned `usage` to
   `subscription-section`, which has no such property, and expected a
   `.usage-plan` inside it. This PR removes the dead assignment and the
   assertion; a screenshot of the real usage card
   (`subscription-usage-row`, on a coding plan's key row) is not taken
   anywhere.
4. Items 1, 5, 6, 7, 9 and 10 of the 2026-11-27 note are unchanged: which
   section an idle conversation belongs in, the log entry's shape declared
   twice on the desktop, the two verbs for showing a folder, the renderer's
   platform guess, the rail's unseen mark, and the older carried items.
   Item 7 needs a new member on the preload bridge and a value for the
   design harness, which has no preload.

## Checked and declined

- **Keeping `'reset due'`.** With every surface reading
  `currentUsageWindows`, a window past its reset is not shown, so the word
  had no caller left.
- **Keeping a template engine for `latex.tikzTemplate`.** The documented
  template has one slot; a project that wants conditionals writes them in
  LaTeX.
