// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { toErrorMessage } from '@common/errors';
import { MAIN_VIEW_COMMANDS } from '@common/webview';

// Local imports - logger
import * as logger from '@logger/logUtils';
import { StorageFS } from '@utils/files';
import { THREE_DAYS_MS } from '@utils/config';
import { PASTED_DIR } from '@utils/files/pastedImageUtils';
import {
  polishTextWithAI,
  FileContext,
} from '@utils/text/textEnhancementUtils';
import { BaseWebviewManager } from './BaseWebviewManager';

// Local imports - types
import type {
  PolishInstructionMessage,
  ClipboardImageMessage,
} from '../types/messages';

const CHANNEL = 'InstructionManager';
logger.initialize(CHANNEL);

export class InstructionManager extends BaseWebviewManager {
  protected readonly channel = CHANNEL;

  constructor(_context: vscode.ExtensionContext) {
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
      // Build file context, filtering out empty/placeholder values
      const isValid = (f?: string): f is string =>
        !!f && f !== 'None' && f !== '';
      const hasFiles = (active: boolean, files?: string[]) =>
        active && Array.isArray(files) && files.length > 0;

      const fileContext: FileContext = {
        agent: message.agent,
        ...(isValid(message.inputFile) && { inputFile: message.inputFile }),
        ...(isValid(message.referenceFile) && {
          referenceFile: message.referenceFile,
        }),
        ...(isValid(message.auxiliaryFile) && {
          auxiliaryFile: message.auxiliaryFile,
        }),
        ...(isValid(message.mediaFile) && { mediaFile: message.mediaFile }),
        ...(hasFiles(!!message.inputFilesActive, message.inputFiles) && {
          inputFiles: message.inputFiles,
        }),
        ...(hasFiles(!!message.referenceFilesActive, message.referenceFiles) && {
          referenceFiles: message.referenceFiles,
        }),
        ...(hasFiles(!!message.auxiliaryFilesActive, message.auxiliaryFiles) && {
          auxiliaryFiles: message.auxiliaryFiles,
        }),
        ...(hasFiles(!!message.mediaFilesActive, message.mediaFiles) && {
          mediaFiles: message.mediaFiles,
        }),
        ...(hasFiles(!!message.outputFilesActive, message.outputFiles) && {
          outputFiles: message.outputFiles,
        }),
      };

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
      await StorageFS.ensureDir(PASTED_DIR);
      const relativePath = path.join(PASTED_DIR, fileName);
      await StorageFS.write(relativePath, Buffer.from(base64, 'base64'));
      await StorageFS.cleanupOldFiles(PASTED_DIR, THREE_DAYS_MS);
      this.postMessage({
        command: MAIN_VIEW_COMMANDS.ADD_MEDIA_FILE,
        file: fileName,
      });
    } catch (err) {
      logger.error(
        CHANNEL,
        `Error handling clipboard image: ${toErrorMessage(err)}`,
      );
    }
  }
}
