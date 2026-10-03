// Main → renderer pushes for the desktop-only surfaces: the editor tree's
// change notice, terminal runs, browser state, the diff/pdf/prompt overlays, shell
// navigation, and logs.
//
// This union adds no new wire shape — it composes the per-surface schemas so
// `installDesktopHostBridge` can dev-assert every `desktop:*` command it
// multiplexes onto the single renderer-push channel (see
// `assertKnownOutboundMessage`). Inbound (renderer → main) halves of a
// request/response pair are deliberately excluded: they never cross this
// channel in the outbound direction.
//
// Parity note: every per-surface schema here uses `z.object`, not
// `z.strictObject`. Unknown-key drift on this channel is caught by this union
// (a `command` that matches no member fails the whole parse) and by the
// renderer's route table, which is typed over it, so no surface opts into stricter unknown-key handling. Keep it that
// way for new members.

import { z } from 'zod';

import {
  DesktopCloseDiffMessageSchema,
  DesktopShowDiffMessageSchema,
} from './desktopDiffMessages.js';
import { DesktopSetLogMessageSchema } from './desktopLogMessages.js';
import { DesktopProjectsMessageSchema } from './desktopProjectMessages.js';
import { DesktopShowPdfMessageSchema } from './desktopPdfMessages.js';
import { DesktopShowPromptMessageSchema } from './desktopPromptMessages.js';
import {
  DesktopOpenSettingsMessageSchema,
  DesktopOpenWorkbenchMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopToggleLayoutMessageSchema,
} from './desktopShellMessages.js';
import {
  DesktopBrowserStateMessageSchema,
  DesktopTerminalDataMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalExitMessageSchema,
  DesktopTerminalOpenCommandMessageSchema,
  DesktopWorkspaceFilesChangedMessageSchema,
} from './desktopWorkspaceMessages.js';

export const DesktopOutboundMessageSchema = z.discriminatedUnion('command', [
  // Editor tree
  DesktopWorkspaceFilesChangedMessageSchema,
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
  DesktopShowPromptMessageSchema,
  // Shell and logs
  DesktopOpenWorkbenchMessageSchema,
  DesktopOpenSettingsMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopToggleLayoutMessageSchema,
  DesktopSetLogMessageSchema,
  // Projects
  DesktopProjectsMessageSchema,
]);
