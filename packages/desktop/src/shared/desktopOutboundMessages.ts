// Main → renderer pushes for the desktop-only surfaces: editor file I/O,
// terminal streams, browser state, the diff/pdf/prompt overlays, shell
// navigation, logs, and onboarding.
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
// (a `command` that matches no member fails the whole parse) and by the route
// table, so no surface opts into stricter unknown-key handling. Keep it that
// way for new members.

import { z } from 'zod';

import {
  DesktopCloseDiffMessageSchema,
  DesktopShowDiffMessageSchema,
} from './desktopDiffMessages.js';
import { DesktopSetLogMessageSchema } from './desktopLogMessages.js';
import { DesktopOnboardingSetStateMessageSchema } from './desktopOnboardingMessages.js';
import {
  DesktopClosePdfMessageSchema,
  DesktopShowPdfMessageSchema,
} from './desktopPdfMessages.js';
import { DesktopShowPromptMessageSchema } from './desktopPromptMessages.js';
import {
  DesktopOpenWorkbenchMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopShowLauncherMessageSchema,
  DesktopToggleLayoutMessageSchema,
} from './desktopShellMessages.js';
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
} from './desktopWorkspaceMessages.js';

export const DesktopOutboundMessageSchema = z.discriminatedUnion('command', [
  // Editor file I/O
  DesktopFilesListedMessageSchema,
  DesktopFilesListErrorMessageSchema,
  DesktopFileReadMessageSchema,
  DesktopFileWrittenMessageSchema,
  DesktopFileErrorMessageSchema,
  // Terminal
  DesktopTerminalDataMessageSchema,
  DesktopTerminalExitMessageSchema,
  DesktopTerminalErrorMessageSchema,
  DesktopTerminalOpenCommandMessageSchema,
  // Browser + environment
  DesktopBrowserStateMessageSchema,
  DesktopEnvironmentStateMessageSchema,
  // Overlays
  DesktopShowDiffMessageSchema,
  DesktopCloseDiffMessageSchema,
  DesktopShowPdfMessageSchema,
  DesktopClosePdfMessageSchema,
  DesktopShowPromptMessageSchema,
  // Shell, logs, onboarding
  DesktopOpenWorkbenchMessageSchema,
  DesktopSaveFileMessageSchema,
  DesktopShowLauncherMessageSchema,
  DesktopToggleLayoutMessageSchema,
  DesktopSetLogMessageSchema,
  DesktopOnboardingSetStateMessageSchema,
]);
