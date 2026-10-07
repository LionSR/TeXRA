/**
 * The chat's run boundary when its runs run in the TeXRA service: the same
 * launch and resume the controller drives in-process, answered by the
 * service. A launch or resume is admitted there, and the service says when
 * the run ends: the chat holds its turn until then, as `runAgent` and a
 * resume's `completion` do. The view folded here could still show the
 * run's previous end right after a resume.
 */
import { Effect } from 'effect';

import type {
  ResumeRunOptions,
  ResumeRunResult,
  RunAgentOptions,
  RunAgentRequest,
  RunEndResult,
} from '@agent/runtime';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';
import type { ProcessServices } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/** The run boundary `ChatSessionController` takes. */
export interface ChatAgentRuns {
  readonly launch: (
    request: RunAgentRequest,
    options: RunAgentOptions,
  ) => Effect.Effect<Pick<RunEndResult, 'outcome'>, Error, ProcessServices>;
  readonly resume: (
    runId: RunId,
    options: ResumeRunOptions,
  ) => Effect.Effect<ResumeRunResult, Error, ProcessServices>;
  /** Resume a run beside the chat (a workflow), which the chat does not
   *  adopt; its refusal is told where it runs. */
  readonly resumeBeside: (runId: RunId) => Effect.Effect<void>;
}

/** The chat's run boundary over the service's `backend`; each launch asks
 *  for `approvalPolicy()`, the chat's own policy, which narrows the task
 *  when it is stricter than the project's. */
export function serviceAgentRuns(
  backend: SessionBackend,
  approvalPolicy: () => TexraApprovalPolicy,
): ChatAgentRuns {
  return {
    launch: (request, options) =>
      backend.launch(request, {
        continues: options.continues,
        onRunResolved: options.onRunResolved,
        approvalPolicy: approvalPolicy(),
      }),
    resumeBeside: (runId) =>
      backend
        .resume(runId)
        .pipe(Effect.ignore({ log: 'Warn', message: `Resuming ${runId}` })),
    resume: (runId, options) =>
      backend.resume(runId).pipe(
        // The service words its refusal; the chat shows it as it is.
        Effect.mapError(
          (refusal) =>
            new Error(
              refusal._tag === 'Cancelled'
                ? 'The resume was cancelled.'
                : refusal.reason,
            ),
        ),
        Effect.flatMap((resumed) => {
          // Waiting for what blocks it: the service resumes it once that is
          // back, as a window's own session would.
          if (resumed === null)
            return Effect.succeed<ResumeRunResult>({ failed: 'blocked' });
          return (
            options.onResumeResolved?.(resumed.runId) ?? Effect.void
          ).pipe(
            Effect.as<ResumeRunResult>({
              started: true,
              delivered: true,
              completion: backend.ended(resumed.runId),
            }),
          );
        }),
      ),
  };
}
