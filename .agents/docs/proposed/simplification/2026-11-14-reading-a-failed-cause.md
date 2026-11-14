# Reading a failed cause: one owner per reading

Date: 2026-11-14
Status: proposed
Origin: the harvest of earlier scheduled audits (the 2026-11-09 code-debt
report and the "left undone" sections of merged PRs), re-checked on `main` at
`4b8f417`.

## The problem

A caller that catches a `Cause` wants one of three readings of it: a sentence
for a person, a payload for the log, or a decision about what the run does
next. Each was written out at the catch site. About a hundred sites called
`Cause.squash` themselves, some twice for one cause, and five sites in the
harness spell the interrupt / storage rejection / defect / typed error split
by hand.

## Done in the PR that adds this note

- **The sentence.** `toErrorMessage` and `ensureError`
  (`packages/harness/src/utils/errors/errorMessage.ts`) take the `Cause`
  itself; `causeChain` starts from the error the cause raised.
- **The log payload.** `formatLogData`
  (`packages/harness/src/logger/formatLogData.ts`) renders a `Cause`, as the
  payload or as a field, as the error it raised, so
  `Effect.annotateLogs({ data: cause })` is the whole producer side.

Sixty-odd call sites lost their own `Cause.squash`. The ones left hand the
squashed error to code that branches on its class, which is a decision and
not a rendering.

## Open, each needing a decision

1. **The decision reading.** `ModelInvoker.ts` (the stream exit and the
   attempt exit), `loop/toolUseDispatch.ts`, `tools/core/definition.ts` and
   `run/compaction.ts` under `packages/harness/src` each sort a cause into
   interrupt, storage rejection, defect or typed error. They are not
   identical: the attempt exit in `ModelInvoker.ts` never asks
   `findStorageRefusal`, and `definition.ts` re-fails the cause where the
   others end the run. One classifier beside `findStorageRefusal`
   (`packages/harness/src/shared/session/runHistory.ts`) would own the order
   of the four questions; before writing it, decide whether the attempt
   exit's missing storage check is intended. The eleven `hasInterruptsOnly`
   reads that disagree with the cause-to-outcome mapping on a mixed cause
   (noted in #14307) are the same decision.
2. **The trace payload.** `AgentTrace` rows take `data` through
   `toJsonValue`, not `formatLogData`, so six trace calls
   (`run/compaction.ts`, `run/backgroundTurn.ts`,
   `packages/texra/src/tools/documents/documentState.ts`) still squash.
   Either the trace encoder reads a `Cause` the same way or those rows carry
   the message only.

## Other harvested findings left for a decision

These came out of the same harvest, are still true, and change behavior or
wording, so they were not folded into a refactor:

- Signing out from the settings view leaves the subscription preference on;
  `texra logout` turns it off
  (`packages/texra/src/controllers/settingsView/settingsViewBody.ts`,
  `packages/cli/src/runtime/models/subscriptionLogin.ts`). The provider's
  `signOut` should own the preference write, as its `signIn` does since
  #14907; the CLI then reports a preference failure as an error, not a note.
- The extension's onboarding "Sign in with ChatGPT"
  (`packages/extension/src/progressView/extensionHostRequests.ts`) bypasses
  the settings body's sign-in and its change notices.
- A setup-assistant launch failure has one policy per GUI host
  (`packages/texra/src/controllers/onboarding/setupLaunch.ts`,
  `packages/extension/src/commands/setup/setupAssistantCommand.ts`).
- The three Unicode-to-LaTeX tables under `packages/texra/src/replacement/`
  and the 61 `HARNESS_*` switches of `packages/cli/scripts/tui-harness.tsx`
  (code-debt report, 2026-11-09).
