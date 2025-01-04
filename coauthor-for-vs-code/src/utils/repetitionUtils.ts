// Standard library imports
// (none needed)

// Third-party imports
import { diff_match_patch } from 'diff-match-patch';
import * as difflib from 'difflib';

// Local imports - core
import * as logger from '../logger/logUtils';

const CHANNEL = 'Repetition';
logger.initializeLogging(CHANNEL);

export interface RepetitionResult {
  massiveRepetitionDetected: boolean;
  ratio: number;
  longestMatch: string;
}

/**
 * Checks for massive repetition using diff-match-patch
 */
export function checkForMassiveRepetition(
  lastResponse: string,
  newResponse: string,
): RepetitionResult {
  try {
    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(lastResponse, newResponse);

    // Find longest common substring
    let longestMatch = '';
    for (const [type, text] of diffs) {
      if (type === 0 && text.length > longestMatch.length) {
        longestMatch = text;
      }
    }

    // Calculate similarity ratio
    const matchLength = diffs.reduce(
      (sum, [type, text]) => (type === 0 ? sum + text.length : sum),
      0,
    );
    const ratio =
      (2.0 * matchLength) / (lastResponse.length + newResponse.length);
    const massiveRepetitionDetected = longestMatch.length > 1000;

    if (massiveRepetitionDetected) {
      logger.error(CHANNEL, `Repetition ratio: ${ratio}`);
      logger.error(CHANNEL, `Longest matching substring(preview): ${longestMatch.slice(0, 400)}`);
      logger.error(CHANNEL, 'Massive repetition detected - stopping process.');
    }

    return {
      massiveRepetitionDetected,
      ratio,
      longestMatch,
    };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error checking repetition with DMP: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Checks for massive repetition using difflib (similar to Python implementation)
 */
export function checkRepetitionDifflib(
  lastResponse: string,
  newResponse: string,
): RepetitionResult {
  try {
    const sequenceMatcher = new difflib.SequenceMatcher(
      null,
      lastResponse,
      newResponse,
    );
    const ratio = sequenceMatcher.ratio();
    const match = sequenceMatcher.findLongestMatch(
      0,
      lastResponse.length,
      0,
      newResponse.length,
    );
    const longestMatch = lastResponse.slice(match[0], match[0] + match[2]);
    const massiveRepetitionDetected = longestMatch.length > 1000;

    if (massiveRepetitionDetected) {
      logger.debug(CHANNEL, `Repetition ratio: ${ratio}`);
      logger.debug(
        CHANNEL,
        `Longest matching substring (preview): ${longestMatch.slice(0, 400)}`,
      );
      logger.debug(CHANNEL, 'Massive repetition detected - stopping process.');
    }

    return {
      massiveRepetitionDetected,
      ratio,
      longestMatch,
    };
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error checking repetition with difflib: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
