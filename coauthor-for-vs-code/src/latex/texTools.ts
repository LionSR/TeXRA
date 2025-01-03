// Standard library imports
import * as path from 'path';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { executeCommand } from '../utils/execUtils';

const CHANNEL = 'LaTeX';
logger.initializeLogging(CHANNEL);

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
      logger.info(CHANNEL, `Successfully compiled ${texFile}`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
