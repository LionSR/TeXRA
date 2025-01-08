// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getRelativePath } from '../utils/fileUtils';
import {
  countPdfPages,
  getBase64EncodedImage,
  processPdfInput,
  singlePagePdf2Png,
} from '../utils/imgUtils';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export function registerImageCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.countPdfPages',
      handleCountPdfPages,
    ),
    vscode.commands.registerCommand(
      'coauthor.encodeImageToBase64',
      handleEncodeImageToBase64,
    ),
    vscode.commands.registerCommand(
      'coauthor.convertPdfToImages',
      handleConvertPdfToImages,
    ),
    vscode.commands.registerCommand(
      'coauthor.testPdfToImage',
      handleTestPdfToImage,
    ),
  );
}

async function handleCountPdfPages(): Promise<void> {
  try {
    // Open file picker dialog
    const fileUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'PDF files': ['pdf'],
      },
      title: 'Select PDF file to count pages',
    });

    if (!fileUris || fileUris.length === 0) {
      return;
    }

    const selectedFile = getRelativePath(fileUris[0].fsPath);
    logger.debug(CHANNEL, `Processing PDF file: ${selectedFile}`);

    const pageCount = await countPdfPages(selectedFile);
    if (pageCount > 0) {
      vscode.window.showInformationMessage(`The PDF has ${pageCount} pages`);
    } else {
      vscode.window.showErrorMessage('Could not count pages in the PDF');
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in countPdfPages command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error counting PDF pages');
  }
}

async function handleEncodeImageToBase64(): Promise<string | undefined> {
  try {
    // Open file picker dialog
    const fileUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'Image files': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg'],
      },
      title: 'Select image file to encode',
    });

    if (!fileUris || fileUris.length === 0) {
      return undefined;
    }

    const selectedFile = getRelativePath(fileUris[0].fsPath);
    logger.debug(CHANNEL, `Processing image file: ${selectedFile}`);

    const base64String = await getBase64EncodedImage(selectedFile);

    // Also show a truncated version in the debug log for quick verification
    const truncatedString = base64String.substring(0, 100) + '...';
    logger.debug(
      CHANNEL,
      `Truncated base64 string (first 100 chars): ${truncatedString}`,
    );

    return base64String;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in encodeImageToBase64 command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error encoding image to base64');
    return undefined;
  }
}

async function handleConvertPdfToImages(): Promise<
  string[] | string | undefined
> {
  try {
    // Open file picker dialog
    const fileUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'PDF files': ['pdf'],
      },
      title: 'Select PDF file to convert to images',
    });

    if (!fileUris || fileUris.length === 0) {
      return undefined;
    }

    const selectedFile = getRelativePath(fileUris[0].fsPath);
    logger.debug(CHANNEL, `Processing PDF file: ${selectedFile}`);

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
        if (!value) return null;
        const num = parseInt(value);
        return num > 0 ? null : 'Please enter a positive number';
      },
    });

    const result = await processPdfInput(
      selectedFile,
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
    logger.error(
      CHANNEL,
      `Error in convertPdfToImages command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error converting PDF to images');
    return undefined;
  }
}

async function handleTestPdfToImage(): Promise<string | undefined> {
  try {
    // Open file picker dialog
    const fileUris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'PDF files': ['pdf'],
      },
      title: 'Select PDF file to test conversion',
    });

    if (!fileUris || fileUris.length === 0) {
      return undefined;
    }

    const selectedFile = getRelativePath(fileUris[0].fsPath);
    logger.debug(CHANNEL, `Testing PDF to PNG conversion for: ${selectedFile}`);

    // Get page number from user
    const pageNum = await vscode.window.showInputBox({
      prompt: 'Enter page number to convert (0-based, default: 0)',
      value: '0',
      validateInput: (value) => {
        const num = parseInt(value);
        return num >= 0 ? null : 'Please enter a non-negative number';
      },
    });

    if (pageNum === undefined) {
      return undefined;
    }

    // Convert single page
    const base64String = await singlePagePdf2Png(
      selectedFile,
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
      `Successfully converted page ${pageNum} of ${selectedFile} to PNG`,
    );

    return base64String;
  } catch (err) {
    if (err instanceof Error) {
      logger.error(CHANNEL, `Error in testPdfToImage command: ${err.message}`);
      logger.error(CHANNEL, `Error stack: ${err.stack}`); // Print stack trace
    } else {
      logger.error(CHANNEL, `Error in testPdfToImage command: ${String(err)}`);
    }

    // Show a more detailed error message if it's about missing dependencies
    if (
      err instanceof Error &&
      err.message.includes('GraphicsMagick/ImageMagick is not installed')
    ) {
      vscode.window
        .showErrorMessage(err.message, 'More Info')
        .then((selection) => {
          if (selection === 'More Info') {
            vscode.env.openExternal(
              vscode.Uri.parse('http://www.graphicsmagick.org/download.html'),
            );
          }
        });
    } else {
      vscode.window.showErrorMessage('Error converting PDF to PNG');
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
