import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ensureTerminal } from './terminal';
import { CoAuthorViewProvider } from './viewProvider';
import * as path from 'path';
import { getWorkspacePath, getRelativePath, showInfoMessage, showErrorMessage, getConfig, ensureArray } from './utils/commonUtils';
import { listInputFiles } from './utils';

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

      const config = getConfig();
      const includedInputDirectories = config.get<string[]>('includedInputDirectories') || [];

      try {
        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Select Files',
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: defaultUri,
          filters: {
            'Text files': ['tex', 'txt']
          }
        });

        if (!fileUris || fileUris.length === 0) return null;

        const relativePaths = fileUris.map(uri => {
          const relativePath = getRelativePath(uri.fsPath);
          const pathParts = relativePath.split(path.sep);
          const startIndex = pathParts.findIndex(part => includedInputDirectories.includes(part));
          return startIndex !== -1 ? pathParts.slice(startIndex).join(path.sep) : relativePath;
        });

        showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      } catch (error) {
        showErrorMessage(`Error selecting files: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleSampleFiles', async (currentSampleFile: string) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        showErrorMessage('No workspace folder open');
        return null;
      }

      const defaultUri = currentSampleFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentSampleFile)))
        : vscode.Uri.file(workspacePath);

      const config = getConfig();
      const includedSampleDirectories = config.get<string[]>('includedSampleDirectories') || [];

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
        const relativePaths = fileUris.map(uri => {
          const relativePath = getRelativePath(uri.fsPath);
          const pathParts = relativePath.split(path.sep);
          const startIndex = pathParts.findIndex(part => includedSampleDirectories.includes(part));
          return startIndex !== -1 ? pathParts.slice(startIndex).join(path.sep) : relativePath;
        });
        showInfoMessage(`Selected sample files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleAuxFiles', async (currentAuxFile: string) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        showErrorMessage('No workspace folder open');
        return null;
      }

      const defaultUri = currentAuxFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentAuxFile)))
        : vscode.Uri.file(workspacePath);

      const config = getConfig();
      const includedAuxDirectories = config.get<string[]>('includedAuxDirectories') || [];

      const fileUris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Select Auxiliary Files',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: defaultUri,
        filters: {
          'Text files': ['txt', 'tex', 'cls']
        }
      });

      if (fileUris && fileUris.length > 0) {
        const relativePaths = fileUris.map(uri => {
          const relativePath = getRelativePath(uri.fsPath);
          const pathParts = relativePath.split(path.sep);
          const startIndex = pathParts.findIndex(part => includedAuxDirectories.includes(part));
          return startIndex !== -1 ? pathParts.slice(startIndex).join(path.sep) : relativePath;
        });
        showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleFigures', async (currentFigureFile: string) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        showErrorMessage('No workspace folder open');
        return null;
      }

      const defaultUri = currentFigureFile
        ? vscode.Uri.file(path.dirname(path.join(workspacePath, currentFigureFile)))
        : vscode.Uri.file(workspacePath);

      const config = getConfig();
      const includedFigureDirectories = config.get<string[]>('includedFigureDirectories') || ['FiguresEx'];

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
          const relativePath = getRelativePath(uri.fsPath);
          const pathParts = relativePath.split(path.sep);
          const startIndex = pathParts.findIndex(part => includedFigureDirectories.includes(part));
          return startIndex !== -1 ? pathParts.slice(startIndex).join(path.sep) : relativePath;
        });
        showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
        return relativePaths;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.packSingle', (inputFile: string, agent: string, model: string, outputNameOverride: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      let command = `coauthor pack-single --agent=${agent} --model=${model}`;
      if (outputNameOverride) {
        command += ` --input_file="${outputNameOverride}"`;
      }
      else {
        command += ` --input_file="${inputFile}"`;
      }
      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.packLatexDiffVC', async (inputFile: string, baseFile: string, commitHash: string, clean: boolean = false) => {
      const terminal = ensureTerminal();
      terminal.show();
      const cleanFlag = clean ? '--clean' : '';
      const fileToUse = baseFile || inputFile;
      terminal.sendText(`coauthor pack-latexdiff-vc --input_file="${fileToUse}" --commit_hash=${commitHash} ${cleanFlag}`);
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
    vscode.commands.registerCommand('coauthor.cleanSingle', (inputFile: string, agent: string, model: string, outputNameOverride: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      let command = `coauthor clean-single --agent=${agent} --model=${model}`;
      if (outputNameOverride) {
        command += ` --input_file="${outputNameOverride}"`;
      }
      else {
        command += ` --input_file="${inputFile}"`;
      }
      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.latexDiff', (inputFile: string, baseFile: string, editedFile: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const editedFileName = path.basename(editedFile);
      const baseName = path.parse(editedFileName).name;
      const diffFileName = `${baseName}_diff.tex`;

      const fileToUse = baseFile || inputFile;
      const inputSubdirectory = fileToUse.substring(0, fileToUse.lastIndexOf('/'));
      const workspacePath = getWorkspacePath();
      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);

      terminal.sendText(`coauthor latexdiff --input_file="${fileToUse}" --edited_file="${editedFile}"`);

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
    vscode.commands.registerCommand('coauthor.latexDiffVC', async (inputFile: string, baseFile: string, commitHash: string) => {
      const terminal = ensureTerminal();
      terminal.show();

      const fileToUse = baseFile || inputFile;
      const inputSubdirectory = fileToUse.substring(0, fileToUse.lastIndexOf('/'));

      const inputFileName = path.basename(inputFile);
      const baseName = path.parse(inputFileName).name;
      const diffFileName = `${baseName}-diff${commitHash}.tex`;
      const workspacePath = getWorkspacePath();

      const fullPath = vscode.Uri.file(`${workspacePath}/${inputSubdirectory}/${diffFileName}`);
      terminal.sendText(`coauthor latexdiff-vc --input_file="${fileToUse}" --commit_hash=${commitHash}`);

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
      const workspacePath = getWorkspacePath();
      if (workspacePath) {
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

      const workspacePath = getWorkspacePath();
      if (workspacePath) {
        const config = getConfig();
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
    vscode.commands.registerCommand('coauthor.execute', (agent: string, inputFile: string, auxFiles: string | string[] | null, instructions: string, reflect: string, model: string, figureFiles: string | string[] | null, additionalInputFiles: string[] | null, sampleFiles: string | string[] | null, autoExtractFigure: boolean, autoExtractTikzFigure: boolean, includeTikzReflection: boolean, includeTexCount: boolean, outputFiles: string[], outputNameOverride: string) => {
      const terminalName = `${agent}@${model}`;
      const terminal_new = vscode.window.createTerminal(terminalName);
      terminal_new.show();

      let command = `coauthor ${agent} --input_file="${inputFile}"`;

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
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        showErrorMessage('No workspace folder open');
        return null;
      }

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
        const relativePath = getRelativePath(fileUri[0].fsPath);
        showInfoMessage(`Selected file: ${relativePath}`);
        return relativePath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.selectMultipleSampleFile', async (currentSampleFile: string) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) {
        showErrorMessage('No workspace folder open');
        return null;
      }

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
        const relativePaths = fileUris.map(uri => getRelativePath(uri.fsPath));
        showInfoMessage(`Selected sample file: ${relativePaths.join(', ')}`);
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
        const relativePath = getRelativePath(fileUri[0].fsPath);
        showInfoMessage(`Selected figure file: ${relativePath}`);
        return relativePath;
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
        const relativePath = getRelativePath(fileUri[0].fsPath);
        showInfoMessage(`Selected edited file: ${relativePath}`);
        return relativePath;
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.getCurrentFile', async () => {
      const currentFile = vscode.window.activeTextEditor?.document;
      if (currentFile && currentFile.uri.scheme === 'file') {
        return getRelativePath(currentFile.uri.fsPath);
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.merge', async (inputFile: string, baseFile: string, editedFile: string) => {
      const terminal = ensureTerminal();
      terminal.show();
      const model = getConfig().get('defaultMergeModel', 'sonnet+');
      const reflect = getConfig().get('defaultMergeReflect', 'False');
      const fileToUse = baseFile || inputFile;
      terminal.sendText(`coauthor merge --input_file="${fileToUse}" --edited_file="${editedFile}" --model=${model} --reflect=${reflect}`);
    }),
    vscode.commands.registerCommand('coauthor.packMultiple', (inputFile: string, additionalInputFiles: string[], agent: string, model: string, outputNameOverride: string, outputFiles: string[]) => {
      const terminal = ensureTerminal();
      terminal.show();
      const allInputFiles = [inputFile, ...additionalInputFiles];
      let command = `coauthor pack-multiple --input_file="${inputFile}" --input_files="${outputFiles.join(',')}" --agent=${agent} --model=${model}`;
      if (outputNameOverride) {
        command += ` --output_name_override="${outputNameOverride}"`;
      }

      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.cleanMultiple', (inputFile: string, additionalInputFiles: string[], agent: string, model: string, outputNameOverride: string, outputFiles: string[]) => {
      const terminal = ensureTerminal();
      terminal.show();
      const allInputFiles = [inputFile, ...additionalInputFiles];
      let inputFilesWithOverride = outputNameOverride ? [outputNameOverride, ...outputFiles] : outputFiles;
      let command = `coauthor clean-multiple --input_file="${inputFile}" --input_files="${inputFilesWithOverride.join(',')}" --agent=${agent} --model=${model}`;
      terminal.sendText(command);
    }),
    vscode.commands.registerCommand('coauthor.refreshInputFiles', async () => {
      const inputFiles = await listInputFiles();
      return inputFiles;
    }),
    vscode.commands.registerCommand('coauthor.selectBaseFile', async () => {
      const baseFile = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Base File',
        filters: {
          'Text files': ['tex', 'txt', 'md']
        }
      });
      if (baseFile && baseFile[0]) {
        return getRelativePath(baseFile[0].fsPath);
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.refreshBaseFiles', async () => {
      return await listInputFiles();
    }),
    vscode.window.registerWebviewViewProvider('coauthor.chatView', new CoAuthorViewProvider(context))
  );
}
