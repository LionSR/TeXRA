# Run end and request audit: what is left open

Date: 2026-11-15
Status: proposed

Origin: a read-only audit of `main` after #14896 and #14899, over the code
that ends a run, refuses a request and stores a child's delivery. Its defects
landed in #14944, and its smaller findings in the PR that adds this note. The
two below need a decision first.

## Open

1. **A child's delivery stores its wall time as text.**
   `ChildRunDelivery.wallTime` (`packages/harness/src/shared/schemas/followUp.ts`)
   is a formatted string (`1.2s`), and four producers format it the same way:
   `childDelivery.ts`, `delegation/bashDelivery.ts`, and the agent CLI tools'
   shared `agentCliShared.ts`. The golden-store and crash normalizers scrub it
   as text, and the envelope writes it unescaped (`deliveryEnvelope.ts`).
   - The delivery also stores its `prompt` whole, though the envelope shows
     200 characters of it.
   - Proposed: store `wallTimeMs` as a number and format it where a delivery
     is rendered (`formatDelivery`, `deliverySummary`); cut the prompt where
     the delivery is built.
   - Needs: a version bump of `followup.queued` and a regenerated golden
     store. It is cheapest before that row's current version is released,
     and it should be decided together with the delivery union in
     [tool card result and delivery shapes](./2026-11-14-tool-card-result-and-delivery-shapes.md).
2. **The desktop terminal drops what is typed before its shell starts.**
   The renderer forwards keystrokes as soon as the terminal exists
   (`packages/desktop/src/renderer/terminalPane.ts`), and asks for a shell
   only once the terminal has real geometry. The main process writes input
   with `ptyHost.get(sessionId)?.write(...)`
   (`packages/desktop/src/main/desktopWorkspaceIpc.ts`), so input that
   arrives before the session exists is dropped without a trace. The pty
   host already holds input typed while a shell is starting.
   - Seen as a failed run of the desktop e2e case "restarts an exited
     terminal in its own tab" on #14899: the typed `exit` was lost.
   - Two designs: the pane holds input until it has asked for a shell, or
     the main process keeps input for a session it has not started yet.
     The first keeps the rule in the one place that knows the terminal has
     no shell yet.
   - Needs: a run of the desktop e2e suite, which this audit could not run
     (no Electron binary in its environment).

## Checked and dropped

- "A completed child with no `run.report` makes `AgentTool` die": `endRun`
  builds a report for every run whose flow returned, a root included, so a
  completed run always has one.
