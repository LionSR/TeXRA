/**
 * Chat slice: instruction polish/transcription results and voice-recording
 * lifecycle pushes.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import { instruction$, isPolishing$, isRecording$ } from '../mainViewState';
import { setInstruction, showInformation } from '../mainViewActions';

// `satisfies Partial<...>` subset — owns only chat commands; see
// bannerSlice.ts for the rationale.
export const chatHandlers = {
  [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]: (message) => {
    isPolishing$.set(false);
    if (message.text.trim()) {
      setInstruction(message.text);
      showInformation('Instruction polished.');
    }
  },

  [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR]: (message) => {
    isPolishing$.set(false);
    showInformation(
      `Could not polish the instruction. ${message.error || 'Try again.'}`,
    );
  },

  [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (message) => {
    if (!message.text) {
      isRecording$.set(false);
      return;
    }

    const current = instruction$.get();
    const updated = current ? `${current} ${message.text}` : message.text;
    setInstruction(updated);
    isRecording$.set(false);
    showInformation('Instruction transcribed.');
  },

  [MAIN_VIEW_COMMANDS.RECORDING_STARTED]: () => {
    isRecording$.set(true);
  },
  [MAIN_VIEW_COMMANDS.RECORDING_STOPPED]: () => {
    isRecording$.set(false);
  },
  [MAIN_VIEW_COMMANDS.RECORDING_ERROR]: () => {
    isRecording$.set(false);
  },
} satisfies Partial<MainViewHandlerRegistry>;
