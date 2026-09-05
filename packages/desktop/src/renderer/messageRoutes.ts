// The inbound window-message route table. It is assembled here (rather than
// inline in main.ts) so the routes are unit-testable and the schema imports are
// isolated from the renderer's composition root. The handlers bundle the
// main.ts-scoped closures the routes act on; the route bodies only ever reach
// renderer state through them.

import {
  DesktopSetLogMessageSchema,
  type DesktopSetLogMessage,
} from '../shared/desktopLogMessages';

import {
  DesktopOpenWorkbenchMessageSchema,
  DesktopResetLauncherMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopShowLauncherMessageSchema,
  DesktopToggleLayoutMessageSchema,
  type DesktopLayoutPanel,
} from '../shared/desktopShellMessages';
import { DesktopOnboardingSetStateMessageSchema } from '../shared/desktopOnboardingMessages';
import {
  DesktopPapersMessageSchema,
  type DesktopPapersMessage,
} from '../shared/desktopPaperMessages';
import {
  DesktopCloseDiffMessageSchema,
  DesktopShowDiffMessageSchema,
  type DesktopShowDiffMessage,
} from '../shared/desktopDiffMessages';
import {
  DesktopShowPdfMessageSchema,
  type DesktopShowPdfMessage,
} from '../shared/desktopPdfMessages';
import {
  DesktopShowPromptMessageSchema,
  type DesktopShowPromptMessage,
} from '../shared/desktopPromptMessages';
import {
  DesktopBrowserStateMessageSchema,
  DesktopEnvironmentStateMessageSchema,
  DesktopFileErrorMessageSchema,
  DesktopFileReadMessageSchema,
  DesktopFilesListErrorMessageSchema,
  DesktopFilesListedMessageSchema,
  DesktopFileWrittenMessageSchema,
  DesktopTerminalDataMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalExitMessageSchema,
  DesktopTerminalOpenCommandMessageSchema,
  DesktopWorkspaceFilesChangedMessageSchema,
  type DesktopEnvironmentSummary,
} from '../shared/desktopWorkspaceMessages';
import { takePendingFileRequest } from './fileRequests';
import type { WorkbenchKind } from '../shared/desktopTaskShell';
import type { ZodType } from 'zod';

/** Callbacks and live state reads the routes need from the renderer. */
interface DesktopMessageRouteHandlers {
  /** Persist all dirty editor buffers. */
  saveAllFiles(): void;
  /** Re-list the workspace after something outside the editor wrote to it. */
  reloadWorkspaceFiles(session: string): void;
  /** Live read of whether bootstrap failed (routes must not fire then). */
  isBootstrapFailed(): boolean;
  returnToLauncher(): void;
  /** The launcher's selections back to their defaults. */
  resetLauncher(): void;
  openKind(kind: WorkbenchKind): void;
  toggleLayoutPanel(panel: DesktopLayoutPanel): void;
  onboarding: {
    show(): void;
    hide(): void;
  };
  logs: { applySnapshot(message: DesktopSetLogMessage): void };
  review: {
    open(message: DesktopShowDiffMessage): void;
    clear(session: string): void;
  };
  disposeReviewTab(session: string): void;
  pdf: { open(message: DesktopShowPdfMessage): void };
  prompt: { open(message: DesktopShowPromptMessage): void };
  terminal: {
    write(session: string, sessionId: string, data: string): void;
    reportExit(session: string, sessionId: string, exitCode: number): void;
    reportError(session: string, sessionId: string, message: string): void;
  };
  openTerminalCommand(session: string, initialCommand: string): void;
  renameBrowserTab(session: string, tabId: string, title: string): void;
  /** Adopts a freshly reported environment summary and repaints the shell. */
  environment(session: string, summary: DesktopEnvironmentSummary): void;
  /** Adopts the open papers and which one this window shows. */
  papers(message: DesktopPapersMessage): void;
}

function messageRoute<T>(
  schema: ZodType<T>,
  handle: (message: T) => void,
): (data: unknown) => boolean {
  return (data) => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) return false;
    handle(parsed.data);
    return true;
  };
}

/**
 * Every inbound window message the shell claims, in match order: the first
 * route whose schema parses handles it. Shell routes come first, then the
 * main-process replies for the editor, terminal, and browser panes.
 */
export function createMessageRoutes(
  handlers: DesktopMessageRouteHandlers,
): ReadonlyArray<(data: unknown) => boolean> {
  return [
    messageRoute(DesktopSaveFileMessageSchema, () => {
      handlers.saveAllFiles();
    }),
    messageRoute(DesktopShowLauncherMessageSchema, () => {
      if (!handlers.isBootstrapFailed()) handlers.returnToLauncher();
    }),
    messageRoute(DesktopResetLauncherMessageSchema, () => {
      if (!handlers.isBootstrapFailed()) handlers.resetLauncher();
    }),
    messageRoute(DesktopOpenWorkbenchMessageSchema, (message) => {
      if (!handlers.isBootstrapFailed()) handlers.openKind(message.kind);
    }),
    messageRoute(DesktopToggleLayoutMessageSchema, (message) => {
      handlers.toggleLayoutPanel(message.panel);
    }),
    messageRoute(DesktopOnboardingSetStateMessageSchema, (message) => {
      if (message.shouldShow) {
        handlers.onboarding.show();
      } else {
        handlers.onboarding.hide();
      }
    }),
    messageRoute(DesktopSetLogMessageSchema, (message) =>
      handlers.logs.applySnapshot(message),
    ),
    messageRoute(DesktopShowDiffMessageSchema, (message) => {
      handlers.review.open(message);
    }),
    messageRoute(DesktopCloseDiffMessageSchema, (message) => {
      handlers.review.clear(message.session);
      handlers.disposeReviewTab(message.session);
    }),
    messageRoute(DesktopShowPdfMessageSchema, (message) =>
      handlers.pdf.open(message),
    ),
    messageRoute(DesktopShowPromptMessageSchema, (message) =>
      handlers.prompt.open(message),
    ),
    messageRoute(DesktopFilesListedMessageSchema, (message) => {
      const pending = takePendingFileRequest(
        message.session,
        message.requestId,
      );
      if (pending?.kind === 'list') pending.resolve(message.files);
    }),
    messageRoute(DesktopFilesListErrorMessageSchema, (message) => {
      const pending = takePendingFileRequest(
        message.session,
        message.requestId,
      );
      if (pending?.kind === 'list') pending.reject(new Error(message.message));
    }),
    messageRoute(DesktopFileReadMessageSchema, (message) => {
      const pending = takePendingFileRequest(
        message.session,
        message.requestId,
      );
      if (pending?.kind === 'read') pending.resolve(message.contents);
    }),
    messageRoute(DesktopFileWrittenMessageSchema, (message) => {
      const pending = takePendingFileRequest(
        message.session,
        message.requestId,
      );
      if (pending?.kind === 'write') pending.resolve();
    }),
    messageRoute(DesktopWorkspaceFilesChangedMessageSchema, (message) => {
      handlers.reloadWorkspaceFiles(message.session);
    }),
    messageRoute(DesktopFileErrorMessageSchema, (message) => {
      // One request, one rejection: the requestId names the single pending read
      // or write, so there is no read/write queue pair to sweep.
      const pending = takePendingFileRequest(
        message.session,
        message.requestId,
      );
      if (pending?.kind === 'read' || pending?.kind === 'write') {
        pending.reject(new Error(message.message));
      }
    }),
    messageRoute(DesktopTerminalDataMessageSchema, (message) =>
      handlers.terminal.write(message.session, message.sessionId, message.data),
    ),
    messageRoute(DesktopTerminalOpenCommandMessageSchema, (message) =>
      handlers.openTerminalCommand(message.session, message.initialCommand),
    ),
    messageRoute(DesktopTerminalExitMessageSchema, (message) =>
      handlers.terminal.reportExit(
        message.session,
        message.sessionId,
        message.exitCode,
      ),
    ),
    messageRoute(DesktopTerminalErrorMessageSchema, (message) =>
      handlers.terminal.reportError(
        message.session,
        message.sessionId,
        message.message,
      ),
    ),
    // Renames the document so a browser tab reads as its page rather than a
    // generic "Browser".
    messageRoute(DesktopBrowserStateMessageSchema, (message) =>
      handlers.renameBrowserTab(message.session, message.tabId, message.title),
    ),
    messageRoute(DesktopEnvironmentStateMessageSchema, (message) =>
      handlers.environment(message.session, message.environment),
    ),
    messageRoute(DesktopPapersMessageSchema, (message) =>
      handlers.papers(message),
    ),
  ];
}
