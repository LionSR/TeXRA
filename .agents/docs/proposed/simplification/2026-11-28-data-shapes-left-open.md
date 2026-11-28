# Data shapes the 2026-11-28 audit verified and did not land

Date: 2026-11-28
Status: proposed
Origin: the 2026-11-28 scheduled data-structure audit, read on `main` at
`5b7f63e`. Its PR lists what landed, including items 1 and 3 of
`2026-11-27-data-shapes-left-open.md` (the model verdict's `usageRoute` and
`TexraDiffView.fill`), which the PRs they waited on had merged. The findings
below were checked against their producers and readers and held back, each
for the reason given.

## 1. The JSON-RPC connection has two options no caller sets

`JsonRpcConnectionOptions.onRequest` and `.cancel`
(`packages/harness/src/tools/jsonRpc.ts`) have no producer: the Lean server
(`packages/texra/src/tools/lean/direct/leanServer.ts`) and the connection's
suite set neither. So the branch that answers a peer's request is dead
(every one gets method-not-found), and an interrupted call sends the peer
no notice. `JsonRpcProcessOptions.onStderr` is optional though its one
producer sets it.

Proposed: delete both options with their branches and make `onStderr`
required, about 30 lines in one file and the plugin API report.

Held back: it needs a decision.
`2026-11-20-effect-modules-audit-left-open.md` calls Lean's missing
`$/cancelRequest` a behavior gap, so `cancel` may be the hook to wire in
`leanServer.ts`, not delete. The type is on the plugin surface.

## 2. `SkillSourceOptions` is a one-field bag carried through three optional layers

`packages/harness/src/skills/skillSources.ts`: `{ additionalPaths? }`, held
as `HostSkillOptions.skillSourceOptions?`, as `SkillSourceCall.options` and
as `options?` parameters in `packages/harness/src/skills/runtimeSkills.ts`,
so "no extra paths" is an absent bag, `{}`, an absent field or `[]`. The CLI
(`packages/cli/src/runtime/platform/cliContext.ts`) always produces an
array.

Proposed: a required `additionalSkillPaths: readonly string[]` on the
context and the call. About 35 lines in about 11 files.

Held back: `SkillSourceOptions` is exported from the package's main entry
and `HostSkillOptions` is a host port; an embedder may pass the bag. Needs
the owner's word, and should not be taken if a second skill-source option
is planned.

## 3. `ExecuteCommandBaseOptions.buffer` restates "this caller streams"

`packages/harness/src/utils/system/execUtils.ts`: the only value written is
`false`, at the two `packages/harness/src/tools/bash.ts` calls that also
pass `onStdout` and `onStderr`, and no caller passes a callback while
retaining output.

Not taken: dropping the flag makes "a callback means nothing is retained" an
implicit rule of a public option, where today both halves are stated. Worth
it only if a caller that wants both is ruled out.

## 4. `PlanUsageSchema` writes known and unknown quota as optionals

`packages/texra/src/shared/session/hostSnapshot.ts`: the one producer
(`packages/texra/src/controllers/session/hostSnapshotSource.ts`) writes
`{ plan, planName?, at, windows }` or `{ plan, windows: [], unknown }`;
`at` and `unknown` never occur together.

Held back: `2026-11-27-responsibility-audit-left-open.md` item 2 proposes
one record for `PlanUsage` and `SubscriptionUsageSnapshot`, whose schema is
already the union. Take this inside that change.

## 5. `RunEnding.report` spells "nothing to report" as null or absent

`packages/harness/src/agent/storage/runLifecycle.ts`: three producers pass
a delivery or `null`; a stop and four test call sites omit it; the one
reader tests `== null`.

Not taken: making it required adds `report: null` at five sites to delete
one `?`.

## 6. `WORKBENCH_KIND_META.singleton` guards a case no caller reaches

`packages/desktop/src/shared/desktopShellState.ts`: `openWorkbenchTab` reads
`meta.singleton || !target`, and no caller passes a target with a singleton
kind, so the column decides nothing today.

Held back: it belongs with `WorkbenchTab` as a union on `kind`
(`2026-11-20-data-shapes-left-open.md` item 4), which makes the guard a
type.

## 7. Checked and refused

- `ConversationFormatOptions`
  (`packages/harness/src/shared/transcript/conversationFormat.ts`): two
  pairs of its five options always travel together, but it is a documented
  host export with two callers that differ.
- `ModelAccessPreferenceOutcome`'s `'enabled' | 'disabled'`
  (`packages/texra/src/controllers/modelAccess/modelAccessPreference.ts`)
  equals the caller's argument, but the CLI switches on the literal.
- `HostCommand` `toolEdit.grant`
  (`packages/texra/src/shared/session/hostRequest.ts`) means something only
  for an approval, but its handler takes the three fields whole; a union
  adds lines.
- `SubscriptionSessionStatus`
  (`packages/llm/src/oauth/subscriptionCoordinator.ts`): a signed-in union
  would reach the app's wire schema and about fifteen `.signedIn` readers.
- `ToolEditApprovalResult.lineChanges?` and `.startLine?`
  (`packages/harness/src/tools/approval/toolEditApproval.ts`): the one
  producer sets both, but no reader branch goes and the type is public.
- `Dispatch.pluginOf`
  (`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`) is
  derivable from the step's offered tools, but it is an index built once
  and read per call.
- `SessionMeta.approvalPolicy`
  (`packages/cli/src/chat/tui/state/cliState.ts`) is a copy kept in step
  at three sites, but it is what makes the status bar repaint: the
  project's policy is not a signal.

## Still open from earlier notes

`2026-11-25-data-shapes-left-open.md` items 1 and 3 (each needs the owner's
word) and the retry decision's `'configured'` literal; `RunRows.grants` and
the `toolUse` log payload (`2026-11-23-data-shapes-left-open.md`);
`WorkbenchTab` as a union on `kind` and `ExecResult.success`
(`2026-11-20-data-shapes-left-open.md`); `ToolFileAttachment`'s three
payload fields (`2026-11-18-data-shapes-left-open.md`);
`2026-11-27-data-shapes-left-open.md` item 2.
