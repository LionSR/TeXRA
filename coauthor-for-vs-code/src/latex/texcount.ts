import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import { getWorkspacePath, fileExists } from '../utils/fileUtils';
import {
  debug,
  info,
  warn,
  error,
  initializeLogging,
} from '../logger/logUtils';

const execAsync = promisify(cp.exec);

const CHANNEL = 'LaTeX';
initializeLogging(CHANNEL);

/**
 * Get full statistics for LaTeX documents using the texcount Perl script
 * @param filePaths Single file path or array of file paths
 * @param merge Whether to merge included files in the count
 * @returns Promise<string | null> String containing full texcount output for all files, or null if an error occurred
 */
export async function getTexCount(
  filePaths: string | string[],
  merge: boolean = false,
): Promise<string | null> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Convert single path to array
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const allOutputs: string[] = [];

    for (const filePath of paths) {
      if (!(await fileExists(filePath))) {
        warn(CHANNEL, `Warning: File ${filePath} does not exist.`);
        continue;
      }

      if (!filePath.endsWith('.tex')) {
        warn(CHANNEL, `Error: File ${filePath} is not a LaTeX file. Skipping.`);
        continue;
      }

      const command = ['texcount'];
      if (merge) {
        command.push('-merge');
      }
      command.push(`"${filePath}"`);

      debug(CHANNEL, `Running command: ${command.join(' ')}`);
      try {
        const { stdout, stderr } = await execAsync(command.join(' '), {
          cwd: workspacePath,
        });

        if (stderr && stderr.trim()) {
          warn(CHANNEL, `texcount stderr: ${stderr}`);
        }

        allOutputs.push(`Tex Count Results for ${filePath}:\n${stdout}`);
        debug(CHANNEL, `Successfully counted ${filePath}`);
      } catch (err) {
        error(CHANNEL, `Error getting tex count for ${filePath}`);
        error(
          CHANNEL,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (allOutputs.length > 0) {
      const combinedOutput = allOutputs.join('\n\n');
      info(CHANNEL, `Combined Tex Count Results:\n${combinedOutput}`);
      return combinedOutput;
    }

    return null;
  } catch (err) {
    error(
      CHANNEL,
      `Error in getTexCount: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
