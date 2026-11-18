# Data shapes the 2026-11-18 audit verified and did not land

Date: 2026-11-18
Status: proposed
Origin: the 2026-11-18 scheduled data-structure audit, read on `main` at
`a90f320`. Its PR landed seven shapes: an optional field always set, or a
field restating another on the same record (model availability, the plugin
switch, a registration's parent edge, the delegation approval record, a tool
row's status flags, the missing-agent banner, the CLI form's copyable
message). The findings below were checked against their producers and
readers and held back, each for the reason given, in the order worth
taking.

## 1. `run.position`: `outcome` has no reader, `turn` is never absent

`RunPositionPayload` (`packages/harness/src/shared/schemas/runHistoryEvent.ts`)
requires `outcome` exactly on `turn.end` rows through a filter, and
`positionRow` (`packages/harness/src/agent/runtime/loop/rows.ts`) fakes that
union with overloads. No source reads `payload.outcome`. `turn` is always
written from `state.turn`, yet its readers coalesce it.

Proposed: drop `outcome` and its filter; make `turn` required.

`turn` is required now (the `claude/sweep-2026-11-18-stored-shapes-once`
branch). It needed no row version bump: every `run.position` at v6 was
written with its turn. Still open: `outcome`. Dropping it changes the one
`positionRow` caller in `runLoop.ts` (`turn.end`), and bumps `run.position`,
since an earlier build's filter requires it on every `turn.end`.

## 2. `run.start.approvalPolicy` and `worktree` are optional and nullable

`packages/harness/src/shared/schemas/sessionEvent.ts`. The one producer
(`registrationDrafts`, `packages/harness/src/shared/session/runFacts.ts`)
always writes the grants and writes `worktree` as a value or absent, never
`null`; the three grant readers each restate `?? NO_APPROVAL_GRANTS`. The
field holds grants, not a policy.

Proposed: required `grants`, and `worktree: NullOr(...)` required.

Both fields are required now, `worktree` as `NullOr`, and the
`?? NO_APPROVAL_GRANTS` restatements are gone (`run.start` v5, same
branch). Still open: the stored key is `approvalPolicy`, not `grants`;
`packages/cli/scripts/validate-run.mjs` reads `$.approvalPolicy.limit`
from the row, so the rename lands with that script's edit and another
`run.start` bump.

## 3. `ToolFileAttachment`'s payload is three optional fields

`packages/harness/src/shared/schemas/toolResult.ts`: `base64Data`, `bytes`
and `digest` are read in that order by one reader (`captureAttachments`,
`packages/harness/src/agent/runtime/run/mediaInput.ts`); only `digest` has a
producer in the repo (`ScriptTool.ts`).

Proposed: `content?: { kind: 'inline'; base64 } | { kind: 'stored'; digest }`.

Held back: the type is on the plugin surface (`@texra-ai/harness/plugins`);
an outside plugin may set the inline fields. Needs a decision on that API.

## 4. Stored external-inquiry turns spell "none" three ways

`packages/texra/src/shared/plugins/externalInquiry.ts`: `context`,
`suggestSearch`, `attachFiles` and `sessionLinks` are
`optional(NullOr(...))`; no producer writes `null`, and every reader in
`ExternalInquiryPanel.ts` guards all three spellings.

Proposed: `suggestSearch: boolean`, the lists as arrays defaulting to `[]`,
`context` optional.

Done on the same branch. The global store's families carry no version of
their own (a record that fails to decode fails the read), so the turn
schema decodes the flags an earlier record left absent as `false` or `[]`,
and the writer states them.

## 5. Smaller

- `FollowUpMessage.displayText` and `ChildRunDelivery.usage`
  (`packages/harness/src/shared/schemas/followUp.ts`): done on the same
  branch (`followup.queued` v10). The claim was half true: the agent-CLI
  driver did write `usage: null`; it now leaves the field out.
- `SubscriptionAuthStatus` (`packages/texra/src/shared/model/subscriptionAuthStatus.ts`)
  makes `email` and `accountId` nullable while copying a session whose
  fields never are; the account labels in `SubscriptionSection.ts` accept
  both spellings.
- The desktop terminal's `heldInput`, `started` and `exited`
  (`packages/desktop/src/renderer/terminalPane.ts`) are one shell state;
  input typed after the shell exits still reaches `sendInput`. Recently
  changed (#15026), so let it settle first.

## 6. More of the same, found on the sweep branch

Landed beside the findings above, none needing a row version bump since
no stored row at the current versions holds `null` there:
`RetryRequest.credentialSwitch` (a required `NullOr`), `run.config.binding`,
a `model.message` append's `input` and `reason`, and a `context.edit`'s
`input` (plain optional).

Still open: `rootUserInstruction` and the nullable optionals of
`AgentConfigSchema` (`packages/harness/src/shared/schemas/agentConfig.ts`),
which `BaseProposalFieldsSchema` and `AgentProposalSchema` restate on
`request.opened` (`proposalFields.ts`, `requestPayloads.ts`): check each
producer, then bump `run.config` and `request.opened` once.
