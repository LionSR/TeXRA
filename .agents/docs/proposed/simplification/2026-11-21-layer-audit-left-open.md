# Logic in the wrong layer: what the 2026-11-21 audit left open

Date: 2026-11-21
Status: proposed
Origin: a scheduled audit for abstraction-layer violations, on `main` at
`362ab86`. Three read-only passes covered host packages that hold app rules,
renderers that compute run facts, and misplacement between `packages/llm`,
the harness and the app. Each candidate was checked against the code,
`.agents/docs/refuted-candidates.json`, the open PRs (#15130, #15132) and the
other notes in this directory.

The PR that adds this note lands five findings:

- llm states how each subscription plan reports its quota
  (`PLAN_QUOTA_SOURCES`, `packages/llm/src/providers/planUsage.ts`) and
  builds an endpoint plan's request from its route and region. The harness's
  `QUOTA_SOURCES` table, its GLM-only region read and the `PlanUsageRequest`
  export are gone; `PlanQuotas` reads the plan's region the general way
  (`providerRegionSetting`).
- The skill-list toggle and the wording of a setting write that did not land
  are decided once, in `stateSettingWrite.ts` (`setSkillEnabled`,
  `settingWriteFailure`). The TUI's `/config` skills list now writes over the
  list as stored, not as it was when the form opened, and every surface shows
  the same sentence for a rejected, failed or workspace-required write.
- The TUI follows `approvalPolicyChanged` as the GUI hosts do, so the
  `onProjectApprovalPolicyChanged` callback, its props and the `/config`
  special case for the approval-policy key are gone.
- Renderers read what the view states: the attached-task tree reads
  `descendantRuns`, and a stage with no label is named by its id in the
  updater (`applyStage`), not in one renderer.
- Four harness strings a model or a person reads no longer carry the app's
  vocabulary (`.bib`/`.sty`, `"tex"`, research bibliographies, the helper
  model's polishing and merges).

What follows is left open, in the order worth taking.

## 1. A provider's API-key shapes live in the harness logger

`PROVIDER_KEY_PATTERNS_BY_PROVIDER` (`packages/harness/src/logger/redaction.ts`)
is a provider fact, pinned to llm's provider list by `satisfies`. The TUI
restates a subset of the prefixes (`hasConcatenatedCredentialPrefix`,
`packages/cli/src/chat/tui/commands/slashRegistry.ts`, without Google's
`AQ.` keys), and the live-cassette check (`packages/llm/test-live/cassette.ts`)
a third. The owner is a plain-data table in `packages/llm/src/providers/`
keyed by `ApiKeyProviderId`. Left for now because the logger is imported by
browser-reachable modules: the move needs the table to stay in a module the
settings webview may import (plain data, like `providerPlugins.ts`), and
`providerPlugins.ts` is being edited by #15132.

## 2. Which setting switches each plan on has three owners

`PREFER_SUBSCRIPTION` (`packages/harness/src/model/subscriptionAccess.ts`)
covers the session plans, `readModelSettings` reads the two coding-plan
switches by name, and `codingPlans.ts` names them again with a hand-written
`exclusiveCredential` column that follows from the llm manifest's `kind`. One
harness table keyed by `PlanRoute` beside `SUBSCRIPTION_ROUTES` would own it.
Decision needed first: the session switches live in `config` and the
coding-plan ones in `globalState`.

## 3. The TUI re-checks model access through a hand-passed callback

`onAccountChanged` (`slashContext.ts`) is called by hand at three sites in
`modelAccessContribution.tsx`; the `/config` → API keys save never calls it,
so a chat waiting on "Connect a model" stays blocked after a key is saved
there, although the write emits `credentialChanged`. Following the same
`credentialChanged`/`modelAccessChanged` stream the status bar follows would
fix the missing case and delete the callback. Needs a check that every
sign-in and sign-out path emits one of the two signals.

## 4. The task list shows the agent name, not the task's title

Landed: `TaskSummary.label` is the run's `title` and the unread
`description` is gone; the protocol digest changes with the shape.

`TaskSummary` (`packages/texra/src/controllers/server/protocol.ts`) carries
`label` and a `description` nobody reads; `texra tasks list` and `/tasks`
print `label` (the agent) where the web and `/resume` show `run.title`. It is
a service wire shape between builds, so the field change needs the protocol's
version rule.

## 5. `texra models show` rewords why a model cannot run

Landed: `ModelOptionData` carries `unavailableReason`, which
`texra models show` prints as its `reason:` line; `formatCliModelRecovery`
is gone, and only the shell's `texra setup` pointer for a missing key stays
the terminal's.

`ModelVerdict.unavailableReason` (`packages/harness/src/model/computeModelOptions.ts`)
is dropped by `ModelOptionData`, so `formatCliModelRecovery`
(`packages/cli/src/runtime/models/modelAccess.ts`) words each kind again, and
the copies have drifted (unserved, unreadable key, unknown model).

## 6. Smaller single-owner moves

- Landed: `finishedToolCalls` in the CLI's headless renderer counted a run's
  finished tool cards for the status line and the TUI's child list; the
  session view now carries the count (`RunView.toolCalls`). The two wordings
  ("tools: 5", "5 tool calls") stay.
- Landed: the usage-logging notice (`telemetryNoticeIfDue`) did not read the
  host telemetry switch the send gate reads, so the extension checked it at
  the call site (`extension.ts`). The switch is now one `Context.Reference`
  (`HostTelemetrySwitch`) the extension provides and both read.
- "Can Codex run this model" (`agentCliSettings.ts`) restates llm's private
  `codexSubscriptionOf`.
- The model enable list is projected twice (`enabledModels.ts` in the CLI,
  `modelSelection.ts` in settings), with different membership, provider key
  and order. Decision needed: are unserved models listed.

## Checked and left alone

- The desktop and extension settings surfaces: their write path, key actions
  and command catalog already have one owner.
- Renderers stamping `Date.now()`: the one site
  (`packages/cli/src/chat/tui/state/transcript.ts`) dates a local notice when
  it is written, which is its own fact.
