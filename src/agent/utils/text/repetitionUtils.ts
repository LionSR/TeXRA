// Third-party imports
import { diff_match_patch } from 'diff-match-patch';

// Local imports - logging
import {
  REPETITION_DETECTION_THRESHOLD,
  REPETITION_PREVIEW_LENGTH,
} from '@agent/core/constants';
import * as logger from '@logger/logUtils';

const CHANNEL = 'repetitionUtils';
logger.initialize(CHANNEL);

export interface RepetitionResult {
  massiveRepetitionDetected: boolean;
  ratio: number;
  longestMatch: string;
}

/**
 * Checks for massive repetition between two responses using diff-match-patch.
 * Returns true if the longest matching substring exceeds the threshold.
 */
export function checkForMassiveRepetition(
  lastResponse: string,
  newResponse: string,
): RepetitionResult {
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
  const massiveRepetitionDetected =
    longestMatch.length > REPETITION_DETECTION_THRESHOLD;

  if (massiveRepetitionDetected) {
    const preview = longestMatch.slice(0, REPETITION_PREVIEW_LENGTH);
    logger.error(
      CHANNEL,
      `Massive repetition detected - ratio: ${ratio}, preview: ${preview}. Stopping process.`,
    );
  }

  return {
    massiveRepetitionDetected,
    ratio,
    longestMatch,
  };
}
