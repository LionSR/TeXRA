// Standard library imports
import * as path from 'path';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { executeCommand } from '../utils/execUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

/**
 * Compile a LaTeX file to PDF
 * @param latexFile Path to the LaTeX file
 * @param channel Optional channel for logging
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatex2Pdf(
  latexFile: string,
  channel: string = CHANNEL,
): Promise<boolean> {
  try {
    const outputDirectory = path.dirname(latexFile);
    const command = [
      'pdflatex',
      '-interaction=nonstopmode',
      `-output-directory="${outputDirectory}"`,
      `"${latexFile}"`,
    ];

    const result = await executeCommand(command, { channel });
    if (result.success) {
      logger.info(channel, `Successfully compiled ${latexFile}`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(
      channel,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
