import { Effect } from 'effect';

import type { ProcessServices } from '@platform/processRuntime';
import {
  DESKTOP_PROJECT_COMMANDS,
  DesktopCloseProjectMessageSchema,
  DesktopSelectProjectMessageSchema,
} from '../shared/desktopProjectMessages.js';
import { parsedRoute, type DesktopCommandRoutes } from './desktopIpcTypes.js';

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
 * the select and close requests.
 */
export function createDesktopProjectsIpc(
  actions: DesktopProjectsIpcActions,
): DesktopCommandRoutes {
  return {
    [DESKTOP_PROJECT_COMMANDS.REQUEST_PROJECTS]: () =>
      Effect.sync(() => actions.postProjects()),
    [DESKTOP_PROJECT_COMMANDS.SELECT_PROJECT]: parsedRoute(
      DesktopSelectProjectMessageSchema,
      (message) => actions.selectProject(message.key),
    ),
    [DESKTOP_PROJECT_COMMANDS.CLOSE_PROJECT]: parsedRoute(
      DesktopCloseProjectMessageSchema,
      (message) => actions.closeProject(message.key, message.hasUnsavedChanges),
    ),
  };
}
