import * as path from 'path';
import { executeCommand } from '../utils/execUtils';
import { info, error, initializeLogging } from '../logger/logUtils';

const CHANNEL = 'LaTeX';
initializeLogging(CHANNEL);

/**
 * Compile a LaTeX file to PDF
 * @param texFile Path to the LaTeX file
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatexToPdf(texFile: string): Promise<boolean> {
  try {
    const outputDirectory = path.dirname(texFile);
    const command = [
      'pdflatex',
      '-interaction=nonstopmode',
      `-output-directory="${outputDirectory}"`,
      `"${texFile}"`,
    ];

    const result = await executeCommand(command, { channel: CHANNEL });
    if (result.success) {
      info(CHANNEL, `Successfully compiled ${texFile}`);
      return true;
    }
    return false;
  } catch (err) {
    error(
      CHANNEL,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
