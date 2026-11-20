# Agent runtime and model access: what the 2026-11-20 pass left open

Date: 2026-11-20
Status: proposed
Origin: a find-simplification pass over `packages/harness/src/agent/runtime/`
and `packages/llm/src/`, on `main` at `56a555c`. The series that adds this
note lands four findings:

- one decision for the helper model a task runs on (`servableHelperModel`);
- a resume reads its run's facts once (`continuationOf`), closing the
  "earlier build detected twice" item of
  `2026-11-03-storage-errors-and-stop-paths.md`;
- a route's credential is its bearer and plan, not a copy of its route;
- `ChildRunsShape.requested` goes with its one consumer, the external
  inquiry tool retired in #15098.

Each item below waits on an open PR that holds its files.

## Open

1. **An `agent` child's config is decoded in each launcher.** `AgentTool`
   builds one `configPayload` from the approved proposal, and
   `launchDetachedSubagent` (`delegation/subagentRun.ts`) and
   `executeSubagentInBand` (`delegation/childLaunch.ts`) each decode it with
   `AgentConfigSchema` before `prepareAgentDefinition`. `SelfTool` decodes
   its payload itself and passes the result, which `executeSubagentInBand`
   decodes a second time. Decode once where the payload is built, and have
   both launchers take an `AgentConfig` (`config`, not `configPayload`).
   This renames the field `SelfTool.ts` passes, so it waits on #15116.
   `startChildRun`'s `tools` option, which no caller passes, goes in the
   same change.
2. **`presentFollowUpResult` only restates `status === 'failed'`.** Its four
   callers (`tools/executions/send.ts`, the CLI's `chatSessionController.ts`
   and `TasksForm.tsx`, the app's `hostRunActions.ts`) each test
   `severity !== 'none'` and read `message`, which is the failed result's.
   They can test the result itself, and the export leaves `./host`. That
   entry is being rewritten by #15120.
3. **`FollowUps.release` takes a two-word union read as a boolean**, still
   open in the storage-errors note. Its one caller is `finishRun` in
   `loop/runLoop.ts`, which #15123 edits.
4. Done 2026-11-20: `owningCall` takes the facts its callers read, and a
   resumed run's opening takes the `run.start` its resume read.

## Checked and declined

- **`effect/jose`'s `Jwt.decodeUnverified` in place of
  `decodeJwtClaimsWithSchema`** (`packages/llm/src/oauth/jwtDecode.ts`). The
  Effect function returns an Effect and parses the protected header too; its
  callers are the synchronous `buildSession` policy callback and
  `extractChatgptClaims`, so the swap would turn the sign-in policy's
  session builder into an Effect for a 10-line helper.
- **The script delivery summary's `stopped` as `cancelled`**, decided in the
  storage-errors note. It changes the word the transcript shows ("name
  stopped · …") and the stored `followup.queued` payload, so it needs a row
  version bump and a wording decision, not a refactor.
- **One launcher for an `agent` child** (`launchDetachedSubagent` and
  `executeSubagentInBand` share the prepare-and-start steps). Two call
  sites whose receipts and waits differ; after item 1 the shared part is
  about eight lines.
