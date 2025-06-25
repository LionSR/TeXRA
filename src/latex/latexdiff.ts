// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { logErrorMessage, showLoggedMessage } from '@utils/errorHandlingUtils';

// Local imports - runner
import {
  LatexdiffRunner,
  LaTeXdiffResult,
  LaTeXdiffMultipleResult,
} from './latexdiffRunner';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

export { LaTeXdiffResult, LaTeXdiffMultipleResult } from './latexdiffRunner';

export async function runLatexdiff(
  inputFile: string,
  editedFile: string,
  suffix = '_diff',
  runIndent = true,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  const runner = new LatexdiffRunner(channel);
  return runner.runDiff(inputFile, editedFile, suffix, runIndent);
}

export async function runLatexdiffvc(
  inputFile: string,
  commitHash: string,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  const runner = new LatexdiffRunner(channel);
  return runner.runDiffVc(inputFile, commitHash);
}

export async function runLatexdiffvcMultiple(
  inputFiles: string[],
  commitHash: string,
  channel: string = CHANNEL,
): Promise<LaTeXdiffMultipleResult> {
  const runner = new LatexdiffRunner(channel);
  if (!inputFiles || inputFiles.length === 0) {
    await showLoggedMessage(channel, 'No input files provided');
    return {
      success: false,
      results: { success: [], failed: [] },
      message: 'No input files provided',
    };
  }
  const results: { success: string[]; failed: string[] } = {
    success: [],
    failed: [],
  };

  for (const inputFile of inputFiles) {
    try {
      const result = await runner.runDiffVc(inputFile, commitHash);
      if (result.success) {
        results.success.push(inputFile);
      } else {
        results.failed.push(inputFile);
      }
    } catch (err) {
      results.failed.push(inputFile);
      logger.error(
        channel,
        `Error processing ${inputFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const summary = [
    'LaTeX diff operations completed:',
    results.success.length > 0
      ? `\nSuccessful:\n${results.success.join('\n')}`
      : '',
    results.failed.length > 0 ? `\nFailed:\n${results.failed.join('\n')}` : '',
  ].join('');

  logger.info(channel, summary);

  return {
    success: results.failed.length === 0,
    results,
    message: summary,
  };
}

export async function runLatexdiffForRound(
  baseFile: string,
  outputFile: string,
  _round: number,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  try {
    const runner = new LatexdiffRunner(channel);
    return await runner.runDiffForRound(baseFile, outputFile, _round);
  } catch (err) {
    const message = logErrorMessage(
      channel,
      'Error in runLatexdiffForRound',
      err,
    );
    return { success: false, message };
  }
}

export async function runLatexdiffBetweenRounds(
  outputFile1: string,
  outputFile2: string,
  channel: string = CHANNEL,
): Promise<LaTeXdiffResult> {
  try {
    const runner = new LatexdiffRunner(channel);
    return await runner.runDiffBetweenRounds(outputFile1, outputFile2);
  } catch (err) {
    const message = logErrorMessage(
      channel,
      'Error in runLatexdiffBetweenRounds',
      err,
    );
    return { success: false, message };
  }
}

export async function runLatexdiffMultiple(
  inputFiles: string[],
  editedFiles: string[],
  channel: string = CHANNEL,
): Promise<LaTeXdiffMultipleResult> {
  const runner = new LatexdiffRunner(channel);
  return runner.runDiffMultiple(inputFiles, editedFiles);
}
