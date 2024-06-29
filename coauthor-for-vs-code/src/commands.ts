import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ensureTerminal } from './terminal';
import { CoAuthorViewProvider } from './viewProvider';
import * as path from 'path';

export function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.selectMultipleFiles', async (currentInputFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const defaultUri = currentInputFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentInputFile)))
        : vscode.Uri.file(workspacePath);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Files',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex']
        }
      });
      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => path.relative(workspacePath, uri.fsPath));
        vscode.window.showInformationMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleAuxFiles', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Auxiliary Files',
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
          'Text files': ['txt', 'tex', 'cls']
        }
      });
      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => path.relative(workspacePath, uri.fsPath));
        vscode.window.showInformationMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleFigures', async (currentFigureFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      // Get the configuration
      const config = vscode.workspace.getConfiguration('coauthor');
      const includeDirectories = config.get<string[]>('includedDirectories') || ['Discrete-Time', 'FiguresEx'];

      const defaultUri = currentFigureFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentFigureFile)))
        : vscode.Uri.file(workspacePath);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Figures',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Image files': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'pdf']
        }
      });

      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => {
          const relativePath = path.relative(workspacePath, uri.fsPath);
          const pathParts = relativePath.split(path.sep);

          const startIndex = pathParts.findIndex(part => includeDirectories.includes(part));

          if (startIndex !== -1) {
            return pathParts.slice(startIndex).join(path.sep);
          }

          return relativePath;
        });

        vscode.window.showInformationMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.packSingle', (inputFilePath: string, task: string, reflect: string, model: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText(`coauthor pack-single ${inputFilePath} --task=${task} --reflect=${reflect} --model=${model}`);
    }),
    vscode.commands.registerCommand('coauthor.packLatexDiffVC', async (inputFilePath: string, commitHash: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText(`coauthor pack-latexdiff-vc ${inputFilePath} ${commitHash}`);
    }),
    vscode.commands.registerCommand('coauthor.cleanOutput', () => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText("coauthor clean-output");
    }),
    vscode.commands.registerCommand('coauthor.cleanBuild', () => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText("coauthor clean-build");
    }),
    vscode.commands.registerCommand('coauthor.indentTex', () => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText("coauthor indent-tex");
    }),
    vscode.commands.registerCommand('coauthor.cleanSingle', (inputFilePath: string, task: string, reflect: string, model: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      terminal.sendText(`coauthor clean-single ${inputFilePath} --task=${task} --reflect=${reflect} --model=${model}`);
    }),
    vscode.commands.registerCommand('coauthor.latexDiff', (inputFilePath: string, revisionFilePath: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const revisionFileName = revisionFilePath.split('/').pop();
      const baseName = revisionFileName?.split('.').slice(0, -1).join('.');
      const diffFileName = `${baseName}_diff.tex`;
      const inputSubdirectory = inputFilePath.substring(0, inputFilePath.lastIndexOf('/'));
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      terminal.sendText(`coauthor latexdiff ${inputFilePath} ${revisionFilePath}`);

      // Wait for the command to execute and the file to be generated
      setTimeout(async () => {
        try {
          await vscode.workspace.fs.stat(fullPath);
          vscode.window.showTextDocument(fullPath);
          await vscode.commands.executeCommand('workbench.view.extension.latex-workshop-activitybar');
          await vscode.commands.executeCommand('latex-workshop.build');
          setTimeout(async () => {
            await vscode.commands.executeCommand('latex-workshop.view');
          }, 5000); // Adjust the delay based on expected build time
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            vscode.window.showErrorMessage('Diff file could not be found. Expected path: ' + fullPath.fsPath);
          } else if (error instanceof Error) {
            vscode.window.showErrorMessage('An error occurred: ' + error.message);
          } else {
            vscode.window.showErrorMessage('An unknown error occurred.');
          }
        }
      }, 2000); // Adjust delay as needed based on expected command execution time
    }),
    vscode.commands.registerCommand('coauthor.latexDiffVC', async (inputFilePath: string, commitHash: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const inputFileName = inputFilePath.split('/').pop();
      const baseName = inputFileName?.split('.').slice(0, -1).join('.');
      const diffFileName = `${baseName}-diff${commitHash}.tex`;
      const inputSubdirectory = inputFilePath.substring(0, inputFilePath.lastIndexOf('/'));
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      // terminal.sendText(`latexdiff-vc --force --flatten --git -r ${commitHash} ${inputFilePath}`);
      terminal.sendText(`coauthor latexdiff-vc ${inputFilePath} ${commitHash}`);

      // Wait for the command to execute and the file to be generated
      setTimeout(async () => {
        try {
          await vscode.workspace.fs.stat(fullPath);
          vscode.window.showTextDocument(fullPath);
          await vscode.commands.executeCommand('workbench.view.extension.latex-workshop-activitybar');
          await vscode.commands.executeCommand('latex-workshop.build');
          setTimeout(async () => {
            await vscode.commands.executeCommand('latex-workshop.view');
          }, 5000); // Adjust the delay based on expected build time
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
            vscode.window.showErrorMessage('Diff file could not be found. Expected path: ' + fullPath.fsPath);
          } else if (error instanceof Error) {
            vscode.window.showErrorMessage('An error occurred: ' + error.message);
          } else {
            vscode.window.showErrorMessage('An unknown error occurred.');
          }
        }
      }, 2000); // Adjust delay as needed based on expected command execution time
    }),
    vscode.commands.registerCommand('coauthor.getRecentCommits', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        return new Promise<string[]>((resolve, reject) => {
          exec('git log -n 20 --pretty=format:"%h: %s"', { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
              vscode.window.showErrorMessage(`Error fetching commits: ${stderr}`);
              reject(stderr);
            } else {
              const commits = stdout.split('\n').map(line => line.trim());
              // Add "HEAD" as the first option
              commits.unshift("HEAD");
              resolve(commits);
            }
          });
        });
      }
      return [];
    }),
    vscode.commands.registerCommand('coauthor.execute', (task: string, inputFilePath: string, auxFiles: string | string[], instructions: string, reflect: string, model: string, figureFiles: string | string[], additionalInputFiles: string[], autoExtractFigure: boolean, autoExtractTikzFigure: boolean, includeTexCount: boolean) => {
      const terminalName = `${task}@${model}`;
      const terminal_new = vscode.window.createTerminal(terminalName);
      terminal_new.show();

      let command = `coauthor ${task} ${inputFilePath}`;

      if (additionalInputFiles && additionalInputFiles.length > 0) {
        command += ` --input_files="${additionalInputFiles.join(',')}"`;
      }
      if (auxFiles) {
        const auxFileList = Array.isArray(auxFiles) ? auxFiles : [auxFiles];
        if (auxFileList.length === 1) {
          command += ` --auxiliary_files="${auxFileList[0]}"`;
        } else if (auxFileList.length > 1) {
          command += ` --auxiliary_files="${auxFileList.join(',')}"`;
        }
      }

      if (figureFiles) {
        const figureFileList = Array.isArray(figureFiles) ? figureFiles : [figureFiles];
        if (figureFileList.length === 1) {
          command += ` --figure_inputs="${figureFileList[0]}"`;
        } else if (figureFileList.length > 1) {
          command += ` --figure_inputs="${figureFileList.join(',')}"`;
        }
      }

      if (instructions) {
        const escapedInstructions = instructions
          .replace(/\\/g, '\\\\')  // Escape backslashes
          .replace(/"/g, '\\"')  // Escape double quotes
          .replace(/{/g, '\\{')  // Escape curly braces
          .replace(/}/g, '\\}');  // Escape curly braces
        command += ` --instruction="${escapedInstructions}"`;
      }
      if (model) {
        command += ` --model=${model}`;
      }
      if (reflect !== 'default') {
        command += ` --reflect=${reflect}`;
      }

      if (autoExtractFigure) {
        command += ' --auto_extract_figure';
      }
      if (autoExtractTikzFigure) {
        command += ' --auto_extract_tikz_figure';
      }
      if (includeTexCount) {
        command += ' --include_tex_count';
      }

      terminal_new.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.selectInputFile', async (currentInputFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const defaultUri = currentInputFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentInputFile)))
        : vscode.Uri.file(workspacePath);

      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select File',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex', 'txt']
        }
      });
      if (fileUri && fileUri[0]) {
        const relativePath = path.relative(workspacePath, fileUri[0].fsPath);
        vscode.window.showInformationMessage(`Selected file: ${relativePath}`);
        return relativePath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectFigureFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Figure File',
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
          'Images': ['png', 'pdf', 'jpeg']
        }
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected figure file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectRevisionFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Revision File',
        canSelectFiles: true,
        canSelectFolders: false
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected revision file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context))
  );
}