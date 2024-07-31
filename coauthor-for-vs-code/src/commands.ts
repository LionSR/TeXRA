import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ensureTerminal } from './terminal';
import { CoAuthorViewProvider } from './viewProvider';
import * as path from 'path';
import { getWorkspacePath, getRelativePath, showInfoMessage, showErrorMessage, getConfig, ensureArray } from './utils/commonUtils';

export function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.selectMultipleInputFiles', async (currentInputFile: string) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        showErrorMessage('No workspace folder open');
        return null;
      }

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
        const relativePaths = fileUris.map(uri => getRelativePath(uri.fsPath));
        showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleSampleFiles', async (currentSampleFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const defaultUri = currentSampleFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentSampleFile)))
        : vscode.Uri.file(workspacePath);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Sample Files',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex', 'txt']
        }
      });
      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => path.relative(workspacePath, uri.fsPath));
        vscode.window.showInformationMessage(`Selected sample files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleAuxFiles', async (currentAuxFile: string) => {
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
      const includedFigureDirectories = config.get<string[]>('includedFigureDirectories') || ['FiguresEx'];

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

          const startIndex = pathParts.findIndex(part => includedFigureDirectories.includes(part));

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
    vscode.commands.registerCommand('coauthor.packSingle', (inputFile: string, task: string, reflect: string, model: string, outputNameOverride: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      let command = `coauthor pack-single --task=${task} --reflect=${reflect} --model=${model}`;
      if (outputNameOverride) {
        command += ` --input_file="${outputNameOverride}"`;
      }
      else {
        command += ` --input_file="${inputFile}"`;
      }
      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.packLatexDiffVC', async (inputFile: string, commitHash: string, clean: boolean = false) => {
      const terminal = ensureTerminal();
      terminal.show();
      const cleanFlag = clean ? '--clean' : '';
      terminal.sendText(`coauthor pack-latexdiff-vc --input_file="${inputFile}" --commit_hash=${commitHash} ${cleanFlag}`);
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
    vscode.commands.registerCommand('coauthor.cleanSingle', (inputFile: string, task: string, reflect: string, model: string, outputNameOverride: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      let command = `coauthor clean-single --task=${task} --reflect=${reflect} --model=${model}`;
      if (outputNameOverride) {
        command += ` --input_file="${outputNameOverride}"`;
      }
      else {
        command += ` --input_file="${inputFile}"`;
      }
      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.latexDiff', (inputFile: string, editedFile: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const editedFileName = editedFile.split('/').pop();
      const baseName = editedFileName?.split('.').slice(0, -1).join('.');
      const diffFileName = `${baseName}_diff.tex`;
      const inputSubdirectory = inputFile.substring(0, inputFile.lastIndexOf('/'));
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      terminal.sendText(`coauthor latexdiff --input_file="${inputFile}" --edited_file="${editedFile}"`);

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
    vscode.commands.registerCommand('coauthor.latexDiffVC', async (inputFile: string, commitHash: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const inputFileName = inputFile.split('/').pop();
      const baseName = inputFileName?.split('.').slice(0, -1).join('.');
      const diffFileName = `${baseName}-diff${commitHash}.tex`;
      const inputSubdirectory = inputFile.substring(0, inputFile.lastIndexOf('/'));
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      terminal.sendText(`coauthor latexdiff-vc --input_file="${inputFile}" --commit_hash=${commitHash}`);

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
    vscode.commands.registerCommand('coauthor.isGitRepository', async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        return new Promise<boolean>((resolve) => {
          exec('git rev-parse --is-inside-work-tree', { cwd: workspacePath }, (error) => {
            resolve(!error);
          });
        });
      }
      return false;
    }),
    vscode.commands.registerCommand('coauthor.getRecentCommits', async () => {
      const isGitRepo = await vscode.commands.executeCommand('coauthor.isGitRepository');
      if (!isGitRepo) {
        return null; // Return null if it's not a Git repository
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        const config = vscode.workspace.getConfiguration('coauthor');
        const numberOfCommits = config.get('numberOfCommitsToShow', 20);
        return new Promise<string[]>((resolve, reject) => {
          exec(`git log -n ${numberOfCommits} --pretty=format:"%h: %s (%cr)"`, { cwd: workspacePath }, (error, stdout, stderr) => {
            if (error) {
              reject(stderr);
            } else {
              const commits = stdout.split('\n').map(line => line.trim());
              resolve(commits);
            }
          });
        });
      }
      return [];
    }),
    vscode.commands.registerCommand('coauthor.execute', (task: string, inputFile: string, auxFiles: string | string[] | null, instructions: string, reflect: string, model: string, figureFiles: string | string[] | null, additionalInputFiles: string[] | null, sampleFiles: string | string[] | null, autoExtractFigure: boolean, autoExtractTikzFigure: boolean, includeTikzReflection: boolean, includeTexCount: boolean, outputFiles: string[], outputNameOverride: string) => {
      const terminalName = `${task}@${model}`;
      const terminal_new = vscode.window.createTerminal(terminalName);
      terminal_new.show();

      let command = `coauthor ${task} --input_file="${inputFile}"`;

      const addFilesToCommand = (files: string[] | null, flag: string) => {
        if (files && files.length > 0) {
          command += ` ${flag}="${files.join(',')}"`;
        }
      };

      addFilesToCommand(ensureArray(additionalInputFiles), '--input_files');
      addFilesToCommand(ensureArray(auxFiles), '--auxiliary_files');
      addFilesToCommand(ensureArray(figureFiles), '--figure_inputs');
      addFilesToCommand(ensureArray(sampleFiles), '--sample_files');

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
      if (includeTikzReflection) {
        command += ' --include_tikz_reflection';
      }
      if (includeTexCount) {
        command += ' --include_tex_count';
      }

      if (outputFiles && outputFiles.length > 0) {
        command += ` --output_files="${outputFiles.join(',')}"`;
      }
      if (outputNameOverride) {
        command += ` --output_name_override="${outputNameOverride}"`;
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
    vscode.commands.registerCommand('coauthor.selectMultipleSampleFile', async (currentSampleFile: string) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return null;
      }
      const workspacePath = workspaceFolders[0].uri.fsPath;

      const defaultUri = currentSampleFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentSampleFile)))
        : vscode.Uri.file(workspacePath);

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Sample File',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['tex', 'txt']
        }
      });
      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => path.relative(workspacePath, uri.fsPath));
        vscode.window.showInformationMessage(`Selected sample file: ${relativePaths.join(', ')}`);
        return relativePaths;
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
          'Images': ['png', 'pdf', 'jpeg', 'jpg']
        }
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected figure file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectEditedFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Edited File',
        canSelectFiles: true,
        canSelectFolders: false
      });
      if (fileUri && fileUri[0]) {
        vscode.window.showInformationMessage(`Selected edited file: ${fileUri[0].fsPath}`);
        return fileUri[0].fsPath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.getCurrentFile', async () => {
      const currentFile = vscode.window.activeTextEditor?.document;
      if (currentFile && currentFile.uri.scheme === 'file') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
          const workspacePath = workspaceFolders[0].uri.fsPath;
          const relativePath = path.relative(workspacePath, currentFile.uri.fsPath);
          return relativePath;
        }
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.merge', async (inputFile: string, editedFile: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const model = vscode.workspace.getConfiguration('coauthor').get('defaultMergeModel', 'sonnet+');
      const reflect = vscode.workspace.getConfiguration('coauthor').get('defaultMergeReflect', 'False');
      terminal.sendText(`coauthor merge --input_file="${inputFile}" --edited_file="${editedFile}" --model=${model} --reflect=${reflect}`);
    }),
    vscode.commands.registerCommand('coauthor.packMultiple', (inputFile: string, additionalInputFiles: string[], task: string, reflect: string, model: string, outputNameOverride: string, outputFiles: string[]) => {
      const terminal = ensureTerminal();
      terminal.show();
      const allInputFiles = [inputFile, ...additionalInputFiles];
      let command = `coauthor pack-multiple --input_files="${outputFiles.join(',')}" --task=${task} --reflect=${reflect} --model=${model}`;
      if (outputNameOverride) {
        command += ` --output_name_override="${outputNameOverride}"`;
      }

      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.cleanMultiple', (inputFile: string, additionalInputFiles: string[], task: string, reflect: string, model: string, outputNameOverride: string, outputFiles: string[]) => {
      const terminal = ensureTerminal();
      terminal.show();
      const allInputFiles = [inputFile, ...additionalInputFiles];
      let inputFilesWithOverride = outputNameOverride ? [outputNameOverride, ...outputFiles] : outputFiles;
      let command = `coauthor clean-multiple --input_files="${inputFilesWithOverride.join(',')}" --task=${task} --reflect=${reflect} --model=${model}`;
      terminal.sendText(command);
    }),
    vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context))
  );
}
