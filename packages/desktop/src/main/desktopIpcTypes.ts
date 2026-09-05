import { UnsupportedCommandError } from '@shared/utils/dispatcher';

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

export interface DesktopOverlayPostOptions {
  /**
   * Posts the overlay message to the renderer. Return `false` (or throw) when
   * the renderer is not reachable — the IPC bridge isn't wired yet at startup,
   * or the BrowserWindow has been destroyed. When undefined the overlay is
   * skipped entirely, which keeps tests and unattended invocations working.
   */
  postToRenderer?(message: unknown): boolean | void;
}

/**
 * Show one message in an in-app renderer overlay (the Review diff workbench,
 * the PDF viewer), reporting whether it was shown. A `false` result opts the
 * caller into its external-application fallback so the user never gets a
 * silent failure (caught by Copilot review on PR #3815).
 */
export function tryShowInRenderer(
  options: DesktopOverlayPostOptions & { source: string; fallback: string },
  message: unknown,
): boolean {
  if (!options.postToRenderer) return false;
  try {
    return options.postToRenderer(message) !== false;
  } catch (error) {
    console.error(
      `[desktop] ${options.source}: postToRenderer failed; falling back to ${options.fallback}`,
      error,
    );
    return false;
  }
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

/**
 * Wraps a dispatcher's `onError` callback so an {@link UnsupportedCommandError}
 * (a registry entry declared `unsupported(...)`) is routed to `onUnsupported`
 * — the host's visible-feedback surface (e.g. a native info dialog) — instead
 * of the generic error reporter. Every desktop dispatcher call site shares
 * this so "command deliberately unsupported here" always produces visible
 * feedback rather than a console-only log.
 */
export function createDesktopErrorReporter(
  onError?: (error: unknown) => void,
  onUnsupported?: (error: UnsupportedCommandError) => void,
): (error: unknown) => void {
  const reportError = onError ?? defaultReportError;
  if (!onUnsupported) return reportError;
  return (error: unknown) => {
    if (error instanceof UnsupportedCommandError) {
      onUnsupported(error);
      return;
    }
    reportError(error);
  };
}

function defaultReportError(error: unknown): void {
  console.error(error);
}
