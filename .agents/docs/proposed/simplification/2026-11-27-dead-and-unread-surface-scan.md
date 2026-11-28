# Dead / ad-hoc implementation scan: what the 2026-11-27 audit found

Date: 2026-11-27
Status: proposed (the collision-free items landed with this note; the rest are
blocked by an open PR, need an owner decision, or are not runnable here)

Origin: the scheduled audit for the largest ad-hoc or messy implementations —
duplicate logic, inconsistent patterns, overly complex functions and repeated
workarounds. Read on `main` at `3bc72f1`. Three read-only fan-out sweeps, each
scoped to the seam the three recent mega-deletions opened:

- #15253 (`8bca7f0`) "trust the model" — deleted the `replacement/` engine,
  path protection, the Block policy, prompt tutoring and many settings.
- #15229 (`aabd4e6`) deleted the document pipeline, task programs and tools.
- #15250 (`05c476a`) the conversation-first UI.

Checked against the five open PRs (#15216, #15230, #15242, #15245, #15247), the
November notes in this directory, and `.agents/docs/refuted-candidates.json`.

## The result confirms the 2026-11-24 and 2026-11-25 scans: the tree is clean

Both prior ad-hoc/duplication scans landed a verified negative, and three fresh
agents (dead code; now-constant options; tool/settings/plugin consistency) agree:
the three mega-deletions were cleaned up carefully, and there is **no large
mechanical or structural consolidation left** on this tree. What survived
verification is small, scattered debris — elements no consumer reads — plus a
few owner-duplications that the open PRs hold.

## Landed with this note (collision-free)

**1. Dead code the deletions left behind** (`refactor: delete dead code…`):

- `matchesEditedFile` (`ui/progress/editedFileMatch.ts`, whole file) lost its
  only caller when #15229 deleted `ToolsSheet.ts`.
- `copyDereferenced` (`harness/.../fsDurability.ts`) lost its last caller with
  the document pipeline's run-file copy; not SDK surface (absent from the
  api-reports).
- `PENDING_BOX` (`cli/.../tui/ui/glyphs.ts`) marked a round in the deleted
  document-task run details.
- `LatexdiffMathMarkupValue` (`texra/.../constants/latexConfig.ts`) — a type
  with no reader (the `LATEXDIFF_MATH_MARKUP_VALUES` const it derived from stays
  live).
- `Pagination.ts` / `list-pagination` (`ui/settings/components/shared/`, whole
  file, 161 LOC) — a Lit element never wired to a consumer (dead on arrival,
  added 2026-11-23 and imported nowhere).
- The `overlaySurfaceStyles` barrel comment named the deleted `ToolsSheet`; now
  one surface (`SessionDrawer`).

**2. Over-exports → file-local** (`refactor: make 14 internally-used exports
file-local`): fourteen symbols read only within their own module. Exports are
contracts, so they default to file-local. `ToolUseOpening` and `TakenFollowUp`
stay exported (named in exported signatures — a declaration-emit constraint).

**3. `WakeTool` uses the `optionalInput` owner** for `afterSeconds` and `at`,
which wrote `Schema.optional(Schema.NullOr(S)).annotate({ description })` by
hand. Same JSON schema; behavior-preserving.

## Open: blocked by an open PR (fix once it lands)

1. **One throwing owner for a settings-view row.** `settingsViewByKey(key)`
   returns `undefined`, and three readers each throw the same
   `No settings-view catalog row for setting "${key}"` after it
   (`stateSettingRows.ts:73`, `PluginsTab.ts:80`, `settingsState.ts:78`); a
   fourth (`settingsViewBody.ts:277`) genuinely wants the optional. A throwing
   `settingsViewRow(key)` on `TEXRA_SETTINGS` owns the wording for the three.
   The owner file `texraSettings.ts` and one reader (`PluginsTab.ts`) are held
   by an open PR. (Carried from the 2026-11-26 consolidation note item 3.)
2. **A described, trimmed, non-empty path/string input field** is re-invented at
   four tool sites — two verbatim schema copies (`DiagnosticsTool.ts:44`,
   `comment/InlineCommentTool.ts:102`, incl. an identical comment) and two
   body-side trims (`OpenPdfTool.ts:59`, `setup/SendToTerminalTool.ts:57`).
   `inputSchema.ts` is the declared home for shared tool-input field spellings;
   a `describedString(description)` there collapses the copies. `DiagnosticsTool`
   is held by an open PR.
3. **Two more over-exports** wait on the PRs that hold their files:
   `ToolPluginSetup` (`tools/registry.ts`, #15230) and `DerivedSettingsSnapshot`
   (`shared/settingsView/settingsViewMessages.ts`).

## Open: needs an owner decision

4. **`ApprovalPolicyLimit` is a single-value enum after the Block deletion.**
   #15253 removed the `never` policy, collapsing `APPROVAL_POLICY_LIMITS`
   (`['never','ask']`) to `Schema.Literal('ask')` in
   `shared/approvalBypassKind.ts:23`. No caller supplies anything but `'ask'`
   and no reader distinguishes among values — only present vs absent, i.e. a
   boolean ("pinned to Ask regardless of project policy") dressed as a one-member
   enum. Nine sites across five files
   (`approvalBypassKind.ts`, `shared/session/runtimeRequest.ts`,
   `agent/runtime/rootLaunch.ts`, `agent/runtime/runApprovalQueue.ts`,
   `cli/.../runChatTui.tsx`). Making `ApprovalGrants.limit` a boolean is a wire
   change (a `rowVersions.ts` bump for `ApprovalGrants`), which is the reason to
   do it before the 1.0 format freeze — and the reason it needs the owner's word
   on timing. `runChatTui.tsx` is also held by #15216. ~12–18 LOC.

## In flight elsewhere (recorded so this run did not duplicate it)

5. **The validation scripts repeat each other** (carried from the 2026-11-26
   consolidation note item 1, freed now that #15229 has merged). **Being done by
   the concurrent #15256** ("one owner for the validation scripts"), which this
   run deliberately left to it rather than touch test tooling it cannot run.
   `packages/cli/scripts/validate-run.mjs` (128 KB) and
   `generate-golden-store.mjs` (52 KB) each hold the provider-key list and fake
   key (`validate-run.mjs:138-153`, `generate-golden-store.mjs:142-145`), the
   validation-model child environment, and "find the project store by its
   directory prefix" (eight `readdirSync(storage).find((n)=>n.startsWith(...))`
   in `validate-run.mjs` alone, plus `generate-golden-store.mjs:399`).
   `validate-run.mjs` also has inline poll loops beside its own `waitFor` and
   two `spawnSync('find', …)` where `fs.globSync` works on every platform. A
   `packages/cli/scripts/validationAgent.mjs` owner (the file exists as a stub)
   for the key list, the child environment and `projectStore(root, prefix)`.
   Left for a session that can run the validators: `validate-run.mjs` and
   `validate-tui.mjs` need a live LLM and node-pty, which this environment lacks,
   so the dedup cannot be verified end to end here. (`validate-tui.mjs` uses a
   different fixture key — not the same fact — so it is not part of this owner.)

## Checked and left alone

- **`ToolGuard.command.cwd?: 'unknown'`** (`tools/core/ToolTypes.ts:63`) is a
  2-state field (absent vs `'unknown'`, set by three tools), a boolean wearing a
  one-member enum — not a constant column. Already flagged in the
  2026-11-07 red-flag evidence; ~0 LOC to change; pre-existing, not from the
  deletions.
- **`ToolGuard.command.grant?: 'bash'`** genuinely encodes two approval states
  (shell grant vs per-call), so it is not a constant column.
- **In-body re-check of a declared `hostCapability`** (~8 sites across 6 setup/
  editor tools): each re-check also narrows an optional port and guards a window
  that detaches mid-step, so the message/shape is legitimate per-tool variation.
- The deletions' own cleanup was audited symbol by symbol: `WriteFilter`,
  `ToolGuard.writes`, `stepRoots`/`memoryRoots`, `TOOL_PATH_PROTECTION_SETTING`,
  the `*_REPLACEMENT*` settings, `Program.result`/`outputs`, the memory-folder
  `writable` flag, and the `toolUseInstructions` scaffolding were all removed,
  not stranded.
- `commandManifest`'s `packageCommandContributions` / `packageCommandPalette` /
  `commandKeybindings` look unused in `packages/`/`src` but are read by
  `scripts/sync-package-contributes.mjs` — live, not dead.

## The scan run

Landed the collision-free dead code, over-exports and the one owner-use fix, and
recorded the rest. The finding is the third verified negative running: there is
no large messy area left to consolidate on this tree today — the remaining work
is each a small item an open PR holds, an owner decision, or test tooling this
environment cannot run.
