import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';

interface CliAgentResumeHandler {
  tryResumeStream(
    streamId: StreamTabId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean>;
}

let activeHandler: CliAgentResumeHandler | undefined;

export function setCliAgentResumeHandler(
  handler: CliAgentResumeHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = undefined;
  };
}

export async function tryResumeCliStream(
  streamId: StreamTabId,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  return activeHandler?.tryResumeStream(streamId, recovery) ?? false;
}
