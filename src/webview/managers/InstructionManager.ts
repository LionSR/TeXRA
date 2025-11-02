// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utils
import { StorageFS } from '@utils/files';
import { PASTED_DIR } from '@utils/files/pastedImageUtils';
import { THREE_DAYS_MS } from '@utils/config';
import { sleep } from '@utils/helpers';
import {
  polishTextWithAI,
  FileContext,
} from '@utils/text/textEnhancementUtils';

const CHANNEL = 'InstructionManager';
logger.initialize(CHANNEL);

export class InstructionManager {
  private webview: vscode.WebviewView | undefined;

  constructor(private readonly _context: vscode.ExtensionContext) {
    setTimeout(() => {
      StorageFS.ensureDir(PASTED_DIR)
        .then(() => StorageFS.cleanupOldFiles(PASTED_DIR, THREE_DAYS_MS))
        .catch((e) =>
          logger.warn(
            CHANNEL,
            `Error during initial cleanup: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }, 100);
  }

  attachWebview(webviewView: vscode.WebviewView): void {
    this.webview = webviewView;
  }

  private getWebview(): vscode.WebviewView | undefined {
    if (!this.webview) {
      logger.warn(CHANNEL, 'Webview not attached for InstructionManager');
      return undefined;
    }

    return this.webview;
  }

  /**
   * Validate that the given file path is a non-empty value.
   */
  private _isValidFile(file?: string): boolean {
    return !!file && file !== 'None' && file !== '';
  }

  /**
   * Add a single file to the context when it passes validation.
   */
  private _addSingleFileIfValid(
    context: FileContext,
    contextKey: keyof FileContext,
    file?: string,
  ): void {
    if (this._isValidFile(file)) {
      (context as any)[contextKey] = file;
    }
  }

  /**
   * Add a list of files to the context when they are enabled and present.
   */
  private _addMultipleFilesIfValid(
    context: FileContext,
    contextKey: keyof FileContext,
    active: boolean,
    files?: string[],
  ): void {
    if (active && files?.length) {
      (context as any)[contextKey] = files;
    }
  }

  async handlePolishInstructionText(message: any): Promise<void> {
    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }
    try {
      const fileContext: FileContext = { agent: message.agent || undefined };

      const singleFileMap: Array<[keyof FileContext, keyof typeof message]> = [
        ['inputFile', 'inputFile'],
        ['referenceFile', 'referenceFile'],
        ['auxiliaryFile', 'auxiliaryFile'],
        ['mediaFile', 'mediaFile'],
      ];
      for (const [contextKey, messageKey] of singleFileMap) {
        this._addSingleFileIfValid(
          fileContext,
          contextKey,
          (message as any)[messageKey],
        );
      }

      const multiFileMap: Array<
        [keyof FileContext, keyof typeof message, keyof typeof message]
      > = [
        ['inputFiles', 'inputFilesActive', 'inputFiles'],
        ['referenceFiles', 'referenceFilesActive', 'referenceFiles'],
        ['auxiliaryFiles', 'auxiliaryFilesActive', 'auxiliaryFiles'],
        ['mediaFiles', 'mediaFilesActive', 'mediaFiles'],
        ['outputFiles', 'outputFilesActive', 'outputFiles'],
      ];
      for (const [contextKey, toggleKey, messageKey] of multiFileMap) {
        this._addMultipleFilesIfValid(
          fileContext,
          contextKey,
          (message as any)[toggleKey],
          (message as any)[messageKey],
        );
      }

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
            error: result.error || 'Error polishing text',
          });
        }
      } catch (error) {
        webviewView.webview.postMessage({
          command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
          error:
            error instanceof Error ? error.message : 'Unknown error occurred',
        });
        logger.error(
          CHANNEL,
          `Error in handlePolishInstructionText: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } catch (error) {
      webviewView.webview.postMessage({
        command: MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR,
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
      });
      logger.error(
        CHANNEL,
        `Error setting up text polishing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  handleTranscribeInstruction(): void {
    vscode.window.showInformationMessage(
      'Please use the new recording interface with start/stop controls.',
    );
  }

  async handleClipboardImage(message: any): Promise<void> {
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
        `Error handling clipboard image: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
