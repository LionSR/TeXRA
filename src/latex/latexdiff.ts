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
  return runner.runDiffVcMultiple(inputFiles, commitHash);
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
