import * as vscode from 'vscode';
import { exec } from 'child_process';
import { ensureTerminal } from './terminal';
import { CoAuthorViewProvider } from './viewProvider';
import * as path from 'path';
import {
  getWorkspacePath,
  getRelativePath,
  showInfoMessage,
  showErrorMessage,
  ensureArray,
  getNestedConfig,
} from './utils/commonUtils';
import { listInputFiles } from './utils';
import {
  runPackSingle,
  runCleanSingle,
  runCleanMultiple,
  runPackMultiple,
  runCleanOutput,
  runCleanBuild,
  runPackLatexDiffVC,
  runPackLatexDiffVCMultiple,
  runCleanLatexDiffVC,
  runCleanLatexDiffVCMultiple,
  runIndentTex,
} from './housekeeping';
import { runLatexDiff, runLatexDiffVC } from './utils/texUtils';
import { log, initializeLogging } from './utils/logUtils';

const CHANNEL_NAME = 'Coauthor Commands';
initializeLogging(CHANNEL_NAME);

export function registerCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.selectMultipleInputFiles',
      async (currentInputFile: string) => {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
          showErrorMessage('No workspace folder open');
          return null;
        }

        const defaultUri = currentInputFile
          ? vscode.Uri.file(
              path.dirname(path.join(workspacePath, currentInputFile)),
            )
          : vscode.Uri.file(workspacePath);

        const includedInputDirectories = getNestedConfig<string[]>(
          'files.included.inputDirectories',
          [],
        );

        try {
          const fileUris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Select Files',
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri: defaultUri,
            filters: {
              'Text files': ['tex', 'txt'],
            },
          });

          if (!fileUris || fileUris.length === 0) return null;

          const relativePaths = fileUris.map((uri) => {
            const relativePath = getRelativePath(uri.fsPath);
            const pathParts = relativePath.split(path.sep);
            const startIndex = pathParts.findIndex((part) =>
              includedInputDirectories.includes(part),
            );
            return startIndex !== -1
              ? pathParts.slice(startIndex).join(path.sep)
              : relativePath;
          });

          showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
          return relativePaths;
        } catch (error) {
          showErrorMessage(
            `Error selecting files: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleReferenceFiles',
      async (currentReferenceFile: string) => {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
          showErrorMessage('No workspace folder open');
          return null;
        }

        const defaultUri = currentReferenceFile
          ? vscode.Uri.file(
              path.dirname(path.join(workspacePath, currentReferenceFile)),
            )
          : vscode.Uri.file(workspacePath);

        const includedReferenceDirectories = getNestedConfig<string[]>(
          'files.included.referenceDirectories',
          [],
        );

        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Select Ref Files',
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: defaultUri,
          filters: {
            'Text files': ['tex', 'txt'],
          },
        });

        if (fileUris && fileUris.length > 0) {
          const relativePaths = fileUris.map((uri) => {
            const relativePath = getRelativePath(uri.fsPath);
            const pathParts = relativePath.split(path.sep);
            const startIndex = pathParts.findIndex((part) =>
              includedReferenceDirectories.includes(part),
            );
            return startIndex !== -1
              ? pathParts.slice(startIndex).join(path.sep)
              : relativePath;
          });
          showInfoMessage(
            `Selected reference files: ${relativePaths.join(', ')}`,
          );
          return relativePaths;
        }
        return null;
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleAuxiliaryFiles',
      async (currentAuxiliaryFile: string) => {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
          showErrorMessage('No workspace folder open');
          return null;
        }

        const defaultUri = currentAuxiliaryFile
          ? vscode.Uri.file(
              path.dirname(path.join(workspacePath, currentAuxiliaryFile)),
            )
          : vscode.Uri.file(workspacePath);

        const includedAuxiliaryDirectories = getNestedConfig<string[]>(
          'files.included.auxiliaryDirectories',
          [],
        );

        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Select Auxiliary Files',
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: defaultUri,
          filters: {
            'Text files': ['txt', 'tex', 'cls'],
          },
        });

        if (fileUris && fileUris.length > 0) {
          const relativePaths = fileUris.map((uri) => {
            const relativePath = getRelativePath(uri.fsPath);
            const pathParts = relativePath.split(path.sep);
            const startIndex = pathParts.findIndex((part) =>
              includedAuxiliaryDirectories.includes(part),
            );
            return startIndex !== -1
              ? pathParts.slice(startIndex).join(path.sep)
              : relativePath;
          });
          showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
          return relativePaths;
        }
        return null;
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleFigures',
      async (currentFigureFile: string) => {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
          showErrorMessage('No workspace folder open');
          return null;
        }

        const defaultUri = currentFigureFile
          ? vscode.Uri.file(
              path.dirname(path.join(workspacePath, currentFigureFile)),
            )
          : vscode.Uri.file(workspacePath);

        const includedFigureDirectories = getNestedConfig<string[]>(
          'files.included.figureDirectories',
          ['FiguresEx'],
        );

        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Select Figures',
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: defaultUri,
          filters: {
            'Image files': ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'pdf'],
          },
        });

        if (fileUris && fileUris.length > 0) {
          const relativePaths = fileUris.map((uri) => {
            const relativePath = getRelativePath(uri.fsPath);
            const pathParts = relativePath.split(path.sep);
            const startIndex = pathParts.findIndex((part) =>
              includedFigureDirectories.includes(part),
            );
            return startIndex !== -1
              ? pathParts.slice(startIndex).join(path.sep)
              : relativePath;
          });
          showInfoMessage(`Selected files: ${relativePaths.join(', ')}`);
          return relativePaths;
        }
        return null;
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.packSingle',
      // (
      //   inputFile: string,
      //   agent: string,
      //   model: string,
      //   outputNameOverride: string,
      // ) => {
      //   const terminal = ensureTerminal();
      //   terminal.show();
      //   let command = `coauthor pack-single --agent=${agent} --model=${model}`;
      //   if (outputNameOverride) {
      //     command += ` --input_file="${outputNameOverride}"`;
      //   } else {
      //     command += ` --input_file="${inputFile}"`;
      //   }
      //   terminal.sendText(command);
      // },
      async (
        inputFile: string,
        agent: string,
        model: string,
        outputNameOverride?: string,
      ) => {
        const category = 'Pack-Single';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}, outputNameOverride=${outputNameOverride}`,
        );

        if (!inputFile || !agent || !model) {
          log(
            CHANNEL_NAME,
            category,
            `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
            true,
          );
          vscode.window.showErrorMessage(
            'Missing required parameters for pack single',
          );
          return;
        }
        if (outputNameOverride) {
          await runPackSingle(model, outputNameOverride, agent);
        } else {
          await runPackSingle(model, inputFile, agent);
        }
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.packLatexDiffVC',
      async (
        inputFile: string,
        baseFile: string,
        commitHash: string,
        clean: boolean = false,
      ) => {
        // const terminal = ensureTerminal();
        // terminal.show();
        // const cleanFlag = clean ? '--clean' : '';
        // const fileToUse = baseFile || inputFile;
        // terminal.sendText(
        //     `coauthor pack-latexdiff-vc --input_file="${fileToUse}" --commit_hash=${commitHash} ${cleanFlag}`,
        // );
        const category = 'Pack-Latex-Diff-VC';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}, clean=${clean}`,
        );
        const fileToUse = baseFile || inputFile;
        await runPackLatexDiffVC(fileToUse, commitHash, clean);
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.packLatexDiffVCMultiple',
      async (
        inputFiles: string[],
        commitHash: string,
        clean: boolean = false,
      ) => {
        const category = 'Pack-Latex-Diff-VC-Multiple';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: commitHash=${commitHash}, clean=${clean}`,
        );
        log(CHANNEL_NAME, category, `Input files: ${inputFiles.join(', ')}`);
        await runPackLatexDiffVCMultiple(inputFiles, commitHash, clean);
      },
    ),
    vscode.commands.registerCommand('coauthor.cleanOutput', () => {
      // const terminal = ensureTerminal();
      // terminal.show();
      // terminal.sendText('coauthor clean-output');
      runCleanOutput();
    }),
    vscode.commands.registerCommand('coauthor.cleanBuild', () => {
      // const terminal = ensureTerminal();
      // terminal.show();
      // terminal.sendText('coauthor clean-build');
      runCleanBuild();
    }),
    vscode.commands.registerCommand('coauthor.indentTex', () => {
      // const terminal = ensureTerminal();
      // terminal.show();
      // terminal.sendText('coauthor indent-tex');
      runIndentTex();
    }),
    vscode.commands.registerCommand(
      'coauthor.cleanSingle',
      // (
      //   inputFile: string,
      //   agent: string,
      //   model: string,
      //   outputNameOverride: string,
      // ) => {
      //   const terminal = ensureTerminal();
      //   terminal.show();
      //   let command = `coauthor clean-single --agent=${agent} --model=${model}`;
      //   if (outputNameOverride) {
      //     command += ` --input_file="${outputNameOverride}"`;
      //   } else {
      //     command += ` --input_file="${inputFile}"`;
      //   }
      //   terminal.sendText(command);
      // },
      async (
        inputFile: string,
        agent: string,
        model: string,
        outputNameOverride: string,
      ) => {
        const category = 'Clean-Single';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}, outputNameOverride=${outputNameOverride}`,
        );

        if (!inputFile || !agent || !model) {
          log(
            CHANNEL_NAME,
            category,
            `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
            true,
          );
          vscode.window.showErrorMessage(
            'Missing required parameters for clean single',
          );
          return;
        }
        if (outputNameOverride) {
          await runCleanSingle(model, outputNameOverride, agent);
        } else {
          await runCleanSingle(model, inputFile, agent);
        }
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.latexDiff',
      async (inputFile: string, baseFile: string, editedFile: string) => {
        // (inputFile: string, baseFile: string, editedFile: string) => {
        // Comment out old terminal-based code
        /*
        const terminal = ensureTerminal();
        terminal.show();
        const editedFileName = path.basename(editedFile);
        const baseName = path.parse(editedFileName).name;
        const diffFileName = `${baseName}_diff.tex`;

        const fileToUse = baseFile || inputFile;
        const inputSubdirectory = fileToUse.substring(
          0,
          fileToUse.lastIndexOf('/'),
        );
        const workspacePath = getWorkspacePath();
        const fullPath = vscode.Uri.file(
          `${workspacePath}/${inputSubdirectory}/${diffFileName}`,
        );

        terminal.sendText(
          `coauthor latexdiff --input_file="${fileToUse}" --edited_file="${editedFile}"`,
        );

        // Wait for the command to execute and the file to be generated
        setTimeout(async () => {
          try {
            await vscode.workspace.fs.stat(fullPath);
            vscode.window.showTextDocument(fullPath);
            await vscode.commands.executeCommand(
              'workbench.view.extension.latex-workshop-activitybar',
            );
            await vscode.commands.executeCommand('latex-workshop.build');
            setTimeout(async () => {
              await vscode.commands.executeCommand('latex-workshop.view');
            }, 5000); // Adjust the delay based on expected build time
          } catch (error) {
            if (
              error instanceof vscode.FileSystemError &&
              error.code === 'FileNotFound'
            ) {
              vscode.window.showErrorMessage(
                'Diff file could not be found. Expected path: ' +
                  fullPath.fsPath,
              );
            } else if (error instanceof Error) {
              vscode.window.showErrorMessage(
                'An error occurred: ' + error.message,
              );
            } else {
              vscode.window.showErrorMessage('An unknown error occurred.');
            }
          }
        }, 2000); // Adjust delay as needed based on expected command execution time
        */
        // Add new implementation
        const fileToUse = baseFile || inputFile;
        try {
          // Get the diff filename from runLatexDiff
          const diffFileName = await runLatexDiff(fileToUse, editedFile);
          if (!diffFileName) {
            throw new Error('Failed to generate diff file');
          }

          // Open the diff file and build it
          const workspacePath = getWorkspacePath();
          if (!workspacePath) {
            throw new Error('No workspace path found');
          }

          // Use the returned diff filename to construct the full path
          const fullPath = vscode.Uri.file(
            path.join(workspacePath, path.dirname(fileToUse), diffFileName),
          );

          // Verify the file exists
          try {
            await vscode.workspace.fs.stat(fullPath);
          } catch (error) {
            if (
              error instanceof vscode.FileSystemError &&
              error.code === 'FileNotFound'
            ) {
              throw new Error(
                `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
              );
            }
            throw error;
          }

          const doc = await vscode.window.showTextDocument(fullPath);
          await vscode.window.showTextDocument(doc.document, {
            preview: false,
            preserveFocus: true,
          });
          await vscode.commands.executeCommand(
            'workbench.view.extension.latex-workshop-activitybar',
          );
          await vscode.commands.executeCommand('latex-workshop.build');

          // Wait for build to complete before viewing
          setTimeout(async () => {
            await vscode.commands.executeCommand('latex-workshop.view');
          }, 5000);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Error creating LaTeX diff: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.latexDiffVC',
      async (inputFile: string, baseFile: string, commitHash: string) => {
        // Comment out old terminal-based code
        /*
        (inputFile: string, baseFile: string, commitHash: string) => {
        const terminal = ensureTerminal();
        terminal.show();

        const fileToUse = baseFile || inputFile;
        const inputSubdirectory = fileToUse.substring(
          0,
          fileToUse.lastIndexOf('/'),
        );

        const inputFileName = path.basename(inputFile);
        const baseName = path.parse(inputFileName).name;
        const diffFileName = `${baseName}-diff${commitHash}.tex`;
        const workspacePath = getWorkspacePath();

        const fullPath = vscode.Uri.file(
          `${workspacePath}/${inputSubdirectory}/${diffFileName}`,
        );
        terminal.sendText(
          `coauthor latexdiff-vc --input_file="${fileToUse}" --commit_hash=${commitHash}`,
        );
        */

        // Wait for the command to execute and the file to be generated
        // setTimeout(async () => {
        //   try {
        //     await vscode.workspace.fs.stat(fullPath);
        //     vscode.window.showTextDocument(fullPath);
        //     // await vscode.commands.executeCommand('workbench.view.extension.latex-workshop-activitybar');
        //     await vscode.commands.executeCommand('latex-workshop.build');
        //     setTimeout(async () => {
        //       await vscode.commands.executeCommand('latex-workshop.view');
        //     }, 5000); // Adjust the delay based on expected build time
        //   } catch (error) {
        //     if (
        //       error instanceof vscode.FileSystemError &&
        //       error.code === 'FileNotFound'
        //     ) {
        //       vscode.window.showErrorMessage(
        //         'Diff file could not be found. Expected path: ' +
        //           fullPath.fsPath,
        //       );
        //     } else if (error instanceof Error) {
        //       vscode.window.showErrorMessage(
        //         'An error occurred: ' + error.message,
        //       );
        //     } else {
        //       vscode.window.showErrorMessage('An unknown error occurred.');
        //     }
        //   }
        // }, 2000); // Adjust delay as needed based on expected command execution time
        const fileToUse = baseFile || inputFile;
        try {
          // Get the diff filename from runLatexDiffVC
          const diffFileName = await runLatexDiffVC(fileToUse, commitHash);
          if (!diffFileName) {
            throw new Error('Failed to generate diff file');
          }

          const workspacePath = getWorkspacePath();
          if (!workspacePath) {
            throw new Error('No workspace path found');
          }

          // Use the returned diff filename to construct the full path
          const fullPath = vscode.Uri.file(
            path.join(workspacePath, path.dirname(fileToUse), diffFileName),
          );

          // Verify the file exists
          try {
            await vscode.workspace.fs.stat(fullPath);
          } catch (error) {
            if (
              error instanceof vscode.FileSystemError &&
              error.code === 'FileNotFound'
            ) {
              throw new Error(
                `Diff file could not be found. Expected path: ${fullPath.fsPath}`,
              );
            }
            throw error;
          }

          const doc = await vscode.window.showTextDocument(fullPath);
          await vscode.window.showTextDocument(doc.document, {
            preview: false,
            preserveFocus: true,
          });
          await vscode.commands.executeCommand('latex-workshop.build');

          // Wait for build to complete before viewing
          setTimeout(async () => {
            await vscode.commands.executeCommand('latex-workshop.view');
          }, 5000);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Error creating LaTeX diff: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand('coauthor.isGitRepository', async () => {
      const workspacePath = getWorkspacePath();
      if (workspacePath) {
        return new Promise<boolean>((resolve) => {
          exec(
            'git rev-parse --is-inside-work-tree',
            { cwd: workspacePath },
            (error) => {
              resolve(!error);
            },
          );
        });
      }
      return false;
    }),
    vscode.commands.registerCommand('coauthor.getRecentCommits', async () => {
      const isGitRepo = await vscode.commands.executeCommand(
        'coauthor.isGitRepository',
      );
      if (!isGitRepo) {
        return null; // Return null if it's not a Git repository
      }

      const workspacePath = getWorkspacePath();
      if (workspacePath) {
        const numberOfCommits = getNestedConfig(
          'git.numberOfCommitsToShow',
          20,
        );
        return new Promise<string[]>((resolve, reject) => {
          exec(
            `git log -n ${numberOfCommits} --pretty=format:"%h: %s (%cr)"`,
            { cwd: workspacePath },
            (error, stdout, stderr) => {
              if (error) {
                reject(stderr);
              } else {
                const commits = stdout.split('\n').map((line) => line.trim());
                resolve(commits);
              }
            },
          );
        });
      }
      return [];
    }),
    vscode.commands.registerCommand(
      'coauthor.execute',
      async (
        // parameters
        agent: string,
        model: string,
        reflect: string,
        // files
        inputFile: string,
        inputFiles: string[] | null,
        referenceFile: string | null,
        referenceFiles: string[] | null,
        auxiliaryFile: string | null,
        auxiliaryFiles: string[] | null,
        figureFile: string | null,
        figureFiles: string[] | null,
        // instructions
        instructions: string,
        // tools
        autoExtractFigure: boolean,
        autoExtractTikzFigure: boolean,
        includeTikzReflection: boolean,
        includeTexCount: boolean,
        // output options
        outputFiles: string[],
        outputNameOverride: string,
      ) => {
        const terminalName = `${agent}@${model}`;
        const terminal_new = vscode.window.createTerminal(terminalName);
        terminal_new.show();

        // Check if virtual environment string is configured
        const virtualEnvString = getNestedConfig<string>(
          'python.virtualEnvString',
          '',
        );

        if (virtualEnvString) {
          if (terminal_new.shellIntegration) {
            const execution =
              terminal_new.shellIntegration.executeCommand(virtualEnvString);
            await new Promise<void>((resolve) => {
              const disposable = vscode.window.onDidEndTerminalShellExecution(
                (event) => {
                  if (event.execution === execution) {
                    disposable.dispose();
                    resolve();
                  }
                },
              );
            });
          } else {
            terminal_new.sendText(virtualEnvString);
          }
        }

        let command = `coauthor ${agent} --input_file="${inputFile}"`;

        // Add single files if they exist
        if (referenceFile) {
          command += ` --reference_file="${referenceFile}"`;
        }
        if (auxiliaryFile) {
          command += ` --auxiliary_file="${auxiliaryFile}"`;
        }
        if (figureFile) {
          command += ` --figure_file="${figureFile}"`;
        }

        // Add multiple files if they exist
        const addFilesToCommand = (files: string[] | null, flag: string) => {
          if (files && files.length > 0) {
            command += ` ${flag}="${files.join(',')}"`;
          }
        };

        addFilesToCommand(ensureArray(inputFiles), '--input_files');
        addFilesToCommand(ensureArray(auxiliaryFiles), '--auxiliary_files');
        addFilesToCommand(ensureArray(referenceFiles), '--reference_files');
        addFilesToCommand(ensureArray(figureFiles), '--figure_files');

        if (instructions) {
          const escapedInstructions = instructions
            .replace(/\\/g, '\\\\') // Escape backslashes
            .replace(/"/g, '\\"') // Escape double quotes
            .replace(/{/g, '\\{') // Escape curly braces
            .replace(/}/g, '\\}'); // Escape curly braces
          command += ` --instruction="${escapedInstructions}"`;
        }
        if (model) {
          command += ` --model=${model}`;
        }
        if (reflect !== 'default') {
          command += ` --reflect=${reflect}`;
        }

        if (outputFiles && outputFiles.length > 0) {
          command += ` --output_files="${outputFiles.join(',')}"`;
        }
        if (outputNameOverride) {
          command += ` --output_name_override="${outputNameOverride}"`;
        }

        const flagsToAdd = [
          { condition: autoExtractFigure, flag: '--auto_extract_figure' },
          {
            condition: autoExtractTikzFigure,
            flag: '--auto_extract_tikz_figure',
          },
          {
            condition: includeTikzReflection,
            flag: '--auto_extract_tikz_figure_reflect',
          },
          { condition: includeTexCount, flag: '--include_tex_count' },
        ];
        flagsToAdd.forEach(({ condition, flag }) => {
          if (condition) {
            command += ` ${flag}`;
          }
        });

        terminal_new.sendText(command);
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.selectInputFile',
      async (currentInputFile: string) => {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
          showErrorMessage('No workspace folder open');
          return null;
        }

        const defaultUri = currentInputFile
          ? vscode.Uri.file(
              path.dirname(path.join(workspacePath, currentInputFile)),
            )
          : vscode.Uri.file(workspacePath);

        const fileUri = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Select File',
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: defaultUri,
          filters: {
            'Text files': ['tex', 'txt'],
          },
        });
        if (fileUri && fileUri[0]) {
          const relativePath = getRelativePath(fileUri[0].fsPath);
          showInfoMessage(`Selected file: ${relativePath}`);
          return relativePath;
        }
        return null;
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.selectMultipleReferenceFile',
      async (currentReferenceFile: string) => {
        const workspacePath = getWorkspacePath();
        if (!workspacePath) {
          showErrorMessage('No workspace folder open');
          return null;
        }

        const defaultUri = currentReferenceFile
          ? vscode.Uri.file(
              path.dirname(path.join(workspacePath, currentReferenceFile)),
            )
          : vscode.Uri.file(workspacePath);

        const fileUris = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: 'Select Ref File',
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: defaultUri,
          filters: {
            'Text files': ['tex', 'txt'],
          },
        });
        if (fileUris && fileUris.length > 0) {
          const relativePaths = fileUris.map((uri) =>
            getRelativePath(uri.fsPath),
          );
          showInfoMessage(
            `Selected reference file: ${relativePaths.join(', ')}`,
          );
          return relativePaths;
        }
        return null;
      },
    ),
    vscode.commands.registerCommand('coauthor.selectFigureFile', async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Figure File',
        canSelectFiles: true,
        canSelectFolders: false,
        filters: {
          Images: ['png', 'pdf', 'jpeg', 'jpg'],
        },
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
        canSelectFolders: false,
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
    vscode.commands.registerCommand(
      'coauthor.merge',
      async (inputFile: string, baseFile: string, editedFile: string) => {
        const model = getNestedConfig('merge.defaultModel', 'sonnet+');
        const terminalName = `Merge@${model}`;
        const terminal_new = vscode.window.createTerminal(terminalName);
        terminal_new.show();
        const reflect = getNestedConfig('merge.defaultReflect', 'False');
        const fileToUse = baseFile || inputFile;

        if (editedFile && fileToUse) {
          terminal_new.sendText(
            `coauthor merge --input_file="${fileToUse}" --edited_file="${editedFile}" --model=${model} --reflect=${reflect}`,
          );
        } else {
          vscode.window.showErrorMessage(
            'Both input file and edited file must be specified for merge operation',
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.packMultiple',
      // (
      //   inputFile: string,
      //   inputFiles: string[],
      //   agent: string,
      //   model: string,
      //   outputNameOverride: string,
      //   outputFiles: string[]
      // ) => {
      //   const terminal = ensureTerminal();
      //   terminal.show();
      //   const allInputFiles = [inputFile, ...inputFiles];
      //   let command = `coauthor pack-multiple --input_file="${inputFile}" --input_files="${outputFiles.join(',')}" --agent=${agent}
      //   --model=${model}`;
      //   if (outputNameOverride) {
      //     command += ` --output_name_override="${outputNameOverride}"`;
      //   terminal.sendText(command);
      // }
      // ),
      async (
        inputFile: string,
        inputFiles: string[],
        agent: string,
        model: string,
        outputNameOverride: string,
        outputFiles: string[],
      ) => {
        const category = 'Pack-Multiple';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}, outputNameOverride=${outputNameOverride}`,
        );

        if (!inputFile || !agent || !model) {
          log(
            CHANNEL_NAME,
            category,
            `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
            true,
          );
          vscode.window.showErrorMessage(
            'Missing required parameters for pack multiple',
          );
          return;
        }
        await runPackMultiple(
          model,
          inputFile,
          outputFiles,
          agent,
          outputNameOverride,
        );
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanMultiple',
      // (
      //   inputFile: string,
      //   inputFiles: string[],
      //   agent: string,
      //   model: string,
      //   outputNameOverride: string,
      //   outputFiles: string[]
      // ) => {
      //   const terminal = ensureTerminal();
      //   terminal.show();
      //   const allInputFiles = [inputFile, ...inputFiles];
      //   let inputFilesWithOverride = outputNameOverride
      //     ? [outputNameOverride, ...outputFiles]
      //     : outputFiles;
      //   let command = `coauthor clean-multiple --input_file="${inputFile}" --input_files="${inputFilesWithOverride.join(',')}" --agent=$
      //   {agent} --model=${model}`;
      //   terminal.sendText(command);
      // },
      async (
        inputFile: string,
        inputFiles: string[],
        agent: string,
        model: string,
        outputNameOverride: string,
        outputFiles: string[],
      ) => {
        const category = 'Clean-Multiple';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}, outputNameOverride=${outputNameOverride}`,
        );

        if (!inputFile || !agent || !model) {
          log(
            CHANNEL_NAME,
            category,
            `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
            true,
          );
          vscode.window.showErrorMessage(
            'Missing required parameters for clean multiple',
          );
          return;
        }
        let inputFilesWithOverride = outputNameOverride
          ? [outputNameOverride, ...outputFiles]
          : outputFiles;
        await runCleanMultiple(model, inputFile, inputFilesWithOverride, agent);
      },
    ),
    vscode.commands.registerCommand('coauthor.refreshInputFiles', async () => {
      const inputFilesRefreshed = await listInputFiles();
      return inputFilesRefreshed;
    }),
    vscode.commands.registerCommand('coauthor.selectBaseFile', async () => {
      const baseFile = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Base File',
        filters: {
          'Text files': ['tex', 'txt', 'md'],
        },
      });
      if (baseFile && baseFile[0]) {
        return getRelativePath(baseFile[0].fsPath);
      }
      return null;
    }),
    vscode.commands.registerCommand('coauthor.refreshBaseFiles', async () => {
      return await listInputFiles();
    }),
    vscode.window.registerWebviewViewProvider(
      'coauthor.chatView',
      new CoAuthorViewProvider(context),
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanLatexDiffVC',
      async (inputFile: string, baseFile: string, commitHash: string) => {
        const category = 'Clean-Latex-Diff-VC';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: inputFile=${inputFile}, baseFile=${baseFile}, commitHash=${commitHash}`,
        );
        const fileToUse = baseFile || inputFile;
        await runCleanLatexDiffVC(fileToUse, commitHash);
      },
    ),
    vscode.commands.registerCommand(
      'coauthor.cleanLatexDiffVCMultiple',
      async (inputFiles: string[], commitHash: string) => {
        const category = 'Clean-Latex-Diff-VC-Multiple';
        log(
          CHANNEL_NAME,
          category,
          `Command called with: commitHash=${commitHash}`,
        );
        log(CHANNEL_NAME, category, `Input files: ${inputFiles.join(', ')}`);
        await runCleanLatexDiffVCMultiple(inputFiles, commitHash);
      },
    ),
  );
}
