---
created: 2026-06-28
---

# Sub-PRD 05: External-Inquiry Resolution Policy Into the Runtime

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

- Push the decision into `humanInputCommands` as one host-neutral command, e.g.
  `resolveRuntimeExternalInquiryDecision({ threadId, answerText, rejected,
draft, session })`, which owns the text/empty/reject branching, draft
  persistence, and the drop-vs-submit transition on the durable thread.
- The webview hosts route the `EXTERNAL_INQUIRY_ACTION` command through the
  shared progress factory (folding the special-case back in); the CLI calls the
  same command from its modal handler.
- Hosts keep only their input collection and result rendering.

## Scope

- `src/agent/runtime/humanInputCommands.ts`: the decision command (it already
  owns inquiry resolution/draft persistence; this consolidates the branch).
- Fold the webview wiring into `createProgressViewCommandHandlers`.
- Repoint extension, desktop, and CLI to the one command.

## Acceptance

- The submit/drop/empty-answer branching exists once, in `humanInputCommands`.
- No host contains the policy; all three call the command.
- A test proves empty-answer drops and non-empty submits, with the durable
  thread state asserted.

## Risk

- Medium. The CLI input path differs (TUI modal vs webview), but the decision is
  the same; keep the input collection host-specific and share only the decision.
