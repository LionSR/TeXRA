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

  /**
   * Validate that the given file path is a non-empty value.
   * Type guard to ensure file is a string.
   */
  private isValidFile(file?: string): file is string {
    return !!file && file !== 'None' && file !== '';
  }

  /**
   * Add a single file to the context when it passes validation.
   */
  private addSingleFileIfValid(
    context: FileContext,
    contextKey: 'inputFile' | 'referenceFile' | 'auxiliaryFile' | 'mediaFile',
    file?: string,
  ): void {
    if (this.isValidFile(file)) {
      context[contextKey] = file;
    }
  }

  /**
   * Add a list of files to the context when they are enabled and present.
   */
  private addMultipleFilesIfValid(
    context: FileContext,
    contextKey:
      | 'inputFiles'
      | 'referenceFiles'
      | 'auxiliaryFiles'
      | 'mediaFiles'
      | 'outputFiles',
    active: boolean,
    files?: string[],
  ): void {
    if (active && Array.isArray(files) && files.length > 0) {
      context[contextKey] = files;
    }
  }

  async handlePolishInstructionText(
    message: PolishInstructionMessage,
  ): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    try {
      const fileContext: FileContext = { agent: message.agent };

      // Add single files
      this.addSingleFileIfValid(fileContext, 'inputFile', message.inputFile);
      this.addSingleFileIfValid(
        fileContext,
        'referenceFile',
        message.referenceFile,
      );
      this.addSingleFileIfValid(
        fileContext,
        'auxiliaryFile',
        message.auxiliaryFile,
      );
      this.addSingleFileIfValid(fileContext, 'mediaFile', message.mediaFile);

      // Add multiple files
      this.addMultipleFilesIfValid(
        fileContext,
        'inputFiles',
        !!message.inputFilesActive,
        message.inputFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'referenceFiles',
        !!message.referenceFilesActive,
        message.referenceFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'auxiliaryFiles',
        !!message.auxiliaryFilesActive,
        message.auxiliaryFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'mediaFiles',
        !!message.mediaFilesActive,
        message.mediaFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'outputFiles',
        !!message.outputFilesActive,
        message.outputFiles,
      );

      try {
        const result = await polishTextWithAI(message.text, fileContext);
        if (result.success) {
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED,
            text: result.text,
          });
        } else {
          webviewView.webview.postMessage({
            command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
            error: result.error ?? 'Error polishing text',
          });
        }
      } catch (error) {
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
          error: toErrorMessage(error),
        });
        logger.error(
          CHANNEL,
          `Error in handlePolishInstructionText: ${toErrorMessage(error)}`,
        );
      }
    } catch (error) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
        error: toErrorMessage(error),
      });
      logger.error(
        CHANNEL,
        `Error setting up text polishing: ${toErrorMessage(error)}`,
      );
    }
  }

  handleTranscribeInstruction(): void {
    vscode.window.showInformationMessage(
      'Please use the new recording interface with start/stop controls.',
    );
  }

  async handleClipboardImage(message: ClipboardImageMessage): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
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
      webviewView.webview.postMessage({
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
