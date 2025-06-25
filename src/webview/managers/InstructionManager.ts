// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import * as path from 'path';

import { StorageFS } from '@utils/files';
import { PASTED_DIR } from '@utils/files/pastedImageUtils';
import {
  polishTextWithAI,
  FileContext,
} from '@utils/text/textEnhancementUtils';
import { sleep } from '@utils/helpers';

const CHANNEL = 'InstructionManager';
logger.initialize(CHANNEL);

export class InstructionManager {
  constructor(private readonly _context: vscode.ExtensionContext) {
    setTimeout(() => {
      StorageFS.ensureDir(PASTED_DIR)
        .then(() =>
          StorageFS.cleanupOldFiles(PASTED_DIR, 3 * 24 * 60 * 60 * 1000),
        )
        .catch((e) =>
          logger.warn(
            CHANNEL,
            `Error during initial cleanup: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }, 100);
  }

  async handlePolishInstructionText(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    try {
      const fileContext: FileContext = { agent: message.agent || undefined };
      const isValidFile = (file?: string): boolean =>
        !!file && file !== 'None' && file !== '';
      const addSingleFileIfValid = (
        contextKey: keyof FileContext,
        messageKey: string,
      ) => {
        if (isValidFile(message[messageKey])) {
          (fileContext as any)[contextKey] = message[messageKey];
        }
      };
      const addMultipleFilesIfValid = (
        contextKey: keyof FileContext,
        toggleKey: string,
      ) => {
        if (
          message[toggleKey] &&
          message[contextKey] &&
          Array.isArray(message[contextKey]) &&
          message[contextKey].length > 0
        ) {
          (fileContext as any)[contextKey] = message[contextKey];
        }
      };

      addSingleFileIfValid('inputFile', 'inputFile');
      addSingleFileIfValid('referenceFile', 'referenceFile');
      addSingleFileIfValid('auxiliaryFile', 'auxiliaryFile');
      addSingleFileIfValid('mediaFile', 'mediaFile');
      addMultipleFilesIfValid('inputFiles', 'inputFilesActive');
      addMultipleFilesIfValid('referenceFiles', 'referenceFilesActive');
      addMultipleFilesIfValid('auxiliaryFiles', 'auxiliaryFilesActive');
      addMultipleFilesIfValid('mediaFiles', 'mediaFilesActive');
      addMultipleFilesIfValid('outputFiles', 'outputFilesActive');

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Polishing your instruction text',
          cancellable: false,
        },
        async (progress) => {
          try {
            progress.report({ message: 'Preparing text and context...' });
            await sleep(300);
            progress.report({
              message: 'Sending to AI for polishing...',
              increment: 30,
            });
            const result = await polishTextWithAI(message.text, fileContext);
            progress.report({ message: 'Applying changes...', increment: 60 });
            await sleep(300);
            if (result.success) {
              webviewView.webview.postMessage({
                command: 'instructionTextPolished',
                text: result.text,
              });
            } else {
              vscode.window.showErrorMessage(
                result.error || 'Error polishing text',
              );
            }
          } catch (error) {
            vscode.window.showErrorMessage(
              `Error polishing text: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
            logger.error(
              CHANNEL,
              `Error in handlePolishInstructionText: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error setting up text polishing: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      logger.error(
        CHANNEL,
        `Error setting up text polishing: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  handleTranscribeInstruction(_view: vscode.WebviewView): void {
    vscode.window.showInformationMessage(
      'Please use the new recording interface with start/stop controls.',
    );
  }

  async handleClipboardImage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    try {
      const { base64, mediaType, fileName } = message;
      if (!base64 || !mediaType || !fileName) {
        return;
      }
      await StorageFS.ensureDir(PASTED_DIR);
      const relativePath = path.join(PASTED_DIR, fileName);
      await StorageFS.write(relativePath, Buffer.from(base64, 'base64'));
      await StorageFS.cleanupOldFiles(PASTED_DIR, 3 * 24 * 60 * 60 * 1000);
      webviewView.webview.postMessage({
        command: 'addMediaFile',
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
