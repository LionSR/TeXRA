# Data shapes the 2026-11-25 audit verified and did not land

Date: 2026-11-25
Status: proposed
Origin: the 2026-11-25 scheduled data-structure audit, read on `main` at
`37a22c5`. Its PR landed eleven shapes: a fact stated twice (a tool result's
`duplicateOf`, the setup launch model's second map, a pasted image's id,
media type and name, an unavailable usage snapshot's plan fields and each
window's `percentRemaining`), one state in several fields (the desktop file
tree's top level, a parsed approval answer), "none" spelled two ways (the
carrier of a retry's credentials, the LaTeX search path's inputs), and optional fields
their one producer always sets (the headless prompt hooks, the CLI command
name and status bar inputs, the provider key status, `desktop:showDiff`).
The findings below were checked against their producers and readers and held
back, each for the reason given, in the order worth taking.

Two PRs open that morning (#15229, #15230) delete the document pipeline and
the coding-agent plugins across about 430 files; a finding whose readers
they rewrite waits for them.

Rechecked on the evening of 2026-11-25 (the core-notes sweep): none of
1–3 is decision-free yet. 1 and 3 still need the owner's word (a plugin
API signature; a stored global value with no version). 2 changes the
`context.edit` encoding, so it needs a row-version bump and a regenerated
golden store (`src/test-kernel/fixtures/storage/golden-1.0.sql`), which an
open PR holds; keeping the encoding (each case writing its `null`s) would
delete the filter but keep the nulls, which is not the shape proposed.
`RegisterRunOptions.takesFollowUps` (5) waits too: two of its producers
(`executeAgent.ts`, `processRun.ts`) are in an open PR.

Landed on the evening of 2026-11-26, after #15229 merged: 2 and the
`takesFollowUps` entry of 5 (each below).

## 1. Request payloads restate the `requestId` and `runId` their row carries

Every schema in `packages/harness/src/shared/schemas/requestPayloads.ts`
carries `requestId` and `runId` in `payload.data`, while the
`request.opened` row carries `requestId` and `aggregateId` and the view's
pending request carries all three. `openRequest`
(`packages/harness/src/agent/runtime/requests.ts`) copies
`payload.data.requestId` onto the row. Readers of the copy:
`packages/harness/src/agent/runtime/loop/toolGuard.ts`, the progress panels
(`packages/texra/src/ui/progress/components/BaseRequestPanel.ts`,
`ProposalRequestPanel.ts`), and the CLI
(`packages/cli/src/chat/tui/state/approvalQueue.ts`,
`packages/cli/src/chat/tui/appInteractionPolicy.ts`, which reads
`pending.payload.data.runId || undefined` beside `pending.runId`).

Proposed: drop both fields and `RequestBaseSchema`; a tool passes the id it
minted beside the payload, and a panel takes the pending request.

Held back: it needs a decision. A tool opens a request through
`CallRequests.ask(payload)` on the plugin surface, and the id inside the
payload is how it names the request it will wait on; the new signature is a
public API change. About twenty files, four of them in the open PRs.

## 2. `context.edit` is three cases written as nullable fields and a filter

`ContextEditPayloadSchema`
(`packages/harness/src/shared/schemas/runHistoryEvent.ts`): `trigger` is
non-null exactly for a compaction (a custom filter says so), `usage` is
non-null only there, `input` is set only by a fork, and a fork's `range` is
always `0..0`, which `packages/harness/src/shared/session/runState.ts`
checks at run time.

Proposed: a union on `cause`, each case with its own fields.

Held back: three readers take a field from every case today
(`packages/harness/src/agent/runtime/makeRunHistory.ts` reads `range.from`,
`packages/harness/src/controllers/session/projections.ts` reads `usage`), so
each gains a narrowing where the producers lose four `null`s: about the same
line count. Worth it for the deleted filter and range check, with the crash
conformance replays (`src/test-kernel/support/crashConformance.ts`, which
prints `cause/trigger`) run in full.

Landed (2026-11-26 evening): a union on `cause` (a compaction's `trigger`,
`range` and `usage`; an edit's `range`; a fork's `input`, and no range),
with the `from <= to` check on the range itself. `context.edit` is at
version 2; the golden store's three rows and its `stored_kind` entry were
rewritten by hand to the new encoding (the fork seeds lose their null
`trigger`, `0..0` range and null `usage`), not regenerated. The crash
replays print a compaction as `compaction/<trigger>` and the other causes
by name.

## 3. An installed plugin spells git-or-local as optionals

`InstalledPluginSchema`
(`packages/harness/src/shared/schemas/installedPlugin.ts`): an absent
`commit` is the hidden "local" case, `ref` means something only for git, and
a local record stores its path twice (`source` and `path`). Five readers
test `commit === undefined`
(`packages/harness/src/common/plugins/installedPlugins.ts`,
`packages/harness/src/common/plugins/pluginTrust.ts`,
`packages/cli/src/commands/plugin.ts`, `packages/texra/src/ui/copy/plugins.ts`).

Proposed: `origin: { kind: 'local' } | { kind: 'git'; url; ref?; commit }`
beside `path`.

Held back: the record is the stored `plugins.installed` global value, which
has no version; an existing install record would fail its decode and the
user's installed plugins would stop loading. Needs the owner's word that
this is acceptable before 1.0.

## 4. `/status` copies run facts field by field

`CliSessionStatusInput` (`packages/cli/src/chat/tui/sessionStatus.ts`) has
thirteen fields and one producer
(`packages/cli/src/chat/tui/commands/handlers/sessionCommands.ts`) that
names all of them; `statusLabel`, `activeChildSessions`,
`queuedFollowUpMessages` and `cost` come straight off the run, as
`buildStatusBarDisplay` already reads them.

Proposed: `formatCliSessionStatus(view, run, { ... })` with only what the
view does not hold.

Held back for size: the design harness (`packages/cli/scripts/tui-harness.tsx`)
calls it too.

## 5. Waiting on the open PRs

- `StateSettingUpdateResult`
  (`packages/texra/src/controllers/settingsView/stateSettingWrite.ts`) has
  six kinds for three outcomes (applied, a notice, an alert) and copies the
  `entry` its caller passed into five of them. Its readers
  (`packages/texra/src/controllers/settingsView/settingsViewBody.ts`,
  `packages/cli/src/chat/tui/forms/CliConfigForm.tsx`) are being rewritten.
- `dumbTerminalOptions.commandName`
  (`packages/cli/src/runtime/terminal/terminalRequirements.ts`) is the last
  optional copy of the command name, with a `'texra'` fallback
  `texra-local chat` reaches; its callers are in the open PRs.
  **Landed 2026-11-26 evening:** `interactiveTerminalRejection` takes the
  command name from the invocation's `CliContext`.
- `attachDroppedFiles`
  (`packages/texra/src/controllers/mainView/MainViewDroppedFilesController.ts`)
  returns `attachedCount` beside the `paths` it counts. (2026-11-25
  evening: its single-caller helper `attachDroppedPaths` is inlined; the
  field waits on its reader, `openGuiWindow.ts`.) **Landed 2026-11-26
  evening:** the field is gone; the window counts `paths`.
- `allocateConversationPanelRows` (`packages/cli/src/chat/tui/appLayout.ts`)
  returns four row counts where a panel kind and its rows would do.
- `RegisterRunOptions.takesFollowUps`
  (`packages/harness/src/shared/session/runFacts.ts`) is optional though
  both callers set it. Landed (2026-11-26 evening), corrected: the
  registrations launch sites hand `executeAgent` (`rootLaunch.ts`,
  `startChildRun`) never set it and `executeAgent` overrode it, so the
  field is required, `registrationRows` drops its `?? false`, and the
  fresh registration's type leaves the field out.

- A retry decision's `credentials`
  (`packages/harness/src/shared/schemas/request.ts`) still accepts
  `'configured'`, which no producer writes and the reader treats as absent.
  Dropping the literal makes a stored row that holds it fail its decode, so
  it goes with the next `request.decided` version bump, not alone: a bump
  also means regenerating the golden store
  (`src/test-kernel/fixtures/storage/golden-1.0.sql`).

## 6. Checked and refused

`PluginActionMessage`
(`packages/texra/src/shared/settingsView/pluginMessages.ts`) is six actions
beside a `name` only four of them use, and its handler rebuilds the split.
A union of the two kinds was written and dropped: every member of the
settings view's inbound union is a struct with one `command` literal, which
the desktop reads to list the commands
(`packages/desktop/src/main/desktopSettingsIpc.ts`); a member that is itself
a union, or one command in two members, moves the special case there.

`ConfirmCardHintOptions.grant`
(`packages/cli/src/chat/tui/modals/ConfirmCardState.ts`) is optional and
nullable, but making it required passes a grant to the plan and retry
cards; whether one can be offered there was not established.

## Still open from earlier notes

The `toolUse` log payload with no producer outside the design harnesses and
`RunRows.grants` (`2026-11-23-data-shapes-left-open.md`; the first now
waits on the open PRs, which touch its schema files); `WorkbenchTab` as a
union on `kind`, `ExecResult.success`
(`2026-11-20-data-shapes-left-open.md`); `ToolFileAttachment`'s three
payload fields (`2026-11-18-data-shapes-left-open.md`).
