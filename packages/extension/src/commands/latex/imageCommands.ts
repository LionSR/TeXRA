// Third-party imports
import * as vscode from 'vscode';

// Local imports - errors
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import * as dialogUtils from '@frontend/ui/dialogs';
import * as logger from '@logger/logUtils';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
} from '@utils/media/img';

const CHANNEL = 'TestCommands';

const PDF_FILTERS = { 'PDF files': ['pdf'] };

export async function handleCountPdfPages(): Promise<void> {
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

    void showLoggedMessage(CHANNEL, 'Could not count pages in the PDF');
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'countPdfPages command failed', err);
  }
}

export async function handleEncodeImageToBase64(): Promise<string | undefined> {
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
    logger.debug(
      CHANNEL,
      `Truncated base64 string (first 100 chars): ${base64String.slice(0, 100)}...`,
    );
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

export async function handleConvertPdfToImages(): Promise<
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
        const num = Number.parseInt(value, 10);
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
        const num = Number.parseInt(value, 10);
        return num > 0 ? null : 'Please enter a positive number';
      },
    });

    const result = await processPdf2Png(
      selection.relativePath,
      maxPages ? Number.parseInt(maxPages, 10) : undefined,
      Number.parseInt(quality, 10),
    );

    if (result) {
      vscode.window.showInformationMessage(
        'PDF conversion completed successfully',
      );
      return result;
    }

    void showLoggedMessage(CHANNEL, 'Failed to convert PDF');
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
