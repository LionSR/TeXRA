// The inbound window-message route table. It is assembled here (rather than
// inline in main.ts) so the routes are unit-testable and the schema imports are
// isolated from the renderer's composition root. The handlers bundle the
// main.ts-scoped closures the routes act on; the route bodies only ever reach
// renderer state through them.

import { SetThemeMessageSchema, type DesktopThemeKind } from '@shared/schemas';
import {
  DesktopSetLogMessageSchema,
  type DesktopSetLogMessage,
} from '../shared/desktopLogMessages';

import {
  DesktopOpenWorkbenchMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopShowLauncherMessageSchema,
  DesktopToggleLayoutMessageSchema,
  type DesktopLayoutPanel,
} from '../shared/desktopShellMessages';
import { DesktopOnboardingSetStateMessageSchema } from '../shared/desktopOnboardingMessages';
import {
  DesktopCloseDiffMessageSchema,
  DesktopShowDiffMessageSchema,
  type DesktopShowDiffMessage,
} from '../shared/desktopDiffMessages';
import {
  DesktopClosePdfMessageSchema,
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
  type DesktopEnvironmentSummary,
} from '../shared/desktopWorkspaceMessages';
import { takePendingFileRequest } from './fileRequests';
import type { WorkbenchKind } from '../shared/desktopTaskShell';
import type { ZodType } from 'zod';

/** Callbacks and live state reads the routes need from the renderer. */
export interface DesktopMessageRouteHandlers {
  /** Persist all dirty editor buffers. */
  saveAllFiles(): void;
  /** Live read of whether bootstrap failed (routes must not fire then). */
  isBootstrapFailed(): boolean;
  returnToLauncher(): void;
  openKind(kind: WorkbenchKind): void;
  toggleLayoutPanel(panel: DesktopLayoutPanel): void;
  onboarding: {
    show(): void;
    hide(): void;
  };
  applyTheme(theme: DesktopThemeKind): void;
  logs: { applySnapshot(message: DesktopSetLogMessage): void };
  review: {
    open(message: DesktopShowDiffMessage): void;
    clear(): void;
  };
  disposeReviewTab(): void;
  pdf: {
    open(message: DesktopShowPdfMessage): void;
    close(): void;
  };
  prompt: { open(message: DesktopShowPromptMessage): void };
  terminal: {
    write(sessionId: string, data: string): void;
    reportExit(sessionId: string, exitCode: number): void;
    reportError(sessionId: string, message: string): void;
  };
  openTerminalCommand(initialCommand: string): void;
  renameBrowserTab(tabId: string, title: string): void;
  environment: {
    set(summary: DesktopEnvironmentSummary | undefined, loading: boolean): void;
    rerender(): void;
  };
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
    messageRoute(SetThemeMessageSchema, (message) =>
      handlers.applyTheme(message.theme),
    ),
    messageRoute(DesktopSetLogMessageSchema, (message) =>
      handlers.logs.applySnapshot(message),
    ),
    messageRoute(DesktopShowDiffMessageSchema, (message) => {
      handlers.review.open(message);
      handlers.openKind('review');
    }),
    messageRoute(DesktopCloseDiffMessageSchema, () => {
      handlers.review.clear();
      handlers.disposeReviewTab();
    }),
    messageRoute(DesktopShowPdfMessageSchema, (message) =>
      handlers.pdf.open(message),
    ),
    messageRoute(DesktopClosePdfMessageSchema, () => handlers.pdf.close()),
    messageRoute(DesktopShowPromptMessageSchema, (message) =>
      handlers.prompt.open(message),
    ),
    messageRoute(DesktopFilesListedMessageSchema, (message) => {
      const pending = takePendingFileRequest(message.requestId);
      if (pending?.kind === 'list') pending.resolve(message.files);
    }),
    messageRoute(DesktopFilesListErrorMessageSchema, (message) => {
      const pending = takePendingFileRequest(message.requestId);
      if (pending?.kind === 'list') pending.reject(new Error(message.message));
    }),
    messageRoute(DesktopFileReadMessageSchema, (message) => {
      const pending = takePendingFileRequest(message.requestId);
      if (pending?.kind === 'read') pending.resolve(message.contents);
    }),
    messageRoute(DesktopFileWrittenMessageSchema, (message) => {
      const pending = takePendingFileRequest(message.requestId);
      if (pending?.kind === 'write') pending.resolve();
    }),
    messageRoute(DesktopFileErrorMessageSchema, (message) => {
      // One request, one rejection: the requestId names the single pending read
      // or write, so there is no read/write queue pair to sweep.
      const pending = takePendingFileRequest(message.requestId);
      if (pending?.kind === 'read' || pending?.kind === 'write') {
        pending.reject(new Error(message.message));
      }
    }),
    messageRoute(DesktopTerminalDataMessageSchema, (message) =>
      handlers.terminal.write(message.sessionId, message.data),
    ),
    messageRoute(DesktopTerminalOpenCommandMessageSchema, (message) =>
      handlers.openTerminalCommand(message.initialCommand),
    ),
    messageRoute(DesktopTerminalExitMessageSchema, (message) =>
      handlers.terminal.reportExit(message.sessionId, message.exitCode),
    ),
    messageRoute(DesktopTerminalErrorMessageSchema, (message) =>
      handlers.terminal.reportError(message.sessionId, message.message),
    ),
    // Renames the document so a browser tab reads as its page rather than a
    // generic "Browser".
    messageRoute(DesktopBrowserStateMessageSchema, (message) =>
      handlers.renameBrowserTab(message.tabId, message.title),
    ),
    messageRoute(DesktopEnvironmentStateMessageSchema, (message) => {
      handlers.environment.set(message.environment, false);
      handlers.environment.rerender();
    }),
  ];
}
