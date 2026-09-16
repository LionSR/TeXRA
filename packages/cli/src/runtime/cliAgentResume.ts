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

import {
  AgentResumeFailed,
  type AgentResumePort,
  type RecoveryContinuation,
} from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * The chat TUI's stream resume, installed while a chat session is mounted.
 * The platform port below forwards to it; outside a chat there is no host
 * that can resume, so the port answers `false`.
 *
 * Promise-typed on purpose: the TUI's controller claims its root-run slot in
 * a synchronous promise handshake, so the port adopts the attempt where it
 * stands rather than the controller answering in a shape it cannot.
 */
type CliResumeHandler = (
  runId: RunId,
  recovery?: RecoveryContinuation,
) => Promise<boolean>;

let cliResumeHandler: CliResumeHandler | undefined;

export function setCliAgentResumeHandler(
  handler: CliResumeHandler,
): () => void {
  cliResumeHandler = handler;
  return () => {
    if (cliResumeHandler === handler) cliResumeHandler = undefined;
  };
}

/** The CLI's one resume port: the platform's and the `AgentResume`
 *  service's value alike. */
export const cliAgentResume: AgentResumePort = {
  tryResumeRun: (runId, recovery) =>
    Effect.tryPromise({
      try: async () => (await cliResumeHandler?.(runId, recovery)) ?? false,
      catch: (cause) =>
        new AgentResumeFailed({
          runId,
          message: toErrorMessage(cause),
          cause,
        }),
    }),
};
