/**
 * The CLI's agent-resume port and the chat TUI's handler registration.
 *
 * The port lives beside the process-runtime install rather than in
 * `initPlatform.ts` for one reason: `initCliPlatform` imports
 * `installCliProcessRuntime`, so the runtime install cannot import the port
 * back from it. Every CLI entry shares this one value — whichever entry
 * installs the process runtime first serves the same port.
 */
import { Effect } from 'effect';

import type { AgentResumePort } from '@platform/interfaces';

/**
 * The chat TUI's stream resume, installed while a chat session is mounted.
 * The port below forwards to it; outside a chat there is no host that can
 * resume, so the port answers `false`.
 *
 * It is the port's own member, not a shape of its own: the chat controller
 * answers the resume in exactly what the port declares, so this registration
 * carries the program rather than adapting one.
 */
let cliResumeHandler: AgentResumePort['tryResumeRun'] | undefined;

export function setCliAgentResumeHandler(
  handler: AgentResumePort['tryResumeRun'],
): () => void {
  cliResumeHandler = handler;
  return () => {
    if (cliResumeHandler === handler) cliResumeHandler = undefined;
  };
}

/** The CLI's one resume port: the platform's and the `AgentResume`
 *  service's value alike. */
export const cliAgentResume: AgentResumePort = {
  // Suspended so the installed handler is read when the resume runs, not when
  // the program is built: a chat that unmounts in between answers `false`.
  tryResumeRun: (runId, recovery) =>
    Effect.suspend(
      () => cliResumeHandler?.(runId, recovery) ?? Effect.succeed(false),
    ),
};
