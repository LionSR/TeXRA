// Third-party imports
import * as vscode from 'vscode';

// Local imports - errors
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import * as dialogUtils from '@utils/dialogs';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
  singlePagePdf2Png,
} from '@frontend/media/img';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

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
    vscode.commands.registerCommand(
      'texra.testPdfToImage',
      handleTestPdfToImage,
    ),
  );
}

async function handleCountPdfPages(): Promise<void> {
  try {
    const selection = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select PDF file',
      filters: {
        'PDF files': ['pdf'],
      },
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
    } else {
      vscode.window.showErrorMessage('Could not count pages in the PDF');
    }
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'countPdfPages command failed',
      err,
    );
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

    // Also show a truncated version in the debug log for quick verification
    const truncatedString = base64String.substring(0, 100) + '...';
    logger.debug(
      CHANNEL,
      `Truncated base64 string (first 100 chars): ${truncatedString}`,
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

async function handleConvertPdfToImages(): Promise<
  string[] | string | undefined
> {
  try {
    const selection = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select PDF file',
      filters: {
        'PDF files': ['pdf'],
      },
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
    } else {
      vscode.window.showErrorMessage('Failed to convert PDF');
      return undefined;
    }
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'convertPdfToImages command failed',
      err,
    );
    return undefined;
  }
}

async function handleTestPdfToImage(): Promise<string | undefined> {
  try {
    const selection = await dialogUtils.selectFileFromWorkspace({
      openLabel: 'Select PDF file',
      filters: {
        'PDF files': ['pdf'],
      },
    });
    if (!selection) {
      return undefined;
    }

    logger.debug(
      CHANNEL,
      `Testing PDF to PNG conversion for: ${selection.relativePath} (resolved: ${selection.absolutePath})`,
    );

    // Get page number from user
    const pageNum = await vscode.window.showInputBox({
      prompt: 'Enter page number to convert (1-based, default: 1)',
      value: '1',
      validateInput: (value) => {
        const num = parseInt(value);
        return num > 0 ? null : 'Please enter a positive number';
      },
    });

    if (pageNum === undefined) {
      return undefined;
    }

    // Convert single page
    const base64String = await singlePagePdf2Png(
      selection.relativePath,
      parseInt(pageNum),
      300,
      [1024, 1024],
    );

    // Show truncated result in debug log
    const truncatedString = base64String.substring(0, 100) + '...';
    logger.debug(
      CHANNEL,
      `Truncated base64 string (first 100 chars): ${truncatedString}`,
    );

    vscode.window.showInformationMessage(
      `Successfully converted page ${pageNum} of ${selection.relativePath} to PNG`,
    );

    return base64String;
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      'testPdfToImage command failed',
      err,
    );

    if (
      err instanceof Error &&
      err.message.includes('GraphicsMagick/ImageMagick is not installed')
    ) {
      void vscode.window
        .showInformationMessage(
          'GraphicsMagick/ImageMagick is required for PDF conversion. Open the download page?',
          'Open Download Page',
        )
        .then((selection) => {
          if (selection === 'Open Download Page') {
            void vscode.env.openExternal(
              vscode.Uri.parse('http://www.graphicsmagick.org/download.html'),
            );
          }
        });
    }
    return undefined;
  }
}

export const imageCommands = {
  handleCountPdfPages,
  handleEncodeImageToBase64,
  handleConvertPdfToImages,
  handleTestPdfToImage,
};
