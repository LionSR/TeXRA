import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import { debug, info, warn, error } from '../logger/logUtils';
import { deleteFile, readDirectory, fileExists } from '../utils/fileUtils';
import { getConfig } from '../frontend-utils/commonUtils';
import { getWorkspacePath } from '../utils/fileUtils';
import { EXCLUDED_DIRS } from './constants';

const CHANNEL = 'Housekeeping';
const execAsync = promisify(cp.exec);

export async function runIndentTex(): Promise<void> {
  debug(CHANNEL, 'Starting LaTeX indentation process');

  const config = getConfig<string>('latex.latexindentConfig', '');
  debug(CHANNEL, `LaTeX indent config: ${config}`);

  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    error(CHANNEL, 'No workspace path found');
    vscode.window.showErrorMessage('No workspace path found');
    return;
  }

  if (config) {
    // Check if config file exists - use fs.access directly since this is an absolute path
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(config));
    } catch (err) {
      error(CHANNEL, `Error: Latexindent config file not found at ${config}`);
      vscode.window.showErrorMessage(
        `Latexindent config file not found at ${config}`,
      );
      return;
    }
  }

  const processDirectory = async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath);
      for (const [name, type] of entries) {
        if (EXCLUDED_DIRS.has(name.toLowerCase())) {
          continue;
        }
        if (name.includes('Diffs')) {
          continue;
        }

        const fullPath = path.join(dirPath, name);

        if (type === vscode.FileType.Directory) {
          await processDirectory(fullPath);
        } else if (type === vscode.FileType.File && name.endsWith('.tex')) {
          debug(CHANNEL, `Processing file: ${fullPath}`);
          try {
            const command = [
              'latexindent',
              `"${fullPath}"`,
              '-w', // Write to file
              '-s', // Silent mode
              config ? `-l="${config}"` : '', // Use absolute config path directly
            ]
              .filter(Boolean)
              .join(' ');

            debug(CHANNEL, `Executing command: ${command}`);
            try {
              const { stdout, stderr } = await execAsync(command, {
                cwd: workspacePath,
              });
              if (stdout) {
                debug(CHANNEL, `Command output: ${stdout}`);
              }
              if (stderr) {
                warn(CHANNEL, `Command stderr: ${stderr}`);
              }
              info(CHANNEL, `Successfully indented: ${fullPath}`);
            } catch (execError) {
              error(CHANNEL, `Command error: ${execError}`);
              if (execError instanceof Error && 'stderr' in execError) {
                error(CHANNEL, `Command stderr: ${(execError as any).stderr}`);
              }
              continue;
            }
          } catch (err) {
            error(CHANNEL, `Error indenting file ${fullPath}: ${err}`);
            continue;
          }
        }
      }
    } catch (err) {
      error(CHANNEL, `Error processing directory ${dirPath}: ${err}`);
    }
  };

  try {
    await processDirectory('.');

    // Clean up temporary files recursively
    const processCleanup = async (dirPath: string) => {
      try {
        const entries = await readDirectory(dirPath);
        for (const [name, type] of entries) {
          if (EXCLUDED_DIRS.has(name.toLowerCase())) {
            continue;
          }
          if (name.includes('Diffs')) {
            continue;
          }

          const fullPath = path.join(dirPath, name);

          if (type === vscode.FileType.Directory) {
            await processCleanup(fullPath);
          } else if (type === vscode.FileType.File) {
            // Check for temporary files
            if (
              name.endsWith('.bak') ||
              name.endsWith('.bak0') ||
              name.endsWith('.bak1') ||
              name === 'indent.log'
            ) {
              debug(CHANNEL, `Found cleanup file: ${fullPath}`);
              await deleteFile(fullPath);
            }
          }
        }
      } catch (err) {
        error(CHANNEL, `Error during cleanup in directory ${dirPath}: ${err}`);
      }
    };

    // Start cleanup from workspace root
    await processCleanup('.');

    info(CHANNEL, 'All .tex files have been indented');
  } catch (err) {
    error(CHANNEL, `Error during indentation process: ${err}`);
    vscode.window.showErrorMessage(`Error during indentation: ${err}`);
  }
}
