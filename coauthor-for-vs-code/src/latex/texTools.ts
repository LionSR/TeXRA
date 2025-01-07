// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { executeCommand } from '../utils/execUtils';

const CHANNEL = 'LaTeX';
logger.initialize(CHANNEL);

/**
 * Compile a LaTeX file to PDF
 * @param latexFile Path to the LaTeX file
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatex2Pdf(latexFile: string): Promise<boolean> {
  try {
    const outputDirectory = path.dirname(latexFile);
    const command = [
      'pdflatex',
      '-interaction=nonstopmode',
      `-output-directory="${outputDirectory}"`,
      `"${latexFile}"`,
    ];

    const result = await executeCommand(command, { channel: CHANNEL });
    if (result.success) {
      logger.info(CHANNEL, `Successfully compiled ${latexFile}`);
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
