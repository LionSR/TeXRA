/**
 * The one pairing every latexdiff of a document task's outputs follows: the
 * run's own `document_diff` pass and the hosts' "latexdiff this run" verb,
 * for a round that recorded no diffs, both diff the pairs
 * {@link latexdiffPairs} names, under the file names it gives them.
 */

// Local imports
import { getSafeDocumentRelativePath } from '@texra/utils/files/outputFileUtils';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import type { FileLocation } from '@texra-ai/harness/schemas';

// Local file imports
import {
  buildBetweenRoundDiffSuffix,
  WORKSPACE_DIFF_SUFFIX,
} from './diffFileNameManager';

/** One latexdiff a round's recorded outputs call for. */
export interface LatexdiffPair {
  /** The round's output the diff marks up. */
  readonly revised: OutputFileInfo;
  /** Its document: its source as the round wrote it, a relative path. */
  readonly document: string;
  /** What it is diffed against. */
  readonly base: FileLocation;
  /** The round `base` came from; null for the document the task started
   *  from. */
  readonly baseRound: number | null;
  /** What the diff file's name adds to the revised file's stem. */
  readonly suffix: string;
}

/**
 * The latexdiffs a round's recorded `outputs` call for: each output against
 * the document it started from (its recorded lineage's base), then each
 * against its own output in the `previous` round (empty when between-round
 * diffs are off). An output's document is its source as the round wrote it
 * (`getSafeDocumentRelativePath`), never its basename: `a/main.tex` and
 * `b/main.tex` are two documents.
 */
export function latexdiffPairs(
  outputs: readonly OutputFileInfo[],
  previous: readonly OutputFileInfo[],
): LatexdiffPair[] {
  const documents = outputs.map((revised) => ({
    revised,
    document: getSafeDocumentRelativePath(revised.source),
  }));
  const fromBase = documents.flatMap(
    ({ revised, document }): LatexdiffPair[] => {
      const base = revised.lineage?.base;
      return base
        ? [
            {
              revised,
              document,
              base,
              baseRound: null,
              suffix: WORKSPACE_DIFF_SUFFIX,
            },
          ]
        : [];
    },
  );
  const previousByDocument = new Map(
    previous.map((info) => [getSafeDocumentRelativePath(info.source), info]),
  );
  const fromPrevious = documents.flatMap(
    ({ revised, document }): LatexdiffPair[] => {
      const prior = previousByDocument.get(document);
      return prior
        ? [
            {
              revised,
              document,
              base: prior.location,
              baseRound: prior.round,
              suffix: buildBetweenRoundDiffSuffix(revised.round, prior.round),
            },
          ]
        : [];
    },
  );
  return [...fromBase, ...fromPrevious];
}
