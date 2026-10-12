/**
 * The chat's run boundary over its `Session`, here or in the TeXRA service:
 * a launch or resume is admitted by the session, which says when the run
 * ends; the chat holds its turn until then. The view folded here could
 * still show the run's previous end right after a resume.
 */
import { Effect } from 'effect';

import type {
  ResumeRunOptions,
  ResumeRunResult,
  RootLaunch,
  RunEndResult,
} from '@agent/runtime';
import type { ProcessServices, Session, SessionOwner } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/** A resume's answer: the run's, or the session's refusal in its own
 *  words (a run held elsewhere names its holder). */
type ChatResumeResult =
  | ResumeRunResult
  | {
      readonly failed: Extract<ResumeRunResult, { failed: unknown }>['failed'];
      readonly message: string;
    };

/** The run boundary `ChatSessionController` takes. */
export interface ChatAgentRuns {
  /** A root launch on the chat's session. */
  readonly launch: (
    launch: RootLaunch,
  ) => Effect.Effect<Pick<RunEndResult, 'outcome'>, Error, SessionOwner>;
  readonly resume: (
    runId: RunId,
    options: Pick<ResumeRunOptions, 'onAdmitted'>,
  ) => Effect.Effect<ChatResumeResult, Error, ProcessServices>;
  /** Resume a run beside the chat (a document task), which the chat does
   *  not adopt; it fails with the session's refusal, in its words. */
  readonly resumeBeside: (runId: RunId) => Effect.Effect<void, Error>;
}

/** The chat's run boundary over `session`; each launch asks for the
 *  approval its options carry (`launchApproval`). */
export function sessionAgentRuns(session: Session): ChatAgentRuns {
  const resume = (runId: RunId) => session.resume(runId, { interactive: true });
  return {
    launch: ({ request, options }) =>
      Effect.gen(function* () {
        const run = yield* session.start({
          config: request.config,
          runId: request.runId,
          continues: options.continues,
          approval: {
            policy: options.approvalPolicy,
            delegated: options.approveDelegatedWork,
          },
          interactive: true,
        });
        yield* options.onAdmitted?.(run.runId) ?? Effect.void;
        return yield* run.result;
      }),
    resumeBeside: (runId) =>
      resume(runId).pipe(
        Effect.asVoid,
        Effect.mapError((refusal) => new Error(refusal.message)),
      ),
    resume: (runId, options) =>
      resume(runId).pipe(
        Effect.flatMap((run) =>
          (options.onAdmitted?.(run.runId) ?? Effect.void).pipe(
            Effect.as<ResumeRunResult>({
              started: true,
              delivered: true,
              completion: run.result,
            }),
          ),
        ),
        // A refusal is the resume's answer, not a failure: the chat says it
        // in the session's words and exits as a usage error. One waiting for
        // what blocks it resumes once that is back.
        Effect.catchTag('ResumeRefused', (refusal) =>
          Effect.succeed<ChatResumeResult>({
            failed: refusal.reason,
            message: refusal.message,
          }),
        ),
      ),
  };
}
