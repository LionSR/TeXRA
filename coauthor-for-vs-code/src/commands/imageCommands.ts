import * as vscode from 'vscode';
import { countPdfPages, getBase64EncodedImage } from '../utils/imgUtils';
import { debug, error, initializeLogging } from '../utils/logUtils';
import { getRelativePath } from '../utils/fileUtils';

const CHANNEL = 'ImageCommands';
initializeLogging(CHANNEL);

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
  );
  debug(CHANNEL, 'Image commands registered');
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
    debug(CHANNEL, `Processing PDF file: ${selectedFile}`);

    const pageCount = await countPdfPages(selectedFile);
    if (pageCount > 0) {
      vscode.window.showInformationMessage(`The PDF has ${pageCount} pages`);
    } else {
      vscode.window.showErrorMessage('Could not count pages in the PDF');
    }
  } catch (err) {
    error(
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
    debug(CHANNEL, `Processing image file: ${selectedFile}`);

    const base64String = await getBase64EncodedImage(selectedFile);
        
    // Also show a truncated version in the debug log for quick verification
    const truncatedString = base64String.substring(0, 100) + '...';
    debug(CHANNEL, `Truncated base64 string (first 100 chars): ${truncatedString}`);
    
    return base64String;
  } catch (err) {
    error(
      CHANNEL,
      `Error in encodeImageToBase64 command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error encoding image to base64');
    return undefined;
  }
}

export const imageCommands = {
  handleCountPdfPages,
  handleEncodeImageToBase64,
};
