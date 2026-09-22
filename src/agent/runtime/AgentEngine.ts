/** The two recursive agent entry points, supplied once by the process root. */
import { Context } from 'effect';

import type { executeAgent, resumeToolUseFromResumeData } from './executeAgent';

/** Type-only engine contract: delegation must not import the implementation. */
export class AgentEngine extends Context.Service<
  AgentEngine,
  {
    readonly executeAgent: typeof executeAgent;
    readonly resumeToolUseFromResumeData: typeof resumeToolUseFromResumeData;
  }
>()('@texra/AgentEngine') {}
