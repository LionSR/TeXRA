# Ad-hoc / messy-implementation scan: what the 2026-11-25 audit found

Date: 2026-11-25
Status: proposed (one standalone fix landed with this note; every larger find
is owner-gated, reverses the refused single-caller-split shape, or is already
landed, and is recorded so the theme is not re-mined)

Origin: the scheduled audit for the largest ad-hoc or messy implementations —
duplicate logic, inconsistent patterns, overly complex functions and repeated
workarounds. Read on `main` at `37a22c5`. Two read-only fan-out sweeps (the
UI/webview layer; the app and host request-handling paths) plus direct reads of
every complex function still catalogued in
[`2026-11-24-duplication-and-complexity-scan.md`](2026-11-24-duplication-and-complexity-scan.md),
checked against the open PRs (#15216, #15229, #15230), the November notes in
this directory, and `.agents/docs/refuted-candidates.json`.

## The result is a verified negative, for the second scan running

No cross-package consolidation of audit-PR size (the 300–600 line theme the
scheduled-audit rule asks for) survives verification. The daily sweeps have
deduplicated the tree and routed the one-owner-per-fact drift to its owners; the
2026-11-24 duplication scan already found zero cross-file copy-paste, and this
run's two independent sweeps of the two least-recently-swept layers found the
same. Both the UI kit and the controller/host paths came back
"exceptionally well owner-gated": commands (`COMMAND_CATALOG` +
`PRESENTATION satisfies Record<CommandId,…>`), subscription providers
(`defineSubscriptionProvider`), host-call failure wording (`hostCallFailure.ts`),
run-action refusals (`runActionPolicy.ts`), GUI host-request policy
(`openGuiWindow.ts`'s shared body over the per-host binding halves), settings
dispatch (`settingsViewBody.ts`), CLI approval text (`approvalAdapter.ts`),
shell completions (`completionCommandTree.ts`) and the `ui/copy/*` tone/word/
glyph tables are each a single compile-checked owner.

## Landed with this note (the standalone first step)

**One owner for the Web Awesome variant vocabulary.** The semantic-variant set
`'brand' | 'neutral' | 'success' | 'warning' | 'danger'` (the `variant`
attribute of `wa-callout`, `wa-tag` and `wa-badge`) was spelled three times:
`bannerFrame.ts` and `settingsBanner.ts` inline on their `variant` field, and
`statusIcons.ts` as a local `WaTagVariant`. It is now `WaVariant`, exported from
`packages/texra/src/ui/wa/waVariant.ts`, the way `iconNames.ts` owns the icon
set. No behavior change: the three literal unions were identical. This is a
one-owner-per-fact fix with no indirection added (a type import, not a wrapper),
below the audit-PR size bar on its own but clean and standalone.

## Open: owner-gated or ratchet/refusal-bound (recorded so they are not re-mined)

None can land as a net win in a scheduled run.

1. **The subscription device-code dialog is still rendered by each GUI host.**
   With the fallback line, the copy-fail warning and the loopback-port error
   already shared (landed 2026-11-24, see
   [`2026-11-24-subscription-sign-in-presenters-left-open.md`](2026-11-24-subscription-sign-in-presenters-left-open.md)),
   what remains duplicated between `subscriptionSignIn.ts` (extension) and
   `desktopSignInPresenters.ts` (desktop) is the dialog scaffolding — copy the
   code, build the steps, show one dialog with an "open verification page"
   button — which differs only in the dialog primitive (`vscodeUi.ask` returns a
   label; `choose` returns the value). Collapsing the two is worth doing only
   alongside a shared one-button GUI dialog helper the hosts do not have today;
   the CLI's render is a progress-sink write that does not fit that shape.
   Owner's call on whether that helper should exist. The `reason`-prefix
   separator differs between surfaces (`\n\n` in the GUI dialogs,
   `\n` in the CLI terminal write at `subscriptionLogin.ts:96`) — plausibly a
   deliberate terminal-density choice, not a one-owner fact; left as is.

2. **A JavaScript lexer for a program file's header** (`readDeclarations` in
   `packages/harness/src/common/plugins/pluginPrograms.ts`, ~135 lines) could be
   ~20 lines of **acorn** (already a transitive dependency). Carried over from
   [`2026-11-23-hand-written-code-a-package-covers-left-open.md`](2026-11-23-hand-written-code-a-package-covers-left-open.md)
   item 2: it is a new dependency of the published SDK and changes the failure
   mode (a syntax error anywhere refuses a program whose header is fine, where
   the cursor stops after two statements). Owner's call.

3. **base64url/hex by hand and CORS headers by hand in the Supabase functions**
   (`supabase/functions/auth-device/crypto.ts`, `_shared/cors.ts`). Carried over
   from the same note, items 3–4: no Deno runs in this session, so neither the
   `jsr:@std/encoding` import-map change nor `hono/cors` (which follows moving
   the non-Hono functions to Hono first) can be verified here.

## Complex functions: each reduces to the refused shape or is already done

The functions still catalogued in the 2026-11-24 scan were read directly. Their
remaining "decomposition" is the single-caller / temporal-decomposition split
the root `AGENTS.md` bans and that `LOOP-phase-split-long-functions`
(`refuted-candidates.json`) already refused; the in-function data-shape dedup
that _does_ land on each was taken in the 2026-11-24 evening runs.

- `createEditorPane` (`packages/desktop/src/renderer/editorPane.ts`, ~605
  lines) is already a well-factored deep module — a cohesive pane of named
  functions over one `TreeState`/`FileState` model, not a chain. Splitting it
  into editor-surface / file-tree / save controllers is three single-caller
  extractions of what the factory wires; there is no cross-branch duplication
  or data shape left inside it to consolidate.
- `buildStatusBarDisplay` (`packages/cli/.../statusBarDisplay.ts`): its middle
  segment group is already a `(StatusBarSegment | undefined)[].filter(...)`
  data list and the bypass badges already loop `RUN_GRANT_ORDER`. The remaining
  imperative pushes are the liveness/notice section, whose ordering is genuinely
  conditional on `transientNotice`/`active`; forcing it into a `{ when, build }`
  table would encode control flow as data without reading more clearly.
- `configureAnsi` (`packages/cli/.../ansiMarkdown.ts`): a deep module doing real
  work (HTML-tag→markdown-token conversion, blockquote gutters, table collapse).
  The suggested rewrite (thread render state through an explicit context, split
  the table pass) is high-risk markdown surgery against the golden TUI frames;
  the one micro-dedup (the state reset spelled at render start and in the
  `finally`) is ~6 lines, below the bar and inside the render hot path. The
  depth counters are reset before _and_ after each render, so the "leak on an
  unbalanced token stream" the earlier note worried about cannot occur.
- `openGuiWindow`'s `shared` dispatcher: a 38-case switch inside the composition
  root whose cases close over ~15 locals. A switch→handler-map rewrite is
  element-neutral churn (same cases as object properties), and "lift the
  multi-step cases into named functions" is single-caller extraction. No net
  win.

## The scan run

Recorded the verified negative and the owner-gated candidates, and landed the
one clean standalone fix. The finding is that there is no large mechanical or
structural consolidation left to take on this tree today: the remaining work is
each its own owner decision or the refused single-caller-split shape.
