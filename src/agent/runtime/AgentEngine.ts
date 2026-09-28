/** The three recursive agent entry points, supplied once by the process root. */
import { Context, type Effect } from 'effect';

import type { ProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';

import type { executeAgent, resumeToolUseFromResumeData } from './executeAgent';
import type { ResumeRunOptions, ResumeRunResult } from './resumeRun';

/** Type-only engine contract: delegation must not import the implementation. */
export class AgentEngine extends Context.Service<
  AgentEngine,
  {
    readonly executeAgent: typeof executeAgent;
    readonly resumeToolUseFromResumeData: typeof resumeToolUseFromResumeData;
    /** `resumeClaimedRun`, for the follow-up wake: a resumed run's own child
     *  loop wakes its parent, so the wake must not import it either. */
    readonly resumeClaimedRun: (
      runId: RunId,
      options: ResumeRunOptions,
    ) => Effect.Effect<ResumeRunResult, Error, ProcessServices>;
  }
>()('@texra/agent/AgentEngine') {}
