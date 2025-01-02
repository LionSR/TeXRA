import * as vscode from 'vscode';
import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import { sync as globSync } from 'glob';
import { getWorkspacePath, deleteFile } from '../utils/fileUtils';
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

export async function runLatexIndent(filePath: string): Promise<boolean> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    // Get latexindent config from settings
    const config = vscode.workspace.getConfiguration('coauthor.latex');
    const latexindentConfig = config.get<string>('latexindentConfig');

    // Build command array - note we're using -w (overwrite) and -s (silent)
    const command = ['latexindent', '-w', '-s'];
    if (latexindentConfig) {
      command.push(`-l=${latexindentConfig}`);
    }
    command.push(`"${filePath}"`);

    debug(CHANNEL, `Running command: ${command.join(' ')}`);

    // Execute latexindent from workspace root
    const { stdout, stderr } = await execAsync(command.join(' '), {
      cwd: workspacePath,
    });

    if (stderr && stderr.trim()) {
      warn(CHANNEL, `Latexindent stderr: ${stderr}`);
    }

    // Wait a moment for the file system to stabilize
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Setup cleanup patterns relative to workspace
    const fileBaseName = path.basename(filePath, '.tex');
    const fileDir = path.dirname(filePath);

    // Get all backup files matching the patterns, relative to workspace
    const backupPatterns = [
      path.join(fileDir, `${fileBaseName}.tex.bak*`),
      path.join(fileDir, `${fileBaseName}.tex.bak`),
      path.join(fileDir, `${fileBaseName}.bak*`),
      path.join(fileDir, `${fileBaseName}.bak`),
    ];

    // Clean up backup files from workspace directory
    for (const pattern of backupPatterns) {
      const backupFiles = globSync(pattern, {
        cwd: workspacePath,
        absolute: false,
      });

      for (const backupFile of backupFiles) {
        try {
          await deleteFile(backupFile);
          debug(CHANNEL, `Removed backup file: ${backupFile}`);
        } catch (err) {
          warn(CHANNEL, `Error removing backup file ${backupFile}: ${err}`);
        }
      }
    }

    // Clean up indent.log
    const indentLogPath = path.join(path.dirname(filePath), 'indent.log');
    try {
      await deleteFile(indentLogPath);
      debug(CHANNEL, 'Removed indent.log');
    } catch (err) {
      // Ignore error if indent.log doesn't exist
      warn(CHANNEL, `Error removing indent.log: ${err}`);
    }

    info(CHANNEL, `Indented ${filePath}`);
    return true;
  } catch (err) {
    error(
      CHANNEL,
      `Error running LaTeX indent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
