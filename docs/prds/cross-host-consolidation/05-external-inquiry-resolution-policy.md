---
created: 2026-06-28
---

# Sub-PRD 05: External-Inquiry Resolution Policy Into the Runtime

> **Re-scoped by the unified design pass (2026-06-29).** This consumes #6723's
> `mode`-bearing `ExternalInquiryPermission` discriminated union (it does not
> redefine inquiry shapes), and the empty-answer policy is **host-aware**, not
> decided by fiat - the single-owner review flagged that a blanket
> empty -> drop rule would silently flatten the webview's keep-open affordance.
> Lands after #6723. See `00-overview.md` (Two sequenced tracks).
>
> **05 stays a live standalone unit (CH-05).** The gold-standard GS-3 PendingRequests
> collapses only the inquiry _coordinator plumbing_; the host-aware empty-answer
> decision policy here is host presentation, outside the gold-standard's charter,
> and is **not** absorbed by it.

## Context

When the user answers a durable external-inquiry turn, the host decides whether
to submit or drop it. The decision policy is small and host-neutral: a draft
persists the open turn; an answer with non-empty text submits; an empty answer
or an explicit reject drops the durable thread.

## Problem

That decision is reimplemented in all three hosts, deliberately left outside the
shared `createProgressViewCommandHandlers` factory:

- Extension: `ProgressViewMessageHandler.ts:327-357`.
- Desktop: `desktopAgentExecution.ts:666-697` (near-verbatim; differs only by
  `session: this.session`; a comment cites the extension handler).
- CLI: `subscribeApprovals.ts:304-340` + `humanInputHandlers.ts:41-45`.

The policy is runtime semantics (text -> submit, empty/reject -> drop), not
presentation. Three copies mean a policy change is made three times, and the
durable-thread invariant can diverge per host.

## Design

- **Consume #6723's `mode` union; do not redefine inquiry shapes.** The
  decision command takes the discriminated `ExternalInquiryPermission`
  (`mode: 'new' | 'followUp'`) as parsed input (parse-don't-validate); it does
  not re-derive the `data.threadId ?` heuristic.
- **One verb set.** Collapse to `submit` / `drop` / `draft` (the inbound enum and
  the runtime primitive). Retire `{ answerText, rejected }` and the
  `submit/reject/skip` triplet; map `reject` and `skip` onto `drop`.
- Push the decision into `humanInputCommands` as one host-neutral command, e.g.
  `resolveRuntimeExternalInquiryDecision({ threadId, answerText, draft,
onEmpty, session })`, which owns the text -> submit / draft-persist / drop
  branching and the durable-thread transition.
- **Empty-answer policy is host-aware via an explicit `onEmpty: 'keepOpen' |
'drop'` argument**, not a runtime fiat. The webview sets `keepOpen` (its
  debounced-textarea affordance: an empty accept must not destroy the open
  turn); the CLI sets `drop` (its one-shot prompt). Delete the per-host empty
  guards, but the behavior each host had is preserved by the argument it passes.
- The `runtimeExternalInquiryPermissionFromManifest` `mode`-stamp fix is **owned
  by the second-lander of {#6697, #6723}** (the symbol is a #6697 symbol; the
  compile-break only materializes when both are in one tree), **not by 05.** 05
  _generalizes_ it: route the live emit (`ExternalInquiryTool.ts:372-384`) and
  the resume projection through **one shared `isFollowUp` / `mode` helper**.
- Hosts keep only their input collection and result rendering. **Preserve the
  CLI no-draft affordance** (the TUI modal has no debounced draft to persist).

## Scope

- `src/agent/runtime/humanInputCommands.ts`: the decision command (it already
  owns inquiry resolution/draft persistence; this consolidates the branch) plus
  the shared `isFollowUp` / `mode` helper.
- Fold the webview wiring into `createProgressViewCommandHandlers`.
- Repoint extension, desktop, and CLI to the one command, each passing its
  `onEmpty` policy.

## Acceptance

- The submit/drop/draft branching exists once, in `humanInputCommands`, over the
  single verb set; `reject`/`skip` map to `drop`.
- No host contains the policy; all three call the command.
- **The webview keep-open behavior is preserved** - an empty webview accept does
  not drop the durable thread (no silent warn-and-return -> drop flip), and the
  webview disables empty submit. A test proves each host's empty accept yields
  its declared `onEmpty` outcome (webview keeps open, CLI drops), and that a
  non-empty answer submits, with the durable thread state asserted.

## Risk

- Medium. The CLI input path differs (TUI modal vs webview), but the decision is
  the same; keep the input collection host-specific and share only the decision.
