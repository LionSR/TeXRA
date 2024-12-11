import * as vscode from 'vscode';
import { extractFigurePathsFromLatex } from '../utils/figUtils';
import { debug, error, initializeLogging } from '../utils/logUtils';
import { getRelativePath } from '../utils/fileUtils';

const CHANNEL = 'FigureCommands';
initializeLogging(CHANNEL);

export function registerFigureCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'coauthor.extractFigurePaths',
            handleExtractFigurePaths
        )
    );
    debug(CHANNEL, 'Figure commands registered');
}

async function handleExtractFigurePaths(): Promise<void> {
    try {
        // Get active editor
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Please open a LaTeX file first');
            return;
        }

        // Check if it's a LaTeX file
        if (!editor.document.fileName.toLowerCase().endsWith('.tex')) {
            vscode.window.showWarningMessage('This command only works with LaTeX files');
            return;
        }

        const filePath = getRelativePath(editor.document.fileName);
        debug(CHANNEL, `Processing LaTeX file: ${filePath}`);

        // Extract figure paths
        const figurePaths = await extractFigurePathsFromLatex(filePath);

        if (figurePaths.length > 0) {
            // Show results in QuickPick
            const selected = await vscode.window.showQuickPick(figurePaths, {
                placeHolder: 'Found figures (select to copy path)',
                canPickMany: false
            });

            if (selected) {
                await vscode.env.clipboard.writeText(selected);
                vscode.window.showInformationMessage(`Copied figure path: ${selected}`);
            }
        } else {
            vscode.window.showInformationMessage('No figures found in the current file');
        }

    } catch (err) {
        error(CHANNEL, `Error in extractFigurePaths command: ${err instanceof Error ? err.message : String(err)}`);
        vscode.window.showErrorMessage('Error extracting figure paths');
    }
}

export const figureCommands = {
    handleExtractFigurePaths
};
