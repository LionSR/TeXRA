import { Effect } from 'effect';

import type { ProcessServices } from '@platform/processRuntime';
import {
  DESKTOP_PROJECT_COMMANDS,
  DesktopCloseProjectMessageSchema,
  DesktopSelectProjectMessageSchema,
} from '../shared/desktopProjectMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

/** What the window lets the renderer do to its open projects. */
export interface DesktopProjectsIpcActions {
  /** Send the open projects and which one this window shows. */
  postProjects(): void;
  selectProject(key: string): Effect.Effect<void, Error, ProcessServices>;
  closeProject(
    key: string,
    hasUnsavedChanges: boolean,
  ): Effect.Effect<void, Error, ProcessServices>;
}

/**
 * Renderer traffic about projects: the list it asks for once it boots, and
 * the select and close requests. safeParse, not parse: dispatch has no
 * catch, so a malformed message is dropped, not an unhandled rejection.
 */
export function createDesktopProjectsIpc(
  actions: DesktopProjectsIpcActions,
): DesktopMessageHandler {
  return {
    handleMessage(message: DesktopCommandMessage) {
      switch (message.command) {
        case DESKTOP_PROJECT_COMMANDS.REQUEST_PROJECTS:
          return Effect.sync(() => actions.postProjects());
        case DESKTOP_PROJECT_COMMANDS.SELECT_PROJECT: {
          const parsed = DesktopSelectProjectMessageSchema.safeParse(message);
          return parsed.success
            ? actions.selectProject(parsed.data.key)
            : Effect.void;
        }
        case DESKTOP_PROJECT_COMMANDS.CLOSE_PROJECT: {
          const parsed = DesktopCloseProjectMessageSchema.safeParse(message);
          return parsed.success
            ? actions.closeProject(
                parsed.data.key,
                parsed.data.hasUnsavedChanges,
              )
            : Effect.void;
        }
        default:
          return undefined;
      }
    },
  };
}
