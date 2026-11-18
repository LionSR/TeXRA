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

Held back: a `run.position` row version bump (rows from earlier builds may
lack `turn`).

## 2. `run.start.approvalPolicy` and `worktree` are optional and nullable

`packages/harness/src/shared/schemas/sessionEvent.ts`. The one producer
(`registrationDrafts`, `packages/harness/src/shared/session/runFacts.ts`)
always writes the grants and writes `worktree` as a value or absent, never
`null`; the three grant readers each restate `?? NO_APPROVAL_GRANTS`. The
field holds grants, not a policy.

Proposed: required `grants`, and `worktree: NullOr(...)` required.

Held back: a `run.start` row version bump. Take it with finding 1 so the
run rows change once.

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

Held back: persisted in the global store (`external-inquiry/thread`);
changing what is written needs its own commit with the store's checks.

## 5. Smaller

- `FollowUpMessage.displayText` and `ChildRunDelivery.usage`
  (`packages/harness/src/shared/schemas/followUp.ts`) are nullable though no
  producer writes `null`; take them with the next `followup.queued` change.
- `SubscriptionAuthStatus` (`packages/texra/src/shared/model/subscriptionAuthStatus.ts`)
  makes `email` and `accountId` nullable while copying a session whose
  fields never are; the account labels in `SubscriptionSection.ts` accept
  both spellings.
- The desktop terminal's `heldInput`, `started` and `exited`
  (`packages/desktop/src/renderer/terminalPane.ts`) are one shell state;
  input typed after the shell exits still reaches `sendInput`. Recently
  changed (#15026), so let it settle first.
