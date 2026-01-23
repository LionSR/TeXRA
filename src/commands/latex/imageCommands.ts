// Third-party imports
import * as vscode from 'vscode';

// Local imports - errors
import { showLoggedErrorMessage } from '@common/errors';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
} from '@frontend/media/img';
import * as dialogUtils from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

const PDF_FILTERS = { 'PDF files': ['pdf'] };

function logTruncatedBase64(base64String: string): void {
  const truncated = base64String.substring(0, 100);
  logger.debug(
    CHANNEL,
    `Truncated base64 string (first 100 chars): ${truncated}...`,
  );
}

export function registerImageCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.countPdfPages', handleCountPdfPages),
    vscode.commands.registerCommand(
      'texra.encodeImageToBase64',
      handleEncodeImageToBase64,
    ),
    vscode.commands.registerCommand(
      'texra.convertPdfToImages',
      handleConvertPdfToImages,
    ),
  );
}

async function handleCountPdfPages(): Promise<void> {
  try {
    const selection = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select PDF file',
      filters: PDF_FILTERS,
    });
    if (!selection) {
      return;
    }

    logger.debug(
      CHANNEL,
      `Processing PDF file: ${selection.relativePath} (resolved: ${selection.absolutePath})`,
    );

    const pageCount = await countPdfPages(selection.relativePath);
    if (pageCount > 0) {
      vscode.window.showInformationMessage(`The PDF has ${pageCount} pages`);
      return;
    }

    vscode.window.showErrorMessage('Could not count pages in the PDF');
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'countPdfPages command failed', err);
  }
}

async function handleEncodeImageToBase64(): Promise<string | undefined> {
  try {
    const selection = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select file',
      filters: {
        'Image files': ['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp'],
        'Audio files': ['wav', 'm4a', 'mp3', 'aiff', 'aac', 'ogg', 'flac'],
      },
    });

    if (!selection) {
      return undefined;
    }

    logger.debug(
      CHANNEL,
      `Processing image file: ${selection.relativePath} (resolved: ${selection.absolutePath})`,
    );

    const base64String = await getBase64EncodedMedia(selection.relativePath);
    logTruncatedBase64(base64String);
    return base64String;
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'encodeImageToBase64 command failed',
      err,
    );
    return undefined;
  }
}

async function handleConvertPdfToImages(): Promise<
  string[] | string | undefined
> {
  try {
    const selection = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select PDF file',
      filters: PDF_FILTERS,
    });
    if (!selection) {
      return undefined;
    }

    logger.debug(
      CHANNEL,
      `Processing PDF file: ${selection.relativePath} (resolved: ${selection.absolutePath})`,
    );

    // Get quality from user
    const quality = await vscode.window.showInputBox({
      prompt: 'Enter quality (DPI) for conversion (default: 300)',
      value: '300',
      validateInput: (value) => {
        const num = parseInt(value);
        return num > 0 && num <= 600
          ? null
          : 'Please enter a number between 1 and 600';
      },
    });

    if (!quality) {
      return undefined;
    }

    // Get max pages from user
    const maxPages = await vscode.window.showInputBox({
      prompt: 'Enter maximum number of pages to convert (default: all)',
      validateInput: (value) => {
        if (!value) {
          return null;
        }
        const num = parseInt(value);
        return num > 0 ? null : 'Please enter a positive number';
      },
    });

    const result = await processPdf2Png(
      selection.relativePath,
      maxPages ? parseInt(maxPages) : undefined,
      parseInt(quality),
    );

    if (result) {
      vscode.window.showInformationMessage(
        'PDF conversion completed successfully',
      );
      return result;
    }

    vscode.window.showErrorMessage('Failed to convert PDF');
    return undefined;
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'convertPdfToImages command failed',
      err,
    );
    return undefined;
  }
}

