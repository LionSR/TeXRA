import * as path from 'path';
import { promisify } from 'util';
import * as cp from 'child_process';
import { getWorkspacePath } from '../utils/fileUtils';
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
 * Compile a LaTeX file to PDF
 * @param texFile Path to the LaTeX file
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatexToPdf(texFile: string): Promise<boolean> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const outputDirectory = path.dirname(texFile);
    const command = [
      'pdflatex',
      '-interaction=nonstopmode',
      `-output-directory="${outputDirectory}"`,
      `"${texFile}"`,
    ].join(' ');

    debug(CHANNEL, `Running command: ${command}`);
    const { stdout, stderr } = await execAsync(command, {
      cwd: workspacePath,
    });

    if (stderr && stderr.trim()) {
      warn(CHANNEL, `pdflatex stderr: ${stderr}`);
    }

    info(CHANNEL, `Successfully compiled ${texFile}`);
    return true;
  } catch (err) {
    error(
      CHANNEL,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
