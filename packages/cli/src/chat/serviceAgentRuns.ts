/**
 * The chat's run boundary when its runs run in the TeXRA service: the same
 * launch and resume the controller drives in-process, answered by the
 * service's session. A launch or resume is admitted there, and the service
 * says when the run ends: the chat holds its turn until then, as a root
 * launch and a resume's `completion` do. The view folded here could still
 * show the run's previous end right after a resume.
 */
import { Effect } from 'effect';

import type {
  ResumeRunOptions,
  ResumeRunResult,
  RootLaunch,
  RunEndResult,
} from '@agent/runtime';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { ProcessServices, Session, SessionOwner } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/** The run boundary `ChatSessionController` takes. */
export interface ChatAgentRuns {
  /** A root launch on the chat's session. */
  readonly launch: (
    launch: RootLaunch,
  ) => Effect.Effect<Pick<RunEndResult, 'outcome'>, Error, SessionOwner>;
  readonly resume: (
    runId: RunId,
    options: ResumeRunOptions,
  ) => Effect.Effect<ResumeRunResult, Error, ProcessServices>;
  /** Resume a run beside the chat (a workflow), which the chat does not
   *  adopt; its refusal is told where it runs. */
  readonly resumeBeside: (runId: RunId) => Effect.Effect<void>;
}

/** The chat's run boundary over the service's `session`; each launch asks
 *  for `approvalPolicy()`, the policy the chat asked for itself (its flag,
 *  then `/approval`), which limits the task; none follows the project's. */
export function serviceAgentRuns(
  session: Session,
  approvalPolicy: () => TexraApprovalPolicy | undefined,
): ChatAgentRuns {
  const resume = (runId: RunId) => session.resume(runId, { interactive: true });
  return {
    launch: ({ request, options }) =>
      Effect.gen(function* () {
        const run = yield* session.start({
          config: request.config,
          runId: request.runId,
          continues: options.continues,
          approval: { policy: approvalPolicy() },
          interactive: true,
        });
        yield* options.onAdmitted?.(run.runId) ?? Effect.void;
        return yield* run.result;
      }),
    resumeBeside: (runId) =>
      resume(runId).pipe(
        Effect.ignore({ log: 'Warn', message: `Resuming ${runId}` }),
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
        // Waiting for what blocks it: the service resumes it once that is
        // back, as a window's own session would. The service words any
        // other refusal; the chat shows it as it is.
        Effect.catchTag('ResumeRefused', (refusal) =>
          refusal.reason === 'blocked'
            ? Effect.succeed<ResumeRunResult>({ failed: 'blocked' })
            : Effect.fail(new Error(refusal.message)),
        ),
      ),
  };
}
