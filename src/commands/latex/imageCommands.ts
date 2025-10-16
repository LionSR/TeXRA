// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import * as dialogUtils from '@utils/dialogs';
import { WorkspaceFS } from '@utils/files';
import {
  countPdfPages,
  getBase64EncodedMedia,
  processPdf2Png,
  singlePagePdf2Png,
} from '@frontend/media/img';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

interface PdfSelectionResult {
  relativePath: string;
  absolutePath: string;
}

/**
 * Prompts the user to select a PDF file within the current workspace.
 * Returns both the workspace-relative and absolute paths for downstream
 * consumers. Returns null when the workspace is unavailable or the user
 * cancels the dialog.
 */
export async function selectPdfFileFromWorkspace(): Promise<PdfSelectionResult | null> {
  if (!WorkspaceFS.getPath()) {
    vscode.window.showErrorMessage('No workspace folder open');
    return null;
  }

  const relativePath = await dialogUtils.selectFile({
    openLabel: 'Select PDF file',
    filters: {
      'PDF files': ['pdf'],
    },
  });

  if (!relativePath) {
    return null;
  }

  const absolutePath = WorkspaceFS.fullPath(relativePath);
  return { relativePath, absolutePath };
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
    vscode.commands.registerCommand(
      'texra.testPdfToImage',
      handleTestPdfToImage,
    ),
  );
}

async function handleCountPdfPages(): Promise<void> {
  try {
    const selection = await selectPdfFileFromWorkspace();
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
    logger.error(
      CHANNEL,
      `Error in countPdfPages command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error counting PDF pages');
  }
}

async function handleEncodeImageToBase64(): Promise<string | undefined> {
  try {
    const selectedFile = await dialogUtils.selectFile({
      openLabel: 'Select file',
      filters: {
        'Image files': ['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp'],
        'Audio files': ['wav', 'm4a', 'mp3', 'aiff', 'aac', 'ogg', 'flac'],
      },
    });

    if (!selectedFile) {
      return undefined;
    }

    logger.debug(CHANNEL, `Processing image file: ${selectedFile}`);

    const base64String = await getBase64EncodedMedia(selectedFile);

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
    const selection = await selectPdfFileFromWorkspace();
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
    const selection = await selectPdfFileFromWorkspace();
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
