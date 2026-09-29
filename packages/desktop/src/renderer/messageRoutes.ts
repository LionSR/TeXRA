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
  DesktopOpenSettingsMessageSchema,
  DesktopOpenWorkbenchMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopToggleLayoutMessageSchema,
  type DesktopLayoutPanel,
} from '../shared/desktopShellMessages';
import { DesktopOnboardingSetStateMessageSchema } from '../shared/desktopOnboardingMessages';
import {
  DesktopProjectsMessageSchema,
  type DesktopProjectsMessage,
} from '../shared/desktopProjectMessages';
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
  DesktopTerminalDataMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalExitMessageSchema,
  DesktopTerminalOpenCommandMessageSchema,
  DesktopWorkspaceFilesChangedMessageSchema,
} from '../shared/desktopWorkspaceMessages';
import type { WorkbenchKind } from '../shared/desktopShellState';
import type { z, ZodType } from 'zod';

/** Callbacks and live state reads the routes need from the renderer. */
interface DesktopMessageRouteHandlers {
  /** Persist all dirty editor buffers. */
  saveAllFiles(): void;
  /** Re-list the workspace after something outside the editor wrote to it. */
  reloadWorkspaceFiles(session: string): void;
  /** Live read of whether bootstrap failed (routes must not fire then). */
  isBootstrapFailed(): boolean;
  openKind(kind: WorkbenchKind): void;
  openSettings(): void;
  toggleLayoutPanel(panel: DesktopLayoutPanel): void;
  onboarding: {
    show(): void;
    hide(): void;
  };
  logs: { applySnapshot(message: DesktopSetLogMessage): void };
  review: {
    open(message: DesktopShowDiffMessage): void;
    /**
     * Drop the reviews `previewId` opened, keeping the rest; reports whether
     * the pane is left empty.
     */
    close(session: string, previewId: string): boolean;
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
  /** Adopts the open projects and which one this window shows. */
  projects(message: DesktopProjectsMessage): void;
}

type MessageRoute = readonly [string, (data: unknown) => void];

/** The route of the command `schema` names. A claimed command that fails its
 *  schema is the host's defect: warned, and nothing runs. */
function messageRoute<
  S extends ZodType & { shape: { command: z.ZodLiteral<string> } },
>(schema: S, handle: (message: z.output<S>) => void): MessageRoute {
  const [command] = [...schema.shape.command.values];
  return [
    command,
    (data) => {
      const parsed = schema.safeParse(data);
      if (parsed.success) handle(parsed.data);
      else console.warn(`Dropped a malformed ${command} push`, parsed.error);
    },
  ];
}

/**
 * Every inbound window message the shell claims, by command: the shell's own
 * commands, then the main-process pushes for the terminal and browser panes.
 * A command with no entry is not the shell's (the settings view's pushes
 * share the window).
 */
export function createMessageRoutes(
  handlers: DesktopMessageRouteHandlers,
): ReadonlyMap<string, (data: unknown) => void> {
  const routes: MessageRoute[] = [
    messageRoute(DesktopSaveFileMessageSchema, () => {
      handlers.saveAllFiles();
    }),
    messageRoute(DesktopOpenWorkbenchMessageSchema, (message) => {
      if (!handlers.isBootstrapFailed()) handlers.openKind(message.kind);
    }),
    messageRoute(DesktopOpenSettingsMessageSchema, () => {
      if (!handlers.isBootstrapFailed()) handlers.openSettings();
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
      // A close takes its own diff off the pane and nothing else; the Review
      // tab goes only once that leaves the pane empty, so a request settling
      // never dismisses another request's preview or an unrelated review.
      if (handlers.review.close(message.session, message.previewId)) {
        handlers.disposeReviewTab(message.session);
      }
    }),
    messageRoute(DesktopShowPdfMessageSchema, (message) =>
      handlers.pdf.open(message),
    ),
    messageRoute(DesktopShowPromptMessageSchema, (message) =>
      handlers.prompt.open(message),
    ),
    messageRoute(DesktopWorkspaceFilesChangedMessageSchema, (message) => {
      handlers.reloadWorkspaceFiles(message.session);
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
    messageRoute(DesktopProjectsMessageSchema, (message) =>
      handlers.projects(message),
    ),
  ];
  const table = new Map(routes);
  if (table.size !== routes.length)
    throw new Error('Two pushes share a command');
  return table;
}
