# DT: the desktop app and the trace viewer

Read on `main` at `d70ad92` (the tree at `e03bcab`, whose later commits touch
only this folder). Scope: `packages/desktop/src/`, `packages/trace-viewer/`.
Open PRs touching the area: #14953 (`claude/optimistic-cori-q0n270`), #14955
(`claude/clever-pascal-h5a0xm`), #14959 (`claude/awesome-turing-6bwnxc`).

## Numbers

| Directory                             | Lines (ts, css, html) |
| ------------------------------------- | --------------------: |
| `packages/desktop/src/main/`          |                 6,598 |
| `packages/desktop/src/main/platform/` |                   244 |
| `packages/desktop/src/renderer/`      |                 8,481 |
| `packages/desktop/src/shared/`        |                 1,265 |
| `packages/desktop/src/preload/`       |                   117 |
| `packages/trace-viewer/src/`          |                   509 |

Five largest files: `renderer/styles.css` (968), `renderer/main.ts` (936),
`renderer/editorPane.ts` (785), `renderer/workbenchController.ts` (562),
`renderer/themeTokens.css` (555). Largest main-process file:
`main/desktopProjects.ts` (491).

This area has been through rounds 2 (N), 3, 4 (X-R7) and the lens audits
(N4 to N11, V-R15 to V-R18, GS6, L2-*), most landed. What follows is what the
tree shows after them.

## DT-1: Every main-process push to the renderer is typed `unknown`; the outbound union types only the receiving end

- flags: information leakage, non-obvious code, pass-through
- package: desktop
- kind: refactor
- size: M
- earlier: none for this direction (`grep -rn "postToRenderer" .agents/docs` finds only N5, the tri-state reachability, landed). TC-9 (this round) is the mirror: the renderer's and the settings view's _senders_ are untyped. This is the main process's half.
- open PR: none of the three open PRs that touch `packages/desktop/` changes a push signature

**Evidence.**

- The receiving end is typed: `renderer/messageRoutes.ts:1-3` ("The route
  table is typed over the outbound union ..., so a main-process push added
  there without its renderer end fails to compile"), and a push that fails
  `DesktopOutboundMessageSchema` is dropped with a `console.warn`
  (`renderer/messageRoutes.ts:38-44`).
- Every sending signature erases it: `main/hostBridge.ts:21`
  (`postToRenderer(message: unknown): void`), `main/desktopIpcTypes.ts:40-42`
  (`DesktopRenderer.postToRenderer(message: unknown)`, implemented by five
  modules: `desktopShellIpc.ts:45`, `desktopPromptController.ts:40`,
  `desktopDiffHost.ts:23`, `desktopLogIpc.ts:45`, `desktopPreviewHost.ts:61`),
  `main/desktopWindowHost.ts:37` (`const post = (message: unknown): void =>
  bridge.postToRenderer(message)`, a pass-through), `main/desktopHostRequests.ts:50`,
  `shared/desktopCommandSurface.ts:235-237`.
- Five sends recover the type by hand with `satisfies`
  (`desktopDiffHost.ts:112,127`, `desktopPreviewHost.ts:186`,
  `desktopPromptController.ts:62`, `desktopCommandSurface.ts:239`); the rest
  are unchecked object literals: `desktopWindow.ts:243-248` (the projects
  list), `desktopShellIpc.ts:69-72,80-83,92-94`, `desktopLogIpc.ts:50-53`,
  `desktopProjectSurface.ts:87-91,169-173`. `desktopWorkspaceIpc.ts:247`
  types its own parameter as `DesktopWorkspaceReply`, a third convention.
- The settings view's pushes share this channel and arrive typed
  (`SettingsHostBindings.post` takes `Effect<SettingsViewOutboundMessage>`,
  `packages/texra/src/controllers/settingsView/settingsHostBindings.ts:37-39`);
  `desktopProjectSurface.ts:75-77` erases them to `unknown` before posting.
- `{ postToRenderer: host.post }` is built three times in one function to
  satisfy the one-method interface (`desktopWindow.ts:164,199,362`).

**The design decision behind it.** "What may cross the push channel" is
decided by the schema union at the renderer and restated, by convention, at
each of about fifteen send sites in nine main-process modules. A misspelled
field compiles and is dropped at run time with a devtools line nobody reads.

**The better design.** One type for the channel beside the union:
`type DesktopPush = typeof DesktopOutboundMessageSchema.Type |
SettingsViewOutboundMessage` in `shared/desktopOutboundMessages.ts`.
`DesktopHostBridge.postToRenderer`, `DesktopWindowHost.post` and every
consumer take `(message: DesktopPush) => void`. The `DesktopRenderer`
interface goes (6 files reference it; each takes the function instead), the
three `{ postToRenderer: host.post }` wrappers go, the five `satisfies`
annotations become redundant and go, and `host.post` is
`bridge.postToRenderer` itself. A push added without its union member, or
with a wrong field, fails to compile in the main process.

**What we give up, and risk.** Nothing at run time; the renderer still
decodes (the push channel is a process boundary). About 80 changed lines
across nine files.

**How I tried to refute it.** Checked whether a typed helper already sits
between the senders and the bridge (only `postDesktopSettingsView`, for one
message). Checked that the settings pushes and the desktop pushes really share
the one channel (`hostBridgeChannels.ts:1-3`, `ELECTRON_WEBVIEW_PUSH_CHANNEL`;
`renderer/main.ts:844-848` says the settings view's pushes "match no route
here"), so the channel type must be the union of both. Checked the session
channel: `postSession(message: DownWire)` is already typed
(`hostBridge.ts:22`), so only the webview channel is affected.

## DT-2: Every desktop command is implemented once per process, each forwarding the other's half, and the two "New Task"s have drifted

- flags: repetition, information leakage, special-general mixed, comment restates code, vague name
- package: desktop
- kind: bug (the drift) and refactor
- size: M
- earlier: none (`grep -rn "dispatchDesktopCommand\|DESKTOP_SHELL_IPC_COMMANDS\|createDesktopShellActions\|DESKTOP_MENU_GROUPS" .agents/docs` finds nothing). N-vscode-desktop "Good modules" praised the extension's registration through `dispatchCommandFromRegistry` "the same dispatch as the desktop"; that is the general registry this finding says the desktop does not need.
- open PR: none

**Evidence.**

- `DesktopCommandActions` (`shared/desktopCommandSurface.ts:126-136`, nine
  members) has two implementations. The main process's
  (`main/desktopShellIpc.ts:44-105`) does three things itself (docs, log
  folder, open folder) and posts the other five to the renderer as four
  push messages (`:68-84`, `:91-95`: `desktop:openWorkbench`,
  `desktop:openSettings`, `desktop:saveFile`, `desktop:toggleLayout`). The
  renderer's (`renderer/main.ts:668-686`) does those five itself and posts
  the main process's three back (`:672-680`), which main accepts only
  through a second allow-list, `DESKTOP_SHELL_IPC_COMMANDS`
  (`desktopCommandSurface.ts:64-74`), whose comment is the hand-off protocol
  ("accepting them here would let a renderer message bounce").
- The renderer then routes the four pushes back onto its own actions by hand
  (`renderer/main.ts:706-735`, with `LAYOUT_PANEL_TOGGLES` restating
  `toggleBottomBar`/`toggleSidePanel` from `:684-685`).
- **The drift.** "New Task" (`texra.showMainView`). The native menu's runs
  `showLauncher` in main: `bridge.surfaceAction({ kind: 'selectNew' })`
  only (`main/desktopWindow.ts:204-208`). The palette, the shortcut and the
  sidebar's "+" run the renderer's `returnToLauncher`, which also opens the
  Agent tab (`renderer/main.ts:700-704`, wired at `:556` and `:669`). The
  Agent tab is closable (the dock's group menu reopens it,
  `renderer/dockControls.ts:19-25`), so File > New Task with the tab closed
  selects the New-task state in a pane that is not on screen. The comment at
  `main/desktopShellIpc.ts:96-98` claims parity with "the header's '+'",
  which is the renderer one.
- **A general dispatcher for no case the desktop has.** Every desktop handler
  is a no-argument `action(...)` that returns `true`
  (`desktopCommandSurface.ts:161-195`); none is a `definedHandler`
  (`grep -rn definedHandler packages/*/src`: only
  `packages/extension/src/commands.ts`). Yet dispatch goes through
  `dispatchCommandFromRegistry` with an `invalidArguments` branch that cannot
  fire and an `unhandled` branch the `satisfies Record<...>` at `:192-195`
  already rules out (`:212-228`), and returns `boolean | Promise<boolean>`.
  The palette keeps a branch and a seven-line comment for a Promise no
  handler returns (`renderer/desktopCommandPalette.ts:86-100`); main
  discards the value (`desktopShellIpc.ts:123`, `void dispatchDesktopCommand`).
  The registry's default result type is documented as "the desktop
  registry's sync handlers" (`packages/texra/src/shared/commands/registry.ts:7-9`).
- **Names that say something else.** `DESKTOP_MENU_GROUPS`,
  `getDesktopCommandMenuEntries` and `DesktopCommandMenuEntry`
  (`desktopCommandSurface.ts:38-57,112-118,138-157`) are the palette's and
  the shortcut registry's list (`renderer/desktopCommandPalette.ts:108`,
  `renderer/desktopShortcutRegistry.ts:52`); the native menu lists its own
  items by hand (`main/desktopMenuTemplate.ts:84-150`) and reads only the
  label, dropping the accelerator the entry computes (`:72-79`). The groups'
  nesting is flattened at `:90` and never read. The "Electron accelerator"
  form (`shared/accelerators.ts:12-20`) is thus produced for no Electron
  consumer: the renderer converts the catalog keybinding into it, converts
  each key event into it to compare (`desktopShortcutRegistry.ts:148-188`),
  and converts it again for display (`accelerators.ts:22-32`).
  `toggleBottomBar` and `toggleSidePanel` show, they do not toggle
  (`renderer/main.ts:684-685`).

**The design decision behind it.** "What a desktop command does" has one
owner per process, and the processes forward to each other, so each command
crosses the IPC boundary as its own message kind and each process keeps a
copy of the other's list.

**The better design.** The renderer owns `DesktopCommandActions` (it holds
every UI action). The main process implements only the three that need it,
which is `DESKTOP_SHELL_IPC_COMMANDS` already. A native menu click for any
other id posts one push, `{ command: 'desktop:runCommand', id }`, which the
renderer dispatches through the same function its palette and shortcuts
call. Dispatch is a plain lookup: `DESKTOP_COMMAND_HANDLERS` becomes
`Record<id, (actions) => void>` and `dispatchDesktopCommand` returns
`void`. Deleted: main's five renderer-bound actions and `openWorkbench`,
`toggleLayout`, `showSettings`, `saveFile` helpers
(`desktopShellIpc.ts:68-95`) and the `showLauncher` option
(`desktopWindow.ts:204-208`); `DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH`,
`SAVE_FILE`, `TOGGLE_LAYOUT`, their three schemas and the
`DesktopLayoutPanel` type (consumers: `desktopShellIpc.ts`,
`renderer/main.ts`, `desktopOutboundMessages.ts`); three renderer routes
and `LAYOUT_PANEL_TOGGLES`; `action()`, the registry call and its failure
callback, the palette's Promise branch. `OPEN_SETTINGS` stays: host requests
post it with a tab (`desktopHostRequests.ts:123-138`). Rename the list to
what it is (`DESKTOP_PALETTE_COMMANDS`, `paletteEntries`), give the menu's
items their accelerator from the same entry (or keep the menu without them
and say so), and name the two "toggle" actions `showTerminal` and
`showFiles`. The drift disappears because there is one `showLauncher`.

**What we give up, and risk.** A menu command for a renderer action now does
nothing while the renderer is hung; today it posts a push the hung renderer
ignores equally. Two e2e helpers post `desktop:openWorkbench`
(`tests/e2e/electronApp.ts:366-374`, `tests/e2e/menuLifetime.spec.ts:83`)
and move to `desktop:runCommand`. If the extension then is the registry's
only consumer, its default result type can go too.

**How I tried to refute it.** Looked for a reason main must run the five
UI actions itself: none reads main-process state (they only post).
Checked whether the main `showLauncher`'s difference is deliberate: its
comment says the opposite (parity with the "+"), and no test pins the menu's
New Task. Checked that a surface action pushed over the session channel does
not open the Agent tab on the way in: the only `openKind('agent')` on a
surface action is the DOM listener for actions the page itself dispatched
(`renderer/main.ts:888-901`), which a main-process push never reaches.

## DT-3: Each native message box is its own `tryPromise` over `dialog.showMessageBox`, with its own error, parent choice and button-index decoding

- flags: repetition, non-obvious code
- package: desktop
- kind: refactor (one unguarded call is a latent fatal exit, see below)
- size: M
- earlier: remainder of GS2 (`../2026-11-07-design-red-flags-lenses/general-special.md:236-241`, catalogue row GS2 "landed (#14818)"). GS2 listed "the desktop builds five bespoke 'choose among labels' boxes beside its port" as evidence; what landed was the port (`Dialogs`, three members). The boxes are still written one by one, and two more have appeared since (the sign-in presenters, the telemetry notice).
- open PR: #14955 touches `desktopWindowHost.ts:236-238` (`confirmAcceptFile` becomes `confirm`), not the boxes

**Evidence.** Nine window message boxes in five files, each a separate
`Effect.tryPromise` (or a bare promise) over `dialog.showMessageBox`:

| Site                                                                 | Error it raises                                                           | Answer decoded as                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| `desktopDialogs.ts:48-72` notify                                     | logged, none                                                              | ignored                                        |
| `desktopDialogs.ts:79-99` confirm                                    | `HostFailed { member: 'dialog.showMessageBox' }`                          | `response === 0`                               |
| `desktopDialogs.ts:107-134` error with guide                         | the same, other wording                                                   | `response === 0` opens the guide               |
| `desktopDialogs.ts:142-174` instruction                              | the same, third wording                                                   | `choices[response]`                            |
| `desktopDialogs.ts:176-199` export format                            | `TranscriptExportFailed`                                                  | `CHOICES[response]?.format`                    |
| `desktopWindowHost.ts:165-184` new release                           | `ensureError`                                                             | `response === 0`                               |
| `desktopSignInPresenters.ts:12-24` (two callers, `:37-47`, `:56-70`) | `ensureError`                                                             | `result.response === 0`                        |
| `platform/warningDialog.ts:11-25`                                    | `ensureError`                                                             | ignored; picks focused-or-any window as parent |
| `index.ts:213-220` telemetry notice                                  | none: `void (parent ? showMessageBox(parent, ...) : showMessageBox(...))` | ignored; picks a parent a second way           |

Each passes `buttons`, `defaultId`, `cancelId` by hand and maps the index
back. The callers of `warningDialog` each wrap it again: `index.ts:247-269`
maps its failure to a `HostFailed` stamped `member: 'dialog.showMessageBox'`
and logs it; `desktopProjects.ts:246-257` logs it with the message.

The telemetry notice's bare promise is the non-obvious case: a rejection
there is an unhandled rejection, and after startup
`installPostStartupRejectionHandler` (`fatalStartupError.ts:29-43`) treats
every unhandled rejection as fatal ("TeXRA hit an unrecoverable error after
startup and must close"). A notice that could not be shown would quit the
app.

**The design decision behind it.** "Ask the user to pick one of these
labels, against this window, and say which" is decided at each site, with
the index arithmetic and the failure wording restated.

**The better design.** One primitive in `desktopDialogs.ts`:
`choose<T>(parent, { type, message, detail?, project?, choices: readonly
{ label: string; value: T }[], cancel: string }): Effect<T | undefined,
HostFailed>`, the cancel button appended and defaulted, `parent` either the
window or "the focused window, else any, else none" (the one rule
`warningDialog` and the telemetry notice now each write). Every row above
becomes a call with its own labels and values: `confirm` is
`choose({ choices: [{ label: question.action, value: true }] })` read as
`?? false`; the guide, the instruction actions, the export formats, the
release download and the sign-in copies are their choice lists; `notify` and
the warnings are `choose` with no choices, forked and logged as today. The
telemetry notice goes through it and can no longer reject unhandled.
Deleted: eight `tryPromise` blocks, three `HostFailed` constructions with
their wordings, `showInfoDialog`, the two parent-picking branches, the
`HostFailed` re-stamp at `index.ts:250-257`. `fatalStartupError.ts` keeps its
own boxes: it runs with no runtime (`DESKTOP-headless-through-config`'s
reason).

**What we give up, and risk.** The three wordings of "could not be shown"
become one. About 120 changed lines, mostly deletions.

**How I tried to refute it.** Checked whether the boxes differ in a way a
shared primitive would lose: they differ only in `type`, labels, the default
button and whether the project line is added (`inProject`, already shared
within `desktopDialogs.ts`). Checked GS2's design: it proposed the port and
named these boxes only as evidence, so this is what it left, not what it
refused. Checked that the telemetry notice's promise is not handled
elsewhere: `index.ts:217` voids it inside an `Effect.gen` body, outside any
`tryPromise`.

## DT-4: The onboarding card's ChatGPT sign-in raises its "not attached" guard as a defect, past the typed error its `mapError` was written for

- flags: non-obvious code, pass-through, conjoined methods, comment restates code
- package: desktop
- kind: bug
- size: S
- earlier: none (`grep -rn "signInWithChatGpt\|settings IPC is not attached" .agents/docs`: N3 cited this file for the funnel wiring, which landed). The setup half of the same module, `runSetup`, is item 3 of the open note `../../proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md:71-84`, left alone here.
- open PR: none (#14955 edits `desktopHostRequests.ts` but not `onboarding`)

**Evidence.** `main/desktopWindowOnboarding.ts:85-98`:

```ts
// Suspended so the "settings IPC not attached" guard raises when the
// card's program runs, not when it is built.
signInWithChatGpt: () =>
  Effect.suspend(() => {
    const settings = options.settings();
    if (!settings) {
      throw new Error('Desktop settings IPC is not attached.');
    }
    return settings.signInSubscription('chatgpt');
  }).pipe(
    Effect.mapError((cause) =>
      hostFailure('onboarding.signInWithChatGpt', cause),
    ),
  ),
```

A `throw` inside `Effect.suspend` is a defect, not a failure (the repo says
so itself: `packages/cli/src/runtime/approval/approvalPrompts.ts:119`,
`packages/harness/src/agent/runtime/delegation/inputFields.ts:177`), so the
`mapError` never sees it: the card's host request ends in a die instead of
the `RequestRefusal` its type (`:55-59`) promises and the card shows.
`settings()` is `undefined` whenever the window's settings surface is
between projects: `attach` clears it before closing the old surface and
sets it only after the new one is built
(`main/desktopProjectSurface.ts:184-189`), and the window's finalizer
clears it (`:62-67`). A click on the card during a project switch is enough.

The member is otherwise a pass-through: it forwards to
`DesktopSettingsIpc.signInSubscription` (`desktopSettingsIpc.ts:62-68,177`)
through a getter the window threads in because the settings surface is built
after the onboarding (`main/desktopWindow.ts:190-196`, a comment explaining
the ordering). `desktopHostRequests.ts:140-142` then wraps the call in a
second `Effect.suspend`. The extension's binding is one line,
`Effect.suspend(() => options.signInSubscription('chatgpt'))`
(`packages/extension/src/progressView/extensionHostRequests.ts:350-355`).

**The design decision behind it.** "Is there a settings surface to sign in
through right now?" is answered by a throw, in a module that only forwards.

**The better design.** Refuse in the typed channel: `settings ?
settings.signInSubscription('chatgpt') : Effect.fail(hostFailure(
'onboarding.signInChatGpt', new Error('No project shows settings yet; try
again.')))`. The bindings are opened before the surface
(`desktopWindow.ts:214-229`), so a lazy read of the surface stays; it can be
the one the window already holds (`surface.settings()`), passed to the
bindings in place of the `onboarding` object's forwarding member. Deleted:
`WindowOnboarding.signInWithChatGpt` and its interface member
(`desktopWindowOnboarding.ts:55-59,85-98`), the `throw`, the comment that
calls it "raises", and the second `Effect.suspend` at
`desktopHostRequests.ts:140-142`. `WindowOnboarding` keeps `runSetup` until
the open note's item 3 moves it.

**What we give up, and risk.** None; a regression test would click the card
with no surface attached.

**How I tried to refute it.** Checked whether something above maps defects to
a refusal: the shared table's `HostVerb` error channel is
`HostCommandFailure` (`packages/texra/src/controllers/session/openGuiWindow.ts:150-154`),
and the `onboarding` case yields the verb directly (`:690-691`), so a die is
not converted there. Checked whether `settings()` can actually be
`undefined` after the first attach: yes, `desktopProjectSurface.ts:187` sets
it to `undefined` before yielding on the old scope's close and the new
surface's build.

## DT-5: The recent-projects list is stored once and mirrored into the registry's state by a re-read after every write

- flags: information leakage, repetition, temporal decomposition
- package: desktop
- kind: refactor
- size: S
- earlier: remainder of N7 (`../2026-11-06-design-red-flags-round-2/N-vscode-desktop.md:415-476`; catalogue "landed (#14799: one `Semaphore`); its `RcMap` design refused (`RT-desktop-projects-rcmap`)"). N7 named the mirror first ("`DesktopProjectsState.recent` is a cache of a store the same module writes"); #14799 landed the lane, the refusal covers only the `RcMap`, and the mirror is still there. N7's fix needed a change stream on `CurrentValues` it said was missing; that member now exists.
- open PR: none (#14953's `desktopProjectRecords.ts` edit, `Schema.NonEmptyString`, is already on `main`)

**Evidence.**

- `DesktopProjectsState.recent` (`main/desktopProjects.ts:86-88`) copies
  `DESKTOP_PROJECTS.recent` (`main/desktopProjectRecords.ts:26-32`).
- It is re-read after each write that can change it, inside the selection
  lane so a stale read cannot land last (the comment at `:344-345` explains
  that protocol): at the registry's open (`:335`), in `syncRecent`
  (`:346-349`, for `clearRecent` at `:464-467`), after `remember` in `open`
  (`:405-410`), and after `forget` in `close` (`:446-457`). Four reads, one
  helper, for a value the module itself just wrote.
- The write already holds the next value: every list operation is
  `update(change)` over `values.modify` (`desktopProjectRecords.ts:58-65`),
  which answers whatever the change returns as `A`
  (`packages/harness/src/shared/session/database.ts:157-169`); `update`
  returns `undefined` there.
- `CurrentValues.changes(family, keys)` exists now
  (`database.ts:177-185`), which N7 said the records lacked.

**The design decision behind it.** "What is in Open Recent" has an owner
(the stored value) and a copy (the state the menu and the rail follow), kept
equal by a read-after-write protocol each writer repeats.

**The better design.** `update` answers the lists it wrote
(`Result.succeed([next, next])`), so `remember`, `forget` and
`replaceRecent` return `ProjectLists`, and the registry sets `recent` from
that result in the same `SubscriptionRef.update` as the project list and
active key. Deleted: `syncRecent`, the three in-registry `readRecent` reads
and the ordering comment; `readRecent` keeps its one launch-time reader
(`readRememberedDesktopProjects`, `:227`). The alternative, dropping
`recent` from the state and following `values.changes`, splits the one
`desktop:projects` push into two sources; the returned value keeps it one.

**What we give up, and risk.** Nothing; the desktop holds the
single-instance lock (`bootstrap.ts:12`), so no other process writes this
row between the write and the state update.

**How I tried to refute it.** Read `RT-desktop-projects-rcmap`
(`refuted-candidates.json:409-420`): it refuses the `RcMap` and the
per-root resource map, not the mirror. Checked for a second writer of
`DESKTOP_PROJECTS`: only this module and the package smoke's seed
(`scripts/desktop-package-smoke-environment.mjs`), which runs before launch.

## DT-6: Where the built main bundle sits is guessed at run time, and the bundle layout is restated in three modules beside a `mainDir` threaded four layers deep

- flags: non-obvious code, information leakage, pass-through, repetition
- package: desktop
- kind: refactor
- size: S
- earlier: remainder of FB7 (`../2026-11-07-design-red-flags-round-7-fallbacks/REPORT.md:423-462`, catalogue "landed (#14849)"). FB7's rule, "the build layout is a build fact: build-time constants, no run-time search", landed for the CLI and for the desktop's resources directory; `resolveDesktopMainDir` is the same candidate loop and was not in FB7's evidence (`grep -rn "resolveDesktopMainDir\|mainDir" .agents/docs` finds nothing).
- open PR: #14959's edit of `desktopService.ts` (`serviceBundlePath`, `SERVICE_SUBCOMMAND`) is already on `main`; nothing else touches these files

**Evidence.**

- `main/platform/paths.ts:15-39`: `resolveDesktopMainDir` walks `startDir`
  and two ancestors looking for `../preload/index.cjs` and
  `../renderer/index.html`, and when none matches returns `startDir`
  anyway, so a wrong layout surfaces later as a window with no preload.
- Why the loop exists is a fact three files away: `bootstrap.ts:17`
  imports `./index.js` dynamically, and `esbuild.main.mjs:50-56` splits it
  into `chunks/[name]-[hash]`, so `import.meta.dirname` at `index.ts:35` is
  `dist/main/chunks`, one level below the entry. Nothing says so; the loop
  answers a question the build fixes.
- The layout is restated: `../preload/index.cjs` and
  `../renderer/index.html` at `paths.ts:27-28` and again at
  `desktopBrowserWindow.ts:58,101`; "the extension package in a dev run, the
  Resources directory when packaged" at `paths.ts:54-56`
  (`.../resources` under each) and again at `desktopService.ts:27-32`.
- `mainDir` is threaded to those two readers through
  `platform/index.ts:50,63,125` → `index.ts:145,187` →
  `desktopWindow.ts:86-87,112,395` → `desktopBrowserWindow.ts:15,81`, and
  `desktopService.ts:40`.

**The design decision behind it.** "Where are this build's files?" is
answered by searching, and each consumer joins its own relative path.

**The better design.** The entry module's directory is fixed (`main` in
`package.json:14` is `dist/main/index.js`, the bootstrap), so `bootstrap.ts`
hands `import.meta.dirname` to `index.ts` (or esbuild `define`s it, as the
CLI's build constants do). One `desktopLayout(mainDir, app.isPackaged)` in
`platform/paths.ts` returns `{ preload, rendererPage, resourcesPath,
serviceBundle }`, computed once in platform init; the window takes
`preload` and `rendererPage`, the service takes `serviceBundle`. Deleted:
`resolveDesktopMainDir` (one caller), the two dev-path joins in
`desktopService.ts` and `desktopBrowserWindow.ts`, the `mainDir` parameter of
`openDesktopBrowserWindow`, `loadDesktopWindow`, `reachDesktopService` and
`DesktopWindowOptions`.

**What we give up, and risk.** A change of `chunkNames` or of the entry no
longer "just works" by search; it fails at the one place that names the
layout, which is the point. About 50 lines.

**How I tried to refute it.** Checked whether the main bundle can sit at
more than one depth in some build: one esbuild config, one `outdir`, one
`chunkNames`; the dev run (`ELECTRON_RENDERER_URL`) loads the same
`dist/main`. Checked that the e2e and the package smoke do not relocate the
bundle (they launch `packages/desktop` or the packaged app).

## DT-7 (batched): Smaller facts with two owners and options for one caller in the main process and the workbench

- flags: information leakage, overexposure, special-general mixed, shallow module, vague name
- package: desktop
- kind: refactor
- size: S
- earlier: none for these items (each grepped in `.agents/docs`; GS6, the pane kinds in six functions, landed and is not this)
- open PR: none touches these lines

**Evidence and fix, per item.**

1. **The workbench tab id format is composed in four modules.**
   `openWorkbenchTab` builds `workbench:${kind}[:serial|:target]`
   (`shared/desktopShellState.ts:92-94`), and the same strings are written
   by hand at `desktopShellState.ts:74-75` (`'workbench:agent'`),
   `renderer/projectWorkbench.ts:154,174` (`workbench:editor:${path}`),
   `renderer/main.ts:748` (`'workbench:review'`) and
   `renderer/workbenchController.ts:279,487,490` (`'workbench:files'`,
   `'workbench:agent'`). The ids are persisted in the surface's layout, so a
   drift loses a tab on restore. Fix: one exported `workbenchTabId(kind,
   target?)` beside `openWorkbenchTab`, used at the seven sites; the format
   itself does not change.
2. **A one-value-per-site literal nothing reads.**
   `DesktopLogActionFailed.action: Literals(['copy', 'export'])`
   (`main/desktopLogIpc.ts:24-31`, set at `:84,101,115`); no reader in
   `packages/` or `src/` ("an error kind nothing branches on is a message").
   Delete the field; the message already says which action failed.
3. **A boolean flag for one caller.** `ProjectSurface.attach(documentChanged?:
   boolean)` (`main/desktopProjectSurface.ts:43-45,178-182`) is passed `true`
   only by the document reset (`desktopWindow.ts:291`); the other two calls
   pass nothing (`:280,383`). The reset is "close the surface and attach
   again": expose `reattach` (or let the reset close the surface scope it
   owns) and `attach` loses the parameter.
4. **A getter for a constant.** `getWorkspacePath(): string | undefined`
   (`main/desktopWorkspaceIpc.ts:72-80`) is always `() => project.root`
   (`desktopProjectBindings.ts:184`), and a binding never changes project
   (one binding per project, `:198-311`). Pass `workspaceRoot` as a value;
   the five-line comment about "not whichever project happens to be
   active" becomes the type.
5. **A misleading port name.** `bootstrapDesktopWindowLifecycle` takes
   `workspaceIpc: { disposeRendererResources() }`
   (`main/desktopWindowLifecycle.ts:10-12,28-30,56-58`); its one caller
   passes the window's whole document reset (`desktopWindow.ts:305-310`:
   prompts, bindings, surface), not the workspace IPC's disposal. Name it
   `onDocumentReloaded()`.
6. **"The project's title name, or none" derived twice.**
   `project.root && project.display.name` at `desktopWindow.ts:108-111` and
   `desktopProjectSurface.ts:204-208`, because `projectDisplayOf` names the
   no-workspace session "No project open"
   (`packages/texra/src/shared/session/hostSnapshot.ts:64-70`) and the
   title wants nothing there. `getDesktopWindowTitle` and
   `installDesktopWindowTitle` can take the project and decide it once
   (`desktopWindowTitle.ts:20-30,37-42`).
7. **Two context services provided at one site for one consumer.**
   `DesktopProjects` (`desktopProjects.ts:145-150`) and
   `DesktopAttentionPort` (`desktopAttention.ts:17-40`) are each provided
   only at `index.ts:226-235`, around their one reader,
   `followDesktopAttention` (`desktopAttention.ts:106-108`); the port has one
   implementation and no test fake (`packages/desktop/test/desktop/` has no
   attention suite). Two ordinary parameters
   (`followDesktopAttention(registry, electronAttentionPort({...}))`) say
   the same with two classes fewer; the port interface stays as the
   parameter type.

**What we give up, and risk.** Item 1 is the one with reach: the e2e
selectors read the ids (`tests/e2e/workspaceTabs.spec.ts:221,233,398`),
which keep working since the format is unchanged.

**How I tried to refute them.** Grepped each symbol's consumers in
`packages/*/src`, `packages/*/test`, `packages/desktop/tests` and `src/`
(counts above). For item 7, checked that no layer or second provision
serves either service (`grep -rn "DesktopProjects\b\|DesktopAttentionPort\b"
packages`: the two definitions, the reader, `index.ts`).

## DT-8 (batched): Two false comments about the IPC schemas, and the words the "Plain names" table refuses

- flags: comment restates code, vague name
- package: desktop (touches trace-viewer)
- kind: docs (item 1 is a false comment, `kind: bug` by the brief's rule for comments)
- size: S
- earlier: none for items 1 and 2; the LC lens samples the whole repo for item 3 and will merge
- open PR: none

1. **The "parity note" says the union catches what it does not.**
   `shared/desktopOutboundMessages.ts:11-16`: "Unknown-key drift on this
   channel is caught by this union (a `command` that matches no member fails
   the whole parse) and by the renderer's route table". Every member is a
   `Schema.Struct`, which ignores undeclared keys (root `AGENTS.md`
   "Structs ignore undeclared keys"), so a misspelled optional field passes
   the union and the route; only an unknown `command` fails. The comment
   describes a check that does not exist. Replace with the true sentence
   (an unknown command fails the parse; extra keys are ignored), or let
   DT-1's send-side type make drift a compile error and delete the note.
2. **The prompt schemas cite that union for a message it does not carry.**
   `shared/desktopPromptMessages.ts:7-11` says the prompt schemas' key
   drift "is dev-caught by `DesktopOutboundMessageSchema`'s discriminated
   union plus the route table". `DesktopSettlePromptMessageSchema`
   (`:25-30`) is a renderer-to-main message, absent from that union
   (`desktopOutboundMessages.ts:43-70`) and decoded by `parsedRoute` in
   `desktopPromptController.ts:31-37`. Delete the five lines; the schema is
   an ordinary `Schema.Struct` like every other.
3. **Refused words and a document citation.** "settle", "settles",
   "settlement" in 22 comments and names across `packages/desktop/src`
   (e.g. `desktopPromptController.ts:24-29,46,75`, `desktopDiffHost.ts:26`,
   `desktopPreviewHost.ts:45,64`, `desktopWindow.ts:89`,
   `desktopProjects.ts:61,134`, `renderer/promptOverlay.ts:78`); "arm" for a
   request case at `desktopHostRequests.ts:4-5,67-69,153-155`,
   `desktopFileSelection.ts:27` and `renderer/main.ts:865`; "plane" at
   `desktopAgentRunHost.ts:19` and `packages/trace-viewer/src/traceFrames.ts:2,69`;
   and the citation "(8.3)" at `desktopFileSelection.ts:27`. Rewrite to
   "answer", "finish", "case", "the live reader". The wire command
   `desktop:settlePrompt` (`desktopPromptMessages.ts:5`) is a wire string
   and keeps its spelling; its TypeScript key `SETTLE` may become `ANSWER`.

## Good modules in this area

- `main/desktopWindow.ts` as the window's composition root: one router over
  `commandRoutes` with a duplicate-owner check (`:374-381`), one run site per
  command (`:135-138`), session messages addressed by key (`:142-158`),
  everything in the window's scope. Still the shape to keep.
- `main/desktopWindows.ts`: the window lifetime as one tagged `WindowState`
  (`:52-61`) with a cached release that every closer joins (`:155-176`).
- `main/desktopWorkspaceIpc.ts`'s containment (`resolveWorkspacePath`,
  `resolveWorkspaceWritePath`, `:177-244`) and its compare-and-write save
  under the file's write lane (`:351-377`).
- `main/desktopAttention.ts`'s `followDesktopAttention`: a reading of the
  shared `attentionOf` rule with no decision of its own (DT-7 item 7 only
  trims how it is handed its two inputs).
- `packages/trace-viewer/src/traceFrames.ts`: the exported trace answered
  through the live reader's own `replayInputs`, so the unchanged webview runs
  against a document.

## Already settled, left alone

- The open note `../../proposed/simplification/2026-11-15-host-rules-and-app-facts-with-two-owners.md`
  holds six desktop items, not repeated here: opening a project's roots
  (`desktopProjects.ts:369-398`), building a TeX file to show it
  (`desktopPreviewHost.ts:127-187`), the setup launch's outcomes
  (`desktopWindowOnboarding.ts:34-48,70-84`), the rejected GitHub token
  (`desktopSettingsIpc.ts:165-173`), the settings view's run verbs
  (`desktopProjectSurface.ts:146-165`, including "reads the active project,
  not the bound one") and reaching the bundled service (`desktopService.ts`).
- `RT-desktop-pty-host-effect`, `RT-desktop-window-fiberhandle`,
  `RT-desktop-projects-rcmap`, `RT-tool-edit-staging-one-owner` and
  `DESKTOP-headless-through-config` (`.agents/docs/refuted-candidates.json`):
  no new evidence. DT-5 reports only the `recent` mirror, which the `RcMap`
  refusal does not cover.
- TC-9 (this round): the renderer's untyped `postMessage(command, payload)`
  senders. DT-1 is the main-process direction only.
- TU-1, TU-2 and TU-6 (this round) cover `renderer/desktopShell.ts`'s action
  menu, the project rename in `renderer/main.ts:228-237` and the shell's four
  event listeners (`renderer/main.ts:880-905`).
- N11's kept items: the renderer entry's own `let`s (`applyingProjectList`,
  `shell`) and the trace bridge's `cut`/`selected`, read outside any runtime.
- `terminalPane.ts:142`'s `catch {}` and `desktopAppLog.ts`'s logging guards:
  accepted under the review checklist's section 15.

## Dropped on verification (10)

The tool-edit host's getter class (inside `RT-tool-edit-staging-one-owner`);
the native menu's missing accelerators as a defect (the renderer handles the
keys; kept only as a naming point in DT-2); `liveNotifications` as shared
state (module-private, never returned); `void window.loadFile` (a load that
fails should be fatal); `DesktopPromptController`'s correlation map
(`Effect.callback` with a finalizer is the right primitive); the title
module's `Pick` types; the second `Effect.suspend` around `recheckTools` and
`runSetup` (harmless, folded into DT-4 where it matters); the binding's
`released` flag (it guards node-pty callbacks that fire outside Effect); the
renderer's layout decode cache (`projectWorkbench.ts:75-86`, a cheap
identity check on an untyped boundary); the trace bridge's module `let`s
(N11, kept).
