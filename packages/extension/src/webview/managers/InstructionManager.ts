import * as vscode from 'vscode';

import { polishTextWithAI, FileContext } from '@agent/runtime/textEnhancement';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewInboundMessage } from '@shared/schemas';
import { StorageFS } from '@utils/files';
import { THREE_DAYS_MS } from '@utils/config';
import { filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  PASTED_DIR,
  savePastedImageBase64,
} from '@utils/files/pastedImageUtils';
import { BaseWebviewManager } from './BaseWebviewManager';

const CHANNEL = 'InstructionManager';

type PolishInstructionMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT }
>;

type ClipboardImageMessage = Extract<
  MainViewInboundMessage,
  { command: typeof MAIN_VIEW_COMMANDS.CLIPBOARD_IMAGE }
>;

export class InstructionManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  constructor() {
    super();
    setTimeout(async () => {
      try {
        await StorageFS.ensureDir(PASTED_DIR);
        await StorageFS.cleanupOldFiles(PASTED_DIR, THREE_DAYS_MS);
      } catch (e) {
        logger.warn(
          CHANNEL,
          `Error during initial cleanup: ${toErrorMessage(e)}`,
        );
      }
    }, 100);
  }

  async handlePolishInstructionText(
    message: PolishInstructionMessage,
  ): Promise<void> {
    if (!this.getWebview()) {
      return;
    }
    try {
      const fileContext = this.buildFileContext(message);
      const result = await polishTextWithAI(message.text, fileContext);
      if (result.success) {
        this.postMessage({
          command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED,
          text: result.text,
        });
      } else {
        this.postMessage({
          command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
          error: result.error ?? 'Error polishing text',
        });
      }
    } catch (error) {
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
        error: toErrorMessage(error),
      });
      logger.error(
        CHANNEL,
        `Error in handlePolishInstructionText: ${toErrorMessage(error)}`,
      );
    }
  }

  /** Build file context for AI text polishing, filtering empty/placeholder values */
  private buildFileContext(message: PolishInstructionMessage): FileContext {
    const context: FileContext = { agent: message.agent };

    // Multi-file fields (check active flag and array content)
    const multiFields = [
      ['inputFiles', 'inputFilesActive'],
      ['contextFiles', 'contextFilesActive'],
      ['mediaFiles', 'mediaFilesActive'],
      ['outputFiles', 'outputFilesActive'],
    ] as const;
    for (const [field, activeField] of multiFields) {
      const files: (string | null)[] | undefined = message[field];
      if (message[activeField] && Array.isArray(files) && files.length > 0) {
        context[field] = files.filter(filterNotNull);
      }
    }

    return context;
  }

  handleTranscribeInstruction(): void {
    vscode.window.showInformationMessage(
      'Please use the new recording interface with start/stop controls.',
    );
  }

  async handleClipboardImage(message: ClipboardImageMessage): Promise<void> {
    if (!this.getWebview()) {
      return;
    }
    try {
      const { base64, mediaType, fileName } = message;
      if (!base64 || !mediaType || !fileName) {
        return;
      }
      await savePastedImageBase64(base64, fileName);
      this.postMessage({
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
