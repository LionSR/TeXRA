# TU: the app's UI toolkit and progress view (`packages/texra/src/ui/`)

Read on `main` at `d70ad92` (the brief's commit; the working tree adds only
the brief). Area auditor, prefix TU.

## Numbers

| Subdirectory      | Lines (ts) | Files |
| ----------------- | ---------- | ----- |
| `progress/`       | 17 235     | 92    |
| `styles/`         | 2 385      | 13    |
| `copy/`           | 2 028      | 29    |
| `wa/`             | 1 924      | 20    |
| `markdown/`       | 1 352      | 8     |
| `litControllers/` | 260        | 5     |
| `monaco/`         | 223        | 1     |
| `highlighting/`   | 100        | 2     |
| `formatting/`     | 46         | 1     |
| total             | 25 553     |       |

Five largest files: `styles/controlStyles.ts` (692),
`progress/sessionSurfaces.ts` (671), `progress/components/SessionComposer.ts`
(644), `progress/components/RunHeader.ts` (595), `progress/ProgressApp.ts`
(541).

Open PRs touching this area: #14950 (`claude/admiring-mayer-14efx5`, UI
primitives; note `2026-11-15-ui-primitives-restated-at-call-sites.md`),
#14955 (`claude/clever-pascal-h5a0xm`, layer misplacements; note
`2026-11-15-layer-misplacements-left-open.md`, items 5 to 8 are UI), #14953
(`claude/optimistic-cori-q0n270`, the markdown shields). Their notes' items
are not repeated below.

## TU-1: Every action menu writes each item twice, a value string in the template and a branch that decodes it

- flags: information leakage, repetition, overexposure
- package: texra (touches desktop: `desktopShell.ts`, `dockControls.ts`)
- kind: refactor
- size: M
- earlier: J-b's "DOM id grammar" (round 2, landed in #14818) removed the group ids parsed back from the DOM; `ELEMENT_IDS` survived it and now serves as menu values. The menus' value-and-decode pattern itself was not reported. Remainder of J-b plus new instances.
- open PR: #14950 and #14955 edit `RunHeader.ts` and `RunTab.ts` (labels only: `TASK_ACTIONS.delete(run)`, `forkedFromRun`); neither touches the menus' dispatch

**Evidence.** A `<wa-dropdown>` of actions names each item by a string
`value`, and its `@wa-select` handler maps the string back to the action:

- `packages/texra/src/ui/progress/components/RunHeader.ts:66-72` declares
  `DELETE_SESSION`, `RENAME_TASK`, `FORK_TASK` and the prefix
  `OPEN_FORK = 'openFork:'`; `:433-462` decodes them in a five-step chain
  (rename, fork, `forks.find((c) => \`${OPEN_FORK}${c.id}\` === value)`, delete,
  `actions.find((c) => c.id === value)`, then `this.menuItems.find(...)`),
  and `:256-267` (`dispatchAction`) branches a second time on
  `RunMenuAction.arm`.
- `packages/texra/src/ui/progress/constants.ts:8-31` gives each
  `RunMenuAction` an `id` (a DOM-id string from `ELEMENT_IDS`, used only as
  the item's `value`), an `action` and an `arm`; `ELEMENT_IDS.RUN_AGAIN_BTN`
  … `COMPACT_RESPONSE_BTN` (`:43-50`, 8 entries) have no reader but these
  tables (grep: 0 hits outside `constants.ts`, tests included).
- `packages/texra/src/ui/progress/ProgressApp.ts:308-313`: the overflow menu
  decodes `items.find((item) => item.value === value)?.activate()`, the one
  site that already carries the action on the item (`HeaderMenuItem`,
  `RunHeader.ts:59-64`).
- `packages/texra/src/ui/progress/components/RunTab.ts:318-332`: `'rename'`
  and `'delete'` literals, decoded from `event.detail.item.value` typed as
  `CustomEvent<{ item: { value: string } }>` (a structural type in place of
  the `selectedItemValue` check, `packages/texra/src/ui/wa/selectTemplates.ts:24-27`).
- `packages/texra/src/ui/progress/components/ScriptStage.ts:214-216`
  (`STOP_AGENT`).
- `packages/desktop/src/renderer/desktopShell.ts:182-190` (`'rename'`,
  `'new-task'`, `'close'`, same structural cast) and
  `packages/desktop/src/renderer/dockControls.ts:60-77` (`'split-right'`,
  `'split-below'`, `'maximize'`, `'close-group'`, then a kind lookup) and
  `:177-191` (`'close'`, `'move:'` prefix with `value.slice(5)`, a position
  lookup).

Eight action menus, two of which encode a run or group id into the string
and slice it back out (RunHeader, the dock tab menu), and three of which read
the item through an unchecked structural type. A ninth, the proposal card's
model picker (`packages/texra/src/ui/progress/components/ProposalRequestPanel.ts:126-133`),
prefixes a catalog value with `'model:'` and slices it off with
`value.slice(6)`.

**The design decision behind it.** "What happens when this item is picked"
is decided twice per item: once when the template names it, once when the
handler recognizes the name. Adding an item means editing both, keeping the
string identical, and (for RunHeader) placing the branch before the
generic fall-throughs.

**The better design.** One `renderActionMenu({ trigger, items })` in
`packages/texra/src/ui/wa/` over `HeaderMenuItem` widened to
`{ icon, label, variant?, dividerBefore?, focusesOwn?, activate }`
(`focusesOwn` routes through `afterDropdownHides`). The template keys items
by index; the one `@wa-select` handler calls `items[index].activate()`.
RunHeader builds one item list (rename, fork, forks, the run actions, the
shell's items, delete) and loses `DELETE_SESSION`, `RENAME_TASK`,
`FORK_TASK`, `OPEN_FORK`, `dispatchAction` and its 30-line handler;
`RunMenuAction` loses `id` and `arm` in favour of an `activate(run, emit)`;
`ELEMENT_IDS` keeps only the six ids RunHeader and StageList put on
elements. RunTab,
ScriptStage, ProgressApp, desktopShell and both dock menus each lose their
decode branch and their string constants. `ProposalRequestPanel`'s model
menu and the composer chips pick a value from a catalog, which is data, and
stay on `selectedItemValue` (the model menu without its prefix).

**What we give up, and risk.** The item values stop being stable strings.
Six e2e locators read them
(`packages/desktop/tests/e2e/sessionLifecycle.spec.ts:236`, `:308`, `:324`;
`packages/desktop/tests/e2e/workspaceTabs.spec.ts:186`, `:413`, `:652`) and
move to `getByRole('menuitem', { name })`, which is what R5-5 asked the
specs to read anyway. A menu whose items toggle (`FileSelectGroup.ts:147-152`,
checkable items) keeps its own handler.

**How I tried to refute it.** Looked for a reader of the item values
outside their menus: none in `packages/*/src`, `packages/*/test` or `src/`;
the six e2e locators above are the only ones. Checked that `HeaderMenuItem` is already the
shape ProgressApp and RunHeader exchange (`ProgressApp.ts:122-151`), so the
widened type has a precedent and a consumer. Checked `splitButton.ts:84-88`:
it forwards `selectedItemValue` to an `onSelect(value)` and would take the
same item list.

## TU-2: The in-place rename hands its callers a once-only protocol, and each caller re-implements it

- flags: conjoined methods, comment restates code, repetition
- package: texra (touches desktop: `packages/desktop/src/renderer/main.ts`)
- kind: refactor
- size: S
- earlier: none
- open PR: #14955 edits `RunTab.ts` and `RunHeader.ts` but not the rename paths

**Evidence.** `inlineRenameField` (`packages/texra/src/ui/wa/inlineRename.ts:14-17`)
documents its own defect as the caller's job: "Both can fire for one edit
(Enter, then the blur of the removed field), so the caller ignores a finish
once it has closed the field." Its three callers each write that guard, the
trim and the "unchanged" test:

- `packages/texra/src/ui/progress/components/RunHeader.ts:251` (`renaming`
  state), `:277-290`: `if (!this.renaming) return; this.renaming = false;
  const title = value?.trim(); if (!title || title === run.title) return;`
- `packages/texra/src/ui/progress/components/RunTab.ts:116`, `:118-137`: the
  same guard, then `title !== (this.run.description || this.run.label)`,
  which restates the view's own derivation of `title`
  (`packages/harness/src/shared/session/sessionView.ts:84-85`, "What every
  surface names the run by: `description`, else `label`";
  `sessionViewUpdate.ts:738`).
- `packages/desktop/src/renderer/main.ts:228-237`: `renamingProjectKey` and
  `if (renamingProjectKey !== key) return; renamingProjectKey = null;` then
  `name?.trim()`.

The start side is repeated too: F2 and double-click open the field in
`RunTab.ts:184-189,235` and `desktopShell.ts:154-160`, and the menu item
goes through `afterDropdownHides` in `RunHeader.ts:435-437`,
`RunTab.ts:322-323` and `desktopShell.ts:184-187`.

**The design decision behind it.** "This edit is finished, and here is its
result" is decided by the field, but the field reports raw events and
leaves deduplication, trimming and the no-change test to whoever holds the
`renaming` flag. The flag and the callback cannot be understood apart.

**The better design.** The field owns the edit: it fires once (a `WeakSet`
of finished inputs, or a `done` flag in the directive's closure), trims,
and calls `onRename(title)` only for a non-empty, changed title, and
`onClose()` in every case. Callers write
`onClose: () => (this.renaming = false), onRename: (title) => dispatch(…)`.
Deleted: the three guards, the three trims, the two no-change tests, and
RunTab's `description || label`, which becomes `run.title`. The comment at
`inlineRename.ts:14-17` goes with the protocol it describes.

**What we give up, and risk.** Nothing user-visible. RunTab refocuses its
row after a finish (`RunTab.ts:136`), which moves into its `onClose`.

**How I tried to refute it.** Checked whether the three callers need
different finish rules: all three trim, all three ignore an empty result,
and the two run callers compare to the shown title (RunTab through a copy
of it). The desktop compares nothing, so it writes an unchanged name back;
moving the test into the field fixes that in passing. No other caller of
`inlineRenameField` exists (grep: 3 production sites).

## TU-3: The transcript's scroll-follow is split between `log-list` and `stage-list`, driven by a flag and three public methods

- flags: conjoined methods, temporal decomposition, comment restates code
- package: texra
- kind: refactor
- size: S
- earlier: none (round 6's S area listed `LogList.ts` for stage layout, not scrolling)
- open PR: #14955 edits `StageList.ts` (the empty-state noun only)

**Evidence.** `stage-list` owns the sticky state and the measurement
(`packages/texra/src/ui/progress/components/StageList.ts:155-197`,
`isSticky`, `STICKY_THRESHOLD`, `handleScroll`, `isNearBottom` at
`:327-334`) but not the decision when to use it. It exports three methods
for its parent: `scrollToBottom()` ("Public method to scroll to bottom -
called by parent LogList", `:169`), `scrollToBottomIfSticky()` (`:184-192`)
and `setSticky(value)` ("Force sticky state — called by parent on tab
switch", `:194-197`). `log-list`
(`packages/texra/src/ui/progress/components/LogList.ts:46-47,61-67,112-127`)
sets `shouldScrollToBottom` in `willUpdate` when the shown run changes,
holds a `Ref<StageList>` per cached run only to reach those methods, and in
`updated` either waits for the child's `updateComplete` plus a frame and
calls `setSticky(true)` then `scrollToBottom()`, or calls
`scrollToBottomIfSticky()`. Consumers: the three methods have one caller
each, all in `LogList.ts` (grep).

**The design decision behind it.** "Should this list follow its tail now?"
depends on two facts: whether the list just became the visible one, and
whether the user scrolled away. The parent holds the first, the child the
second, so the answer needs a call protocol in a fixed order (set sticky,
then scroll; wait for the child's update and a frame first).

**The better design.** `stage-list` takes the fact it lacks as a property
(`.shown=${id === this.activeRunId}`, which also replaces the `?hidden`
binding) and decides in its own `updated(changed)`: when `shown` turns true,
stick and scroll after a frame; otherwise scroll if sticky. Deleted: the
three public methods, `shouldScrollToBottom`, the `Ref` in `CachedRun` and
`LogList.updated`. `log-list` keeps the LRU of run bodies and the link
delegation, which is its job.

**What we give up, and risk.** The terminal branch
(`StageList.ts:171-177`, refit on first show) moves with it unchanged. The
frame wait must stay: the list measures after layout.

**How I tried to refute it.** Looked for a second user of the methods or a
reason the parent must decide (another list that shares the sticky state,
a host that scrolls differently): none; the desktop and the extension mount
the same `run-conversation` → `log-list` → `stage-list` chain. Checked that
`.log-container` in `stage-list` is the element that scrolls
(`packages/texra/src/ui/progress/styles/logStyles.ts:39-44`), so the child
does own the viewport it measures.

## TU-4: Design tokens have second spellings: local fallbacks that contradict the token, and an `sp` alias that renames three spacing steps

- flags: information leakage, repetition, vague name, comment restates code
- package: texra (touches extension: `MemoryItem.ts`)
- kind: refactor
- size: S
- earlier: none (no report names token fallbacks or `sp`)
- open PR: none of the listed files

**Evidence.** `designTokens` (`packages/texra/src/ui/styles/litStyles.ts:9-180`)
is "the one definition of the semantic tokens every host renders with",
matched on `:root` and `:host`, and adopted by every component (115 imports)
and by the root `progress-app` (`packages/texra/src/ui/progress/ProgressApp.ts:97`),
so custom properties reach every shadow tree by inheritance. Its own comment
says "do not introduce local fallbacks" (`litStyles.ts:71`). Components
restate seventeen of its values as `var()` fallbacks, and five disagree with
the definition:

| Site                                                                                    | Fallback                     | Token value                        |
| --------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------- |
| `progress/components/GettingStartedBanner.ts:51`, `OnboardingWelcomeCard.ts:91`, `:139` | `--line-height-normal, 1.4`  | 1.5 (`litStyles.ts:68`)            |
| `progress/components/ExternalInquiryPanel.styles.ts:25`                                 | `--line-height-relaxed, 1.6` | 1.5 (`:69`)                        |
| `progress/progressAppStyles.ts:61`, `styles/overlaySurfaceStyles.ts:30`                 | `--height-header, 38px`      | `--wa-height-header, 34px` (`:86`) |
| `progress/components/ConversationContent.styles.ts:113`                                 | `--height-button, 36px`      | `--wa-height-button, 30px` (`:87`) |
| `progress/components/ToolTimer.ts:25`                                                   | `--font-size-sm, 11px`       | `0.9 × --font-size` (`:54`)        |

The rest repeat the right value (`ToolTimer.ts:26,31`,
`GettingStartedBanner.ts:45`, `OnboardingWelcomeCard.ts:74`,
`NewTaskHero.ts:36,44`, `styles/bannerStyles.ts:33,37`,
`styles/commonViewStyles.ts:116`,
`packages/extension/src/settingsView/frontend/components/memory/MemoryItem.ts:60`).

Separately, `sp` (`packages/texra/src/ui/styles/requestPanelSharedStyles.ts:11-15`,
re-exported from the styles barrel, `styles/index.ts:34`) renames three
spacing steps: `sp.tiny` = `--wa-space-3xs`, `sp.small` = `--wa-space-2xs`,
`sp.medium` = `--wa-space-xs`. Four request-panel sheets use it (31 uses:
`ExternalInquiryPanel.styles.ts` 15, `ProposalRequestPanel.styles.ts` 8,
`UserQuestionPanel.styles.ts` 7, `PlanApprovalRequestPanel.ts` 1) while 292
other sites in `ui/` write `var(--wa-space-*)` directly; "small" and "medium"
name different steps than the scale's own `s` and `m`.

**The design decision behind it.** "What is this token's value" has one
owner by design, and every fallback is a second answer that only shows when
the owner is missing, i.e. never in a host, but in a design fixture or a
component mounted alone, where it shows the wrong value. `sp` is a second
vocabulary for the spacing scale, so a reader of a request panel cannot
compare its spacing with any other component's.

**The better design.** Delete the seventeen fallbacks (write
`var(--line-height-normal)`), and replace `sp.*` with the `--wa-space-*` it
stands for; delete `sp` and its barrel export. If a component must render
without `designTokens` (a fixture), it adopts the sheet; it does not carry
copies.

**What we give up, and risk.** None at runtime: every host adopts the token
sheet first. A visual check of the two banners and the inquiry card, whose
fallback line-heights were never the ones painted.

**How I tried to refute it.** Checked that each of the components adopts
`designTokens` or sits under one that does (all are rendered inside
`progress-app` or a settings view, both adopt it). Checked the `--wa-*`
fallbacks in `litStyles.ts` itself: those are the bridge from host inputs
and are left alone; this finding is only the semantic tokens components
re-default.

## TU-5: The file list decides which workspace file each output verb compares with or writes into, and the host takes that path from the webview

- flags: information leakage, non-obvious code, repetition
- package: texra (`ui/progress/components/FileList.ts`, `shared/session/hostRequest.ts`, `controllers/progressView/ProgressDocumentTaskFileActionsController.ts`, `controllers/session/openGuiWindow.ts`)
- kind: refactor
- size: S
- earlier: TC-1 (this round) merges `fileAction` and `latexdiffs` into one request but keeps `file` and `base` on the wire; this finding is the half TC-1 leaves: who picks `base`
- open PR: #14955 and #14953 edit `ProgressDocumentTaskFileActionsController.ts` (`confirmAccept`, `readNormalizedFile`); neither touches the base choice

**Evidence.** The output's lineage is the documents plugin's fact
(`packages/texra/src/shared/plugins/documentOutputs.ts:29-42`: `base`, the
run-storage snapshot it was edited from, and `document`, the live workspace
file). The renderer turns it into a per-verb rule:
`packages/texra/src/ui/progress/components/FileList.ts:268-277` computes
`base` and `compareBase = document && document !== filePath ? document : base`
with a paragraph explaining why, and `:405-455` (`renderBaseActions`) gives
Compare and Accept `compareBase` and latexdiff and Merge `basePath`. Each
button writes the chosen path into a `data-base` attribute (`:87`), and the
click handler reads it back, re-validates the verb with
`Schema.is(FileActionSchema)` and warns "carries no base file" (`:357-385`).
The host then acts on that path as given:
`packages/texra/src/controllers/progressView/ProgressDocumentTaskFileActionsController.ts:142-161`
writes the accepted output into `pathToLocationIn(workspace, base)`, the
path the webview sent (`hostRequest.ts:199-206`, "The workspace file the
output is compared with or written into"). Yet the same controller already
holds the run's rounds (`deps.rounds`, `:70-71`) and looks the output up in
them to build the launcher note (`latestOutput`, `:208-218`).

**The design decision behind it.** "Which workspace file does Accept
overwrite?" is a rule about the documents plugin's lineage, decided in a
Lit template and carried back to the host through DOM attributes. The
controller that performs the write has the lineage and re-reads it for a
different purpose, so the rule and the write have two owners, and the
write target is whatever the renderer computed.

**The better design.** The request names the output, not its base:
`{ kind: 'fileAction', runId, action, file }`. The controller resolves the
output with the `latestOutput` it already has and picks the base per verb
in one function beside `outputDisplayName` in `documentOutputs.ts`
(`compareTarget(output)`: the live document unless it is the output
itself, else the snapshot). Deleted: `base` from the `fileAction` schema,
`compareBase` and its comment, the `base`/`compareBase` parameters of
`renderBaseActions`, `data-base`, the "carries no base file" branch. With
TC-1's merged request, the sheet keeps sending an explicit pair (it has no
run), and the output case sends `{ runId, file }`.

**What we give up, and risk.** An output whose run the view no longer
holds cannot be acted on; the file list renders only for a run the view
holds, so that is today's reach. One controller test fixture changes shape.

**How I tried to refute it.** Checked whether the host could not resolve
the output: `deps.rounds(runId)` is the session view's documents fact, the
same data the file list renders from. Checked whether another host computes
the base differently: the CLI sends no `fileAction` (grep: 3 sites, all
listed). Checked that the four verbs really split two and two
(`FileList.ts:422,432,442,452`).

## TU-6: Each root re-wires the shell's four events to the session surfaces by hand

- flags: repetition, pass-through, temporal decomposition, overexposure
- package: texra (touches desktop: `packages/desktop/src/renderer/main.ts`)
- kind: refactor
- size: S
- earlier: none (N6 and J1 reshaped the surfaces and the transport, not the root wiring)
- open PR: none of the listed files

**Evidence.** `packages/texra/src/ui/progress/uiEvents.ts:1-11` defines four
shell events and says "The root installs one listener per event; nothing
translates in between". There are two roots and each writes the same four
listeners onto the same four `SessionSurfaces` methods:

- `packages/texra/src/ui/progress/progressWebview.ts:37-48`:
  `runtime-request` → `sessions.runtimeRequest(key, …)`, `host-request` →
  `sessions.hostRequest`, `surface-action` → `sessions.act`,
  `composer-submit` → `sessions.submit`, for its one fixed key.
- `packages/desktop/src/renderer/main.ts:870-905`: the same four, each
  first finding the key with `sessionOf(event)` (a walk of `composedPath()`
  for `data-session`), plus a desktop step on `select`/`selectNew`
  (`:890-899`).

`SessionSurfaces.runtimeRequest`, `.hostRequest` and `.submit`
(`packages/texra/src/ui/progress/sessionSurfaces.ts:99-106`, `:632-644`)
have no caller except these listener blocks (grep: two each, one per root);
each is a `held.get(key)` and a forward. `answer`
(`sessionSurfaces.ts:102`, `:636`) re-exports `transport.hostRequest` for
one caller (`packages/desktop/src/renderer/projectWorkbench.ts:110`).

**The design decision behind it.** "Which shell event goes to which
surface operation" is the surfaces module's contract (the events carry its
own record types unchanged), but each root restates it, and a fifth event
would be added in three places.

**The better design.** `SessionSurfaces.listen(root, sessionOf)` installs
the four listeners and returns the removal; the extension passes
`() => sessionKey`, the desktop passes its `sessionOf`. The desktop keeps
its own extra `surface-action` listener for the panel and project
selection. Deleted from the public interface: `runtimeRequest`,
`hostRequest`, `submit` (they stay as the local functions they already
are); the two listener blocks (about 30 lines).

**What we give up, and risk.** The desktop's select hook runs as a second
listener rather than inside the first; it reads only the event, so order
does not matter (it neither reads nor writes the surface before `act`).

**How I tried to refute it.** Looked for a root that maps an event
differently: the trace viewer remounts through `mountProgressWebview`
(its doc, `progressWebview.ts:17-20`), so it shares the extension's block.
Checked that the desktop's extra step does not need to run before `act`:
it opens the agent panel and switches project, neither of which reads the
surface.

## TU-7: A request in flight is tracked twice: the surface's `busyWhile`, and a private set in `run-tabs` that guesses when a delete ended

- flags: repetition, non-obvious code, conjoined methods
- package: texra
- kind: refactor
- size: S
- earlier: J1 (round 2) removed the in-flight Sets of the surface layer (#14791) and put "busy" on the surface; this set in a component is a remainder of the same problem
- open PR: none of the listed files

**Evidence.** The surfaces own "a request on this key is in flight":
`busyWhile` (`packages/texra/src/ui/progress/sessionSurfaces.ts:364-382`)
marks the key in `Surface.sending` or `Surface.polishing` before the
request leaves and clears it with `Effect.ensuring` however it ends, and
`hostRequestFor`/`runtimeRequestFor` (`:407-418`, `:425-429`, `:469-474`)
refuse a second request on a busy key. `run-tabs` keeps its own for
deletes (`packages/texra/src/ui/progress/components/RunTabs.ts:90-127`):
a private `deleting: Set<RunId>`, added in `deleteRun`, and released in
`willUpdate` only when the run has left the view or the surface records a
rejection on it (`this.surface?.runs.get(runId)?.rejected !== undefined`).
The release is inferred from two side effects of the request, not from its
end: a delete that ends with neither (an answer the surfaces do not record,
such as `Cancelled`, which `refusal` turns into no rejection,
`sessionSurfaces.ts:255-261`) leaves the row's delete dead until the
element is remounted. The run header's Delete
(`packages/texra/src/ui/progress/components/RunHeader.ts:452-456`) sends
the same `run.delete` with no guard at all, so the rule "one delete per run
at a time" holds in one of the two places that send it.

**The design decision behind it.** "Is this run's delete still in flight?"
is answered by the module that sends requests (it knows when the answer
arrives) and again by a list component that watches for consequences.

**The better design.** `runtimeRequestFor` runs `run.delete` under
`busyWhile(entry, 'deleting', runId, exchange)` as it runs `followUp.send`
under `'sending'`, with `Surface.deleting: ReadonlySet<RunId>` beside
`sending` (never persisted). `run-tabs` reads
`surface.deleting.has(runId)` for its focus hand-off; the header's Delete
gets the same guard for free. Deleted: `RunTabs.deleting`, its
`willUpdate` release loop, and the inference it encodes.

**What we give up, and risk.** One more never-persisted field on
`Surface` (`packages/texra/src/shared/session/surface.ts:239-243`). The
focus hand-off still waits for the row to leave the view, which it reads
from the view as now.

**How I tried to refute it.** Checked whether the surfaces could not see
the delete's end: every runtime request goes through `runtimeRequestFor`,
which already wraps one kind in `busyWhile`. Checked whether `Cancelled`
can answer a runtime request: no current producer answers `run.delete` so
(producers are host requests, `hostDraftRequests.ts:200`,
`openGuiWindow.ts:483,547`, `hostRunActions.ts:290,394`), so the dead-row
case is latent, not observed; the finding stands on the second mechanism.

## TU-8: The progress view's request path cites planning documents and names its parts with words the "Plain names" table refuses

- flags: comment restates code, vague name
- package: texra (`ui/progress/`; `approvalDecisionArm` lives in `shared/session/surfaceDecision.ts` and is also read by `packages/cli`)
- kind: docs
- size: S
- earlier: none for these files (the round-7 names lens, `2026-11-07-design-red-flags-lenses/names.md`, did not reach `ui/progress/`)
- open PR: none of the listed files

**Evidence.** Document citations in place of reasons:

- `packages/texra/src/ui/progress/sessionSurfaces.ts:155` "(C7)", `:494`
  "(7.6)"; `packages/texra/src/ui/progress/sessionTransport.ts:65` "(8.1)",
  `:383` "(contract C7)".
- `packages/texra/src/ui/progress/components/RunTabs.ts:152` "(W2)" and
  `:154` "(issue decision)"; `RunTab.ts:179` "(W2)";
  `BackgroundTasksPanel.ts:2` "(board E2)".

Refused words, with what they name:

- "arm" for a case of a union: the field `RunMenuAction.arm` and its doc
  (`packages/texra/src/ui/progress/constants.ts:14-30`, eight values;
  read at `RunHeader.ts:255-265,506`), the method `emitRuntimeArm`
  (`BaseRequestPanel.ts:218-225`, overridden at
  `ToolEditRequestPanel.ts:46-61`), the local `arm`
  (`BaseRequestPanel.ts:210-215`, from `approvalDecisionArm`), and the
  comments at `ProgressApp.ts:15`, `LogList.ts:5`, `SessionBanners.ts:10`,
  `SessionComposer.ts:12`, `BaseRunContent.ts:33`,
  `ToolEditRequestPanel.ts:43`.
- "settle": `settleHost`, `settleHostResponse`, `settleRuntimeResponse`
  (`sessionSurfaces.ts:271,354,484`, and `SessionComposer.ts:394` points at
  `settleHost`), "settles" (`sessionSurfaces.ts:582`,
  `sessionTransport.ts:175`), the `Deferred` named `settled`
  (`sessionTransport.ts:255-268`).
- "refusal" for the app's own rejection: the function `refusal`
  (`sessionSurfaces.ts:255-261`) and the comments at `:352`, `:493`,
  `RunTabs.ts:92`, `ProgressApp.ts:464` ("refused").
- "admit"/"admission": `sessionSurfaces.ts:412`, `:443`.
- "fold" as a noun: `RunHeader.ts:536` ("The fold keeps a start only while
  the run works"), meaning the session view update.

**The design decision behind it.** None; the request path was written
against the session-surface design notes and kept their section numbers
and vocabulary after they were implemented.

**The better design.** Replace each citation with the reason it stands for
(C7: "the transcript subscription follows the shown run"; 7.6: "a rejected
runtime request is also shown on the run it was made on"; 8.1: "the frames
service drops frames of an older generation"; W2: "the rail shows the
rollup without a disclosure"). Rename `arm` to `send` on `RunMenuAction`
(or delete it with TU-1), `emitRuntimeArm` to `sendRuntimeDecision`,
`settleHost*` to `applyHostAnswer` / `applyRuntimeAnswer`, `refusal` to
`shownError`, `settled` to `answer`; reword the comments. The
`approvalDecisionArm` rename (to `decisionRequest`) belongs to its owner in
`shared/session/` and its CLI readers.

**What we give up, and risk.** None; no persisted or wire string changes.

**How I tried to refute it.** Checked whether "arm" here is a documented
API name the table exempts: it is not (`RunMenuAction` is file-local to the
progress view; `approvalDecisionArm` is an app function, not a harness API
name). Checked that "seam" in `RunTabsContainer.styles.ts:21` and
`litStyles.ts` ("Seams.") means a visual hairline, and "folded" in
`ui/copy/scriptRequest.ts` means collapsed code: both left alone.

## TU-9: `formatters/constants.ts` is a drawer of single-reader values, one a tool-name table that names no live case and threads `toolName` through three painters

- flags: overexposure, pass-through, special-general mixed, shallow module
- package: texra
- kind: refactor
- size: S
- earlier: none (J8 cleaned `htmlBuilders.ts`; it did not look at `constants.ts`)
- open PR: none of the listed files

**Evidence.** `packages/texra/src/ui/progress/formatters/constants.ts`
exports seven names; each has exactly one reader (grep over
`packages/*/src`, tests included):

| Export                                                                                            | Reader                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `ICON_BY_LEVEL` (`:15-20`)                                                                        | `logFormatters/messageFormatters.ts:26`              |
| `TOOL_OUTPUT_LANGUAGES` (`:38-42`), `getLanguageFromPath` (`:72-83`)                              | `logFormatters/toolFormatters/toolSections.ts:28-29` |
| `DIFF_DETECTION_LINE_LIMIT`, `DIFF_MARKER_THRESHOLD` (`:85-86`), `INLINE_DIFF_TIMEOUT_MS` (`:96`) | `htmlBuilders.ts:32`                                 |

The file groups values by kind ("constants"), not by owner. Its own
comment (`:22-31`) says tool-name lists belong in the harness's
`toolKind`, yet `TOOL_OUTPUT_LANGUAGES` is one: `bash` → `bash`, `execute`
→ `plaintext`, `run` → `plaintext`. No tool is named `execute` or `run`
(grep over `packages/*/src`: the only hits are this table and a
replacement word list). `bash`'s entry restates the row model: a bash
call's one code section is its `command` with the `shell` hint
(`packages/harness/src/shared/transcript/toolRowSections.ts:487-492`),
which `codeLanguage` already maps to `bash`
(`toolSections.ts:94-98`), and its output never reaches
`buildToolSection` because `formatToolUseTemplate` sends bash output to
the terminal section (`toolFormatters.ts:96-104`). To read the table,
`toolName` is threaded through `renderToolSections` (`toolSections.ts:235-243`),
`renderToolSection` (`:171-193`) and `buildToolSection`'s options
(`:45`, `:58-62`), and passed in at `toolFormatters.ts:88-91` and `:100-103`.
`progress/constants.ts` has the same shape: `ELEMENT_IDS` is read by
`RunHeader.ts` and `StageList.ts` only (see TU-1).

**The design decision behind it.** "Which language is this tool's text?"
has an owner, the row model's `language` hint; the painter keeps a second,
tool-keyed answer that can only override the first, and the constants
file hides that it has one reader.

**The better design.** Delete `TOOL_OUTPUT_LANGUAGES` and the `toolName`
parameter from `renderToolSections`, `renderToolSection` and
`buildToolSection` (the language is `contentLanguage ?? 'plaintext'`). Move
each remaining value next to its reader: `ICON_BY_LEVEL` into
`messageFormatters.ts`, `getLanguageFromPath` and `EXTENSION_ALIASES` into
`toolSections.ts`, the three diff numbers into `htmlBuilders.ts`; delete
`formatters/constants.ts`.

**What we give up, and risk.** A future tool whose output is code would
state its language in its row model's section, as MCP results already do
(`toolRowSections.ts:470-475`), instead of in a UI table.

**How I tried to refute it.** Checked for a producer of an `execute` or
`run` tool name (none in the harness, the app, llm, or the agent-CLI
plugins' mappings). Checked whether any non-shell code section is emitted
for `bash` (only `buildDefaultSections` matches it). Checked whether
another module imports these values through a path alias (grep for
`formatters/constants`: three importers, as listed).

## TU-10: An answer being typed into a request card survives a run switch only on the inquiry card; the other cards keep it in element state

- flags: information leakage, repetition, non-obvious code
- package: texra (`ui/progress/components/`, `shared/session/surface.ts`)
- kind: refactor
- size: M
- earlier: J9 (round 2, landed in #14818) moved the inquiry card's draft from element state onto `Surface.inquiryDrafts` because "two owners of a draft in one view" lost it; the other cards were not in that finding. Remainder of J9.
- open PR: none of the listed files

**Evidence.** The composer "holds no draft of its own"
(`packages/texra/src/ui/progress/components/SessionComposer.ts:15`) and the
inquiry card reads and writes its answer through the surface
(`packages/texra/src/ui/progress/components/ExternalInquiryPanel.ts:91-115`,
`Surface.inquiryDrafts`, `packages/texra/src/shared/session/surface.ts:245-246`).
The other cards hold what the user has entered in the element:

- `UserQuestionPanel.ts:30-35`: `@state() selections: string[][]` and
  `@state() freeText: string[]`, the user's picks and typed answers.
- `ProposalRequestPanel.ts:71-72`: `@state() picked`, the model chosen on
  the card.
- `BaseRequestPanel.ts:135-139`, `:227-232`: `@state() noteOpen` and the
  decline note's text, read from the DOM (`this.noteInput?.value`) at send
  time, for all seven cards.

The cards are rendered by `request-panels` inside the selected run's body
(`BaseRunContent.ts:44-56`), keyed by request id
(`RequestPanels.ts:120`); selecting another run replaces the list, the
card elements are destroyed, and coming back shows an empty card. Typed
text in the inquiry card comes back; typed text in a question's "Another
answer" box, a picked model, or a half-written decline note does not.

**The design decision behind it.** "Where does an unsent answer live?"
was decided for the composer and the inquiry card (the surface, persisted
per request key) and left to each other card, which chose its own element.

**The better design.** One `Surface.requestDrafts: ReadonlyMap<requestId,
RequestDraft>` with `RequestDraft = { note?: string; model?: string;
answers?: ReadonlyArray<{ selected: string[]; text: string }> }` replacing
`inquiryDrafts` (whose key is already per request turn), one
`requestDraft` surface action, cleared when the card sends its decision
(as `ExternalInquiryPanel.emitAction` clears its draft today,
`ExternalInquiryPanel.ts:116-123`). `BaseRequestPanel` reads
and writes the note through it; the question and proposal cards read their
fields from it. Deleted: the three `@state` fields, the `picked.requestId`
guard (the key carries it), the DOM read of the note, and the inquiry's
separate map and action.

**What we give up, and risk.** The persisted surface gains entries for
these cards (it is view state, not authoritative). A request answered from
another window leaves its draft behind, as an inquiry draft does today;
`pruneSurface` could drop entries whose request the view no longer holds,
which it does not do for `inquiryDrafts` now. The proposal card's model
pick also feeds the launch form when the user opens it (`proposalEdit.ts`);
that path reads the same draft.

**How I tried to refute it.** Checked whether the cards survive a run
switch through a cache (only `log-list` caches per run, and it holds
`stage-list`s, not request cards: `LogList.ts:42-45`). Checked whether a
dated note decided element state for these cards: no note under
`.agents/docs/proposed/` names them; `UI-request-card-declaration-record`
(refused) is about the hooks, not the draft.

## TU-11: Two questions with the same wording lose one answer, which the question card documents instead of preventing

- flags: non-obvious code, comment restates code
- package: texra (`tools/userQuestion/UserQuestionTool.ts`; the comment is in `ui/progress/components/UserQuestionPanel.ts`)
- kind: bug
- size: S
- earlier: none
- open PR: none of the listed files

**Evidence.** The answers record is keyed by question text
(`packages/harness/src/shared/schemas/requestPayloads.ts:193-196`), and the
tool tells the model so (`packages/texra/src/tools/userQuestion/UserQuestionTool.ts:109`).
The tool's input accepts one to three questions with no check that their
texts differ (`UserQuestionTool.ts:22-33`, `UserQuestionPromptSchema` at
`requestPayloads.ts:180-190`). The card works around the duplicate for its
own state ("Indexed by question position … two questions with identical
wording would otherwise collide", `UserQuestionPanel.ts:30-35`) and then
writes the collapse down: "two identically-worded questions answered
independently above will silently collapse into one entry here.
Pre-existing limitation" (`UserQuestionPanel.ts:229-233`); the later
question's answer overwrites the earlier one at `:240-257`. The CLI's
modal does the same (`packages/cli/src/chat/tui/modals/UserQuestionState.ts:14`,
`{ ...answers, [question.question]: answer }`). The model receives one
answer for two questions and no sign that one was lost.

**The design decision behind it.** The key format is fixed by the answer
record; the input that can violate it is accepted at the tool boundary,
so every host that collects answers inherits a case it can only drop.

**The better design.** Refuse the input: a `Schema.makeFilter` on
`AskUserQuestionInputSchema.questions` that the question texts are
distinct, with a message the model can act on ("each question needs its
own wording"). The error then cannot reach a host. Delete both comments;
the card keeps its position index for Lit's keys.

**What we give up, and risk.** A model call that asked the same question
twice fails validation and is retried by the model, which is the
intended outcome. The `{ errors: 'all' }` decode already reports it with
the other input errors.

**How I tried to refute it.** Looked for another producer of
`userQuestion` requests that might legitimately repeat a text (only
`UserQuestionTool.ts:62` opens one). Checked whether the answer format is
an external wire that must keep text keys: it is returned to the model as
JSON (`UserQuestionTool.ts:96-99`), so keeping the keys and refusing
duplicates leaves the format alone.

## TU-12: "Which catalog option is this agent?" is written four times, and the terminal's copy matches across sources where the web's refuses to

- flags: repetition, information leakage, non-obvious code
- package: texra (touches cli: `packages/cli/src/chat/tui/forms/AgentListForm.tsx`)
- kind: refactor
- size: S
- earlier: none
- open PR: none of the listed files

**Evidence.** An agent is named by a source-qualified key or, from older
launches and proposals with no source, by a bare name. Finding its catalog
option is written:

- `packages/texra/src/ui/progress/components/composerChipMenus.ts:50-60`
  (`launchAgentOption`): `option.value === key || (agentName(key) === key &&
  agentName(option.value) === key)`.
- `packages/texra/src/ui/progress/ProgressApp.ts:58-71` (`plannedPassesOf`):
  the same rule, but the bare name is compared with `option.label`
  instead of `agentName(option.value)` (equal today only because
  `agentOptionsData` sets `label: entry.name`,
  `packages/texra/src/tools/documents/documentTask.ts:75-76`), and the
  result is `launchAgentOption(...)?.rounds` for a run's
  `identity.agent` instead of the launch's.
- `packages/texra/src/ui/progress/proposalEdit.ts:29-41`
  (`proposedAgentKey`, `isProposedAgent`): the same rule over a proposal's
  `agent` and `agentSource`.
- `packages/cli/src/chat/tui/forms/AgentListForm.tsx:105-115`
  (`currentVisibleAgent`): `agent.value === current || agentName(agent.value)
  === agentName(current)`, which also matches a source-qualified key to a
  same-named agent of another source. `ProgressApp.ts:58-61` states the
  opposite rule on purpose: "a same-named agent from another source never
  lends it its count". So the terminal can call a hidden agent visible
  (and drop its "hidden from picker" hint, `:117-124`) when another source
  has an agent of the same name.

**The design decision behind it.** The key grammar (source-qualified or
bare) is the harness's (`agentKey`, `agentName`); the matching rule over it
is re-derived by each picker, and one derivation differs.

**The better design.** One `findAgentOption(options, keyOrName)` beside
`DocumentAgentOptionSchema` in `packages/texra/src/shared/plugins/documents.ts`
(the app owns the catalog shape; the CLI already imports from
`@texra/shared`). `launchAgentOption` becomes that call;
`plannedPassesOf` becomes `findAgentOption(host.agentOptions,
run.identity.agent)?.rounds` behind the `isDocumentTaskRun` check;
`isProposedAgent` becomes `findAgentOption([option], proposedAgentKey(data))
!== undefined` or keeps its two lines over the shared predicate;
`currentVisibleAgent` takes the shared rule and so stops matching across
sources.

**What we give up, and risk.** The terminal picker's hint changes for a
user with two same-named agents from different sources: it will say the
current one is hidden when it is. That is the correct reading.

**How I tried to refute it.** Checked whether `label` and
`agentName(value)` can differ in the web catalog (`agentOptionsData` sets
both from the entry's name, so not today, but nothing ties them). Checked
whether the CLI's looser match is deliberate (no comment says so, and its
`AgentIdentity.value` is the same key grammar,
`packages/cli/src/runtime/defaultAgents.ts:45` uses `agentName` for a
bare-name lookup only).

## Good modules in this area

- `packages/texra/src/ui/copy/runStatus.ts`: one table of word and tone per
  status key over the shared classification, read by the web views, the
  terminal and the trace viewer; a new status is one row.
- `packages/texra/src/ui/progress/formatters/index.ts`: `ROW_FORMATTERS` is a
  mapped type over `TranscriptRowKind`, so a new row kind is a compile
  error, and one `try` turns a painter's failure into a visible row.
- `packages/texra/src/ui/progress/sessionTransport.ts:246-285` (`exchange`):
  one request and its answer as `Deferred` inside `acquireUseRelease`, so a
  closed session interrupts the wait and the pending entry is removed on
  every exit.
- `packages/texra/src/ui/progress/uiEvents.ts`: four events whose detail is
  the record they change, unchanged; nothing translates between a component
  and the root (TU-6 only asks that the root wiring live with the surfaces).
- `BaseRequestPanel.emitAction` (`BaseRequestPanel.ts:208-216`): every
  button and shortcut of seven cards passes one read-only check.
- `packages/texra/src/ui/wa/actionButtons.ts`: one skin vocabulary
  (`KIND_CLASS`, `SIZE_CLASS`) and a type that ties a tooltip to an id.

## Already settled, left alone

- `BaseRequestPanel`'s hooks as a declaration record: refused,
  `UI-request-card-declaration-record` (`.agents/docs/refuted-candidates.json`).
- `subscribeToSignalChanges` as Streams: refused, `UI-signal-watcher-as-streams`.
- `TerminalOutput.writeTerminalText`'s 100 ms bound
  (`TerminalOutput.ts:311`): refused, `UI-terminal-write-without-bound`.
- `ExternalInquiryPanel`'s decode cached by reference: refused,
  `UI-inquiry-decode-by-reference`.
- The pasted image's name minted by the host: refused,
  `UI-pasted-image-name-host-minted`.
- One-line placeholders, bare `<button>`s with a skin, the " — " joiner,
  fixed titles with their own dot: open in #14950's note
  `2026-11-15-ui-primitives-restated-at-call-sites.md`, items 1 to 4.
- The run list built twice (`RunTabs.ts` and the CLI), the web's "Ready" and
  "Needs approval" overrides of `runStatus`, the interrupted reading of an
  open call, child counts called "agents": open in #14955's note
  `2026-11-15-layer-misplacements-left-open.md`, items 5 to 8. (Item 7's
  first half, `getToolTimeoutMs`, is already gone at `d70ad92`: the card
  reads `model.timeoutMs`, `toolFormatters.ts:143`.)
- The run noun and the delete label written per component
  (`RunTab.ts:167-168`, `RunHeader.ts:526`, `StageList.ts:459`): fixed by
  #14955 (`runNoun`, `TASK_ACTIONS.delete(run)`).
- The markdown shields' placeholder token and restore
  (`ui/markdown/latexMathShield.ts`, `latexPlaceholders.ts`): fixed by #14953.
- J1 to J10 and J-b (round 2): landed or refused as the earlier catalogue
  records; TU-1, TU-7 and TU-10 are remainders of J-b and J9 and say so.

## Dropped on verification (11)

The host's `customDirSet` echoed back by the agent-config banner (a TC
request shape, one field); `proposalLaunchPatch`'s default for unreadable
options (producer validation not traced far enough to call it silent);
`baseLogFormatter.ts` and `detailsToggle.ts` as one-line files (too small to
carry a finding); `progressBadgeFormatter.ts` as a single-caller file (same);
`request-panels` passing `surface` and `host` to every card (harmless
properties); the stateless banner elements (`ApiKeyBanner`,
`AgentConfigBanner`) as template functions (no defect behind it);
`FileSelectConfigSchema` used only for its type (one line); the launcher
instruction and follow-up draft as two shapes (the `Surface` is TC's, and
J3/J4 reshaped it); the progress view's module-level markdown cache
(#14953's files); `getToolTimeoutMs` from #14955's note (already gone).
