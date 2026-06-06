import type { StreamTabId } from '@shared/schemas';

type DesktopResumeHandler = (streamId: StreamTabId) => Promise<boolean>;

let activeHandler: DesktopResumeHandler | undefined;

export function setDesktopAgentResumeHandler(
  handler: DesktopResumeHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = undefined;
    }
  };
}

export async function tryResumeDesktopStream(
  streamId: StreamTabId,
): Promise<boolean> {
  return activeHandler?.(streamId) ?? false;
}
