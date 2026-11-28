# Agent SDK readiness: what the 2026-11-28 audit landed, and what it left

Date: 2026-11-28
Status: proposed (one owner-use consolidation landed with this note; the rest
are claimed by a concurrent PR, owner-gated, or a behavior change, recorded so
the theme is not re-mined)

Origin: the scheduled review of the harness for Agent SDK readiness — the agent
core, the model handler, the logger and the public host surface — looking for
unnecessary abstractions, wrapper layers, pass-through indirection,
single-caller helpers, re-export shims, redundant interfaces and dual
representations of one fact, and for logical units that could run as
independent agents. Read against `main` at `5b7f63e`, continuing the six prior
agent-SDK-readiness notes
([2026-11-20](2026-11-20-agent-sdk-readiness-audit.md),
[2026-11-21](2026-11-21-agent-sdk-readiness-shallow-indirection.md),
[2026-11-23](2026-11-23-agent-sdk-readiness-left-open.md),
[2026-11-24](2026-11-24-agent-sdk-readiness-left-open.md),
[2026-11-25](2026-11-25-agent-sdk-readiness-left-open.md),
[2026-11-27](2026-11-27-declarations-with-no-consumer.md))
and picking up the two items the 2026-11-27 dead-surface scan
([2026-11-27](2026-11-27-dead-and-unread-surface-scan.md), "Open: blocked by an
open PR") had queued for "fix once it lands."

## Headline

The SDK surface stays well-aligned, for the seventh run running. Every forbidden
import edge is zero, the run loop is one program with one publisher, no shallow
presenter or re-encoding wrapper survives in the host surface, and the
dead-export and re-derived-fact scans are a verified negative. There is no large
mechanical or structural consolidation left in this area.

Six other audits opened PRs the same morning (#15278–#15283), so the tree was
being swept in parallel. One of this run's two queued items — the throwing
settings-view row owner — was landed by the concurrent #15283 ("one throwing
lookup for a settings-view row", the same `TEXRA_SETTINGS.settingsViewRow`), so
this run dropped it rather than collide. The other item was unclaimed and landed
here.

## Landed with this note

**One owner for the described, trimmed, non-empty string tool-input field.**
`inputSchema.ts` (`packages/harness/src/tools/core/`) is the declared home for
shared tool-input field spellings (`optionalInput`, `nullishWithDefault`,
`timeoutMsField`); its public members (`optionalInput`, `nullishWithDefault`)
are re-exported from `@texra-ai/worldline/plugins`, where `describedString` now
joins them. The shape "a
string the model must fill, described on the encoded side, trimmed and rejected
when empty" was written out twice, verbatim down to the comment — once as
`DiagnosticsPathSchema` (`DiagnosticsTool.ts`) and once as the `add` command's
`path` (`comment/InlineCommentTool.ts`):
`Schema.String.annotate({ description }).pipe(Schema.decodeTo(Schema.Trim.check(Schema.isMinLength(1))))`.
A new `describedString(description)` owns that spelling; both tools call it. The
decoded type (`string`), the model's JSON Schema (a described string) and the
trim/non-empty decode are identical — behavior-preserving. The new public export
regenerates `config/api-reports/harness.plugins.api.md` and
`packages/harness/docs/api/plugins.md`.

## Claimed by a concurrent PR

**The throwing settings-view row owner.** `settingsViewByKey(key)`
(`shared/settings/texraSettings.ts`) returns `undefined`, and two readers each
threw the same `No settings-view catalog row for setting "${key}"` after it
(`placedRow`, `signalFor`). #15283 lands exactly this as
`TEXRA_SETTINGS.settingsViewRow`. This run committed and then reverted it (a
revert rather than a history rewrite because force-push is restricted in the
scheduled environment); recorded so an eighth run does not re-raise it.

## Open: owner-gated design decisions

Neither can land in a scheduled run; each is a design decision the owner owns.

1. **`ApprovalPolicyLimit` is a one-member enum, but not a plain boolean.**
   After #15253 removed the Block/`never` policy, `ApprovalPolicyLimitSchema`
   (`shared/approvalBypassKind.ts`) is `Schema.Literal('ask')`, and
   `ApprovalGrants.limit` is `Schema.optional(ApprovalPolicyLimitSchema)` —
   `'ask' | undefined`, a two-state field. The matching command field
   (`RuntimeCommandSchema` `policy.set`/`field: 'limit'`,
   `shared/session/runtimeRequest.ts`) is `limit: ApprovalPolicyLimitSchema`,
   also the one-member enum, and its only issuer (`runChatTui.tsx:303`) always
   sends `'ask'`. The owner-rule reading is "collapse the constant column to the
   boolean it is." **But it is not a free collapse.** `runPolicy`
   (`approvalBypassKind.ts`) returns `limit ?? project`, reusing `'ask'` as both
   the narrow marker _and_ the resulting `ApprovalPolicy` value, so
   `ApprovalPolicyLimit` is a (currently degenerate) subset of `ApprovalPolicy`:
   "the policy a launch may narrow a run to." A boolean would forfeit the ability
   to narrow to any policy other than Ask should one below it return. So this is a
   genuine design question — keep the subset-of-policy type for extensibility, or
   collapse to boolean — and a wire change on top: it bumps the `approval.policy`
   row version (currently 2) and rewrites the `policy.set` command protocol
   across the harness, the CLI and the app. It belongs to the owner before the
   1.0 format freeze, under "Needs your eye" in its own PR, not a scheduled land.
   ~5 files. (Carried and sharpened from the 2026-11-27 dead-surface scan item 4,
   which rated it a boolean; the `runPolicy` reuse makes "boolean" the question,
   not the answer.)

2. **The two body-side trims are a behavior change, not a refactor.**
   `OpenPdfTool.ts` (`path: Schema.String`, then `input.path.trim()` and a
   `'path is required.'` `ToolError`) and `SendToTerminalTool.ts`
   (`input.command.trim()`, `input.label.trim()`) normalize in `execute`, not in
   the schema. The owner-rule ("errors defined out of existence by the shape of
   an operation") favors moving the trim and non-empty into the schema — which
   `describedString` now makes a one-liner for `OpenPdfTool.path`. But it changes
   observable behavior: an empty path becomes a decode error the model retries
   instead of a `ToolError`, and the JSON Schema gains a `minLength`.
   `SendToTerminalTool` is not even a clean instance: `command` carries a
   newline-guard check and `label` carries a default, so neither is the generic
   described-string shape. Left for a deliberate behavior change, not folded into
   a behavior-preserving sweep.

## Verified dead-ends (recorded so a later run does not re-chase them)

- **The per-tool `path` / `file` fields** (`ReadTool`, `EditTool`, `WriteTool`,
  `lean/LspTools`, the agent-CLI `prompt` fields) are plain `Schema.String` with
  tool-specific descriptions ("to read", "to edit", "to write"). Each describes
  its own parameter; they are not one fact spelled many times, and they do not
  want the trim/non-empty decode. Not a `describedString` consolidation.
- **`PathFieldSchema`** (`tools/executions/toolInput.ts`) is the `/executions`
  virtual-path field ("Path starting with /executions"), a different fact from a
  filesystem path. Not a shared owner being bypassed.

## Subagent boundaries

Unchanged from the six prior runs: a run is already the independent-agent unit
(`executeAgent` / `launchProcessChild`), delegation launches children through
`childLaunch.ts`, and a plugin program is a run on a generated script. No new
split is proposed; a second orchestration layer beside the run loop is the shape
the design doc rules out ("no flow engine").

## Verified

- Read `main` at `5b7f63e`. The `describedString` swap is type- and
  schema-identical; no persisted, wire or digest change. `npm run docgen`
  regenerates the `harness.plugins` API report with one added export
  (`describedString`); no other public surface moves.
- `npm run gate` passed (lint and invariants with the API reports, docs,
  typecheck + format across 8 projects with the harness declaration build,
  Effect diagnostics clean).
- `npm run test:changed`: 151 files, 436 passed, 1 skipped (run before the
  settings-view commit was reverted; the surviving change touches a strict
  subset of those files).
- Not run: the full `npm test` crash replays, a live model, the desktop and VS
  Code e2e.
