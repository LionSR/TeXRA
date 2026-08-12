/**
 * Chat slice: instruction-polish, clipboard-image, and voice recording
 * commands owned by the instruction and recording managers.
 */

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundHandlerRegistry } from '@shared/schemas';

import type { MainViewInboundHost } from '../mainViewInboundContext';

export function createChatHandlers(host: MainViewInboundHost) {
  return {
    [MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT]: (m) =>
      host.instructionManager.handlePolishInstructionText(m),
    [MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE]: (m) =>
      host.instructionManager.handleClipboardImage(m),

    [MAIN_VIEW_COMMANDS.START_RECORDING]: () =>
      host.runWithActiveView((view) => host.recordingManager.start(view)),
    [MAIN_VIEW_COMMANDS.STOP_RECORDING]: () =>
      host.runWithActiveView((view) => host.recordingManager.stop(view)),
  } satisfies Partial<MainViewInboundHandlerRegistry>;
}
