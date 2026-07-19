// Local imports
import { isResumeInFlight } from '@agent/runtime/resolveAndResumeStream';
import type { StreamTabId } from '@shared/schemas';

export interface CliAgentResumeHandler {
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
}

let activeHandler: CliAgentResumeHandler | undefined;

export function setCliAgentResumeHandler(
  handler: CliAgentResumeHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = undefined;
    }
  };
}

export async function tryResumeCliStream(
  streamId: StreamTabId,
): Promise<boolean> {
  return activeHandler?.tryResumeStream(streamId) ?? false;
}

export function isCliResumeInFlight(streamId: StreamTabId): boolean {
  return activeHandler != null && isResumeInFlight(streamId);
}
