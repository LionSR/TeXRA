export type DesktopCommandMessage = { command: string } & Record<
  string,
  unknown
>;

export interface DesktopMessageHandler {
  handleMessage(message: DesktopCommandMessage): boolean;
}

export interface DesktopRenderer {
  postToRenderer(message: unknown): void;
}

export function isDesktopCommandMessage(
  message: unknown,
): message is DesktopCommandMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'command' in message &&
    typeof message.command === 'string'
  );
}

export function createDesktopErrorReporter(
  onError?: (error: unknown) => void,
): (error: unknown) => void {
  return onError ?? defaultReportError;
}

function defaultReportError(error: unknown): void {
  console.error(error);
}
