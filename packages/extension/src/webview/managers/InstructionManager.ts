import { polishTextWithAI, FileContext } from '@agent/runtime';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { createLog } from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundMessage, MainViewMessage } from '@shared/schemas';
import { filterNotNull } from '@utils/core';
import { StorageFS } from '@utils/files/storageFS';
import { THREE_DAYS_MS } from '@utils/config/constants';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { PASTED_DIR } from '@utils/files/pastedImageName';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

const CHANNEL = 'InstructionManager';
const log = createLog(CHANNEL);

type PolishInstructionMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT }
>;

type ClipboardImageMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE }
>;

export class InstructionManager {
  /** Posts to whichever launcher webview is dispatching right now. */
  constructor(private readonly post: (message: MainViewMessage) => void) {
    setTimeout(async () => {
      try {
        await StorageFS.ensureDir(PASTED_DIR);
        await StorageFS.cleanupOldFiles(PASTED_DIR, THREE_DAYS_MS);
      } catch (e) {
        log.warn(`Error during initial cleanup: ${toErrorMessage(e)}`);
      }
    }, 100);
  }

  async handlePolishInstructionText(
    message: PolishInstructionMessage,
  ): Promise<void> {
    try {
      const fileContext = this.buildFileContext(message);
      const result = await polishTextWithAI(message.text, fileContext);
      if (result.success) {
        this.post({
          command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED,
          text: result.text,
        });
      } else {
        this.post({
          command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
          error: result.error ?? 'Error polishing text',
        });
      }
    } catch (error) {
      this.post({
        command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
        error: toErrorMessage(error),
      });
      log.error(
        `Error in handlePolishInstructionText: ${toErrorMessage(error)}`,
      );
    }
  }

  /** Build file context for AI text polishing, filtering null values. */
  private buildFileContext(message: PolishInstructionMessage): FileContext {
    const context: FileContext = { agent: message.agent };

    // Multi-file fields with array content
    const multiFields = ['inputFiles', 'contextFiles', 'mediaFiles'] as const;
    for (const field of multiFields) {
      const files: (string | null)[] | undefined = message[field];
      if (Array.isArray(files) && files.length > 0) {
        context[field] = files.filter(filterNotNull);
      }
    }

    return context;
  }

  async handleClipboardImage(message: ClipboardImageMessage): Promise<void> {
    try {
      const { base64, mediaType, fileName } = message;
      if (!base64 || !mediaType || !fileName) {
        return;
      }
      await savePastedImageBase64(base64, fileName);
      this.post({
        command: MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE,
        file: fileName,
      });
    } catch (err) {
      // Surface to the user — otherwise the paste silently does nothing and
      // they have no idea the image was dropped.
      await showLoggedErrorMessage(CHANNEL, 'Failed to paste image', err);
    }
  }
}
