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

// Local imports - schemas (single source of truth)
import {
  PolishInstructionMessageSchema,
  ClipboardImageMessageSchema,
} from '../types/messages';

const CHANNEL = 'InstructionManager';
logger.initialize(CHANNEL);

export class InstructionManager {
  private webview: vscode.WebviewView | undefined;

  constructor(private readonly _context: vscode.ExtensionContext) {
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

  async handlePolishInstructionText(message: unknown): Promise<void> {
    const parsed = PolishInstructionMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.debug(CHANNEL, 'Invalid polish instruction message', {
        data: parsed.error,
      });
      return;
    }

    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }

    const msg = parsed.data;
    try {
      const fileContext: FileContext = { agent: msg.agent };

      // Add single files
      this.addSingleFileIfValid(fileContext, 'inputFile', msg.inputFile);
      this.addSingleFileIfValid(
        fileContext,
        'referenceFile',
        msg.referenceFile,
      );
      this.addSingleFileIfValid(
        fileContext,
        'auxiliaryFile',
        msg.auxiliaryFile,
      );
      this.addSingleFileIfValid(fileContext, 'mediaFile', msg.mediaFile);

      // Add multiple files
      this.addMultipleFilesIfValid(
        fileContext,
        'inputFiles',
        !!msg.inputFilesActive,
        msg.inputFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'referenceFiles',
        !!msg.referenceFilesActive,
        msg.referenceFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'auxiliaryFiles',
        !!msg.auxiliaryFilesActive,
        msg.auxiliaryFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'mediaFiles',
        !!msg.mediaFilesActive,
        msg.mediaFiles,
      );
      this.addMultipleFilesIfValid(
        fileContext,
        'outputFiles',
        !!msg.outputFilesActive,
        msg.outputFiles,
      );

      try {
        const result = await polishTextWithAI(msg.text, fileContext);
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

  async handleClipboardImage(message: unknown): Promise<void> {
    const parsed = ClipboardImageMessageSchema.safeParse(message);
    if (!parsed.success) {
      logger.debug(CHANNEL, 'Invalid clipboard image message', {
        data: parsed.error,
      });
      return;
    }

    const webviewView = this.getWebview();
    if (!webviewView) {
      return;
    }

    try {
      const { base64, mediaType, fileName } = parsed.data;
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
