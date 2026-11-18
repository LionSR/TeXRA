// Main → renderer pushes for the desktop-only surfaces: the editor tree's
// change notice, terminal runs, browser state, the diff/pdf/prompt overlays, shell
// navigation, and logs.
//
// This union adds no new wire shape — it composes the per-surface schemas the
// renderer's route table decodes every `desktop:*` push against, on the one
// renderer-push channel it shares with the settings view. Inbound (renderer → main) halves of a
// request/response pair are deliberately excluded: they never cross this
// channel in the outbound direction.
//
// A push whose `command` matches no member fails the renderer's parse; extra
// keys are ignored, as every member is a `Schema.Struct`. A misspelled field
// is caught at compile time instead: every main-process sender takes
// `DesktopPush`.

import { Schema } from 'effect';
import type { SettingsViewOutboundMessage } from '@texra/shared/settingsView/settingsViewMessages';

import {
  DesktopCloseDiffMessageSchema,
  DesktopShowDiffMessageSchema,
} from './desktopDiffMessages.js';
import { DesktopSetLogMessageSchema } from './desktopLogMessages.js';
import { DesktopProjectsMessageSchema } from './desktopProjectMessages.js';
import {
  DesktopPdfLoadFailedMessageSchema,
  DesktopShowPdfMessageSchema,
} from './desktopPdfMessages.js';
import { DesktopShowPromptMessageSchema } from './desktopPromptMessages.js';
import { DesktopRunCommandMessageSchema } from './desktopCommandSurface.js';
import { DesktopOpenSettingsMessageSchema } from './desktopShellMessages.js';
import {
  DesktopBrowserStateMessageSchema,
  DesktopTerminalDataMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalExitMessageSchema,
  DesktopTerminalOpenCommandMessageSchema,
  DesktopWorkspaceFilesChangedMessageSchema,
  DesktopOpenDocumentMessageSchema,
} from './desktopWorkspaceMessages.js';

export const DesktopOutboundMessageSchema = Schema.Union([
  // Editor tree
  DesktopWorkspaceFilesChangedMessageSchema,
  DesktopOpenDocumentMessageSchema,
  // Terminal
  DesktopTerminalDataMessageSchema,
  DesktopTerminalExitMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalOpenCommandMessageSchema,
  // Browser
  DesktopBrowserStateMessageSchema,
  // Overlays
  DesktopShowDiffMessageSchema,
  DesktopCloseDiffMessageSchema,
  DesktopShowPdfMessageSchema,
  DesktopPdfLoadFailedMessageSchema,
  DesktopShowPromptMessageSchema,
  // Shell and logs
  DesktopRunCommandMessageSchema,
  DesktopOpenSettingsMessageSchema,
  DesktopSetLogMessageSchema,
  // Projects
  DesktopProjectsMessageSchema,
]);

/** What the main process may push on the renderer's one webview channel:
 *  a desktop surface's message or the settings view's. */
export type DesktopPush =
  | typeof DesktopOutboundMessageSchema.Type
  | SettingsViewOutboundMessage;
