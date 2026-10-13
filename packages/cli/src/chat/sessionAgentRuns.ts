/**
 * The chat's run boundary over its `Session`, here or in the TeXRA service:
 * a launch or resume is admitted by the session, which says when the run
 * ends; the chat holds its turn until then. The view folded here could
 * still show the run's previous end right after a resume.
 */
import { Effect } from 'effect';

import type {
  ResumeRefused,
  Run,
  RunEndResult,
  Session,
} from '@texra-ai/harness';
import type { AgentConfig, RunId } from '@texra-ai/harness/schemas';

import type { launchApproval } from '../runtime/cliContext';

/** A chat round's launch: its configuration under the id the chat minted,
 *  and the launch's facts: its approval (`launchApproval`), the round it
 *  continues, and what runs once the session admits it. */
interface ChatLaunch {
  readonly request: { readonly config: AgentConfig; readonly runId: RunId };
  readonly options: ReturnType<typeof launchApproval> & {
    readonly continues?: RunId;
    readonly onAdmitted?: (runId: RunId) => Effect.Effect<void, Error>;
  };
}

/** A resume's answer: the admitted run's end, or the session's refusal in
 *  its own words (a run held elsewhere names its holder). */
type ChatResumeResult =
  | { readonly started: true; readonly completion: Run['result'] }
  | { readonly failed: ResumeRefused['reason']; readonly message: string };

/** The run boundary `ChatSessionController` takes. */
export interface ChatAgentRuns {
  /** A round's launch on the chat's session. */
  readonly launch: (
    launch: ChatLaunch,
  ) => Effect.Effect<Pick<RunEndResult, 'outcome'>, Error>;
  readonly resume: (
    runId: RunId,
    options: Pick<ChatLaunch['options'], 'onAdmitted'>,
  ) => Effect.Effect<ChatResumeResult, Error>;
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
            Effect.as<ChatResumeResult>({
              started: true,
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
