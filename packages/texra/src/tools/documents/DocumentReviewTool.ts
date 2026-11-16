/**
 * The `document_review` tool: the evidence about a revision that a document
 * program checks, or hands a critic, between revisions (`revise` in
 * `@texra/tools/theory/programs` calls it). The program holds the critic's
 * instructions and its own checks; this tool only gathers what they read.
 */
import { formatRoundLabel } from '@texra/shared/plugins/documentOutputs';
import { Effect, FileSystem, Schema } from 'effect';

import { meansAbsent } from '@texra-ai/harness/node';
import { executed, defineTool } from '@texra-ai/harness/plugins';
import { fileLocationDisplayPath } from '@texra-ai/harness/schemas';
import { failureContextFromLogs } from '@texra/agent/output/compileFailureRoundContext';
import { roundOf, type Documents } from '@texra/tools/documents/documentState';
import {
  documentsOfCall,
  RevisionSchema,
} from '@texra/tools/documents/documentTools';
import type { RoundOutput } from '@texra/shared/plugins/documentOutputs';
import { unifiedDiffOf } from '@texra/tools/documents/documentResult';

/** The most diff a critic reads, across all outputs: a whole rewrite of a
 *  long document would not fit its model's context. */
const MAX_DIFF_CHARS = 60_000;

/** `text` cut to the `left` budget, saying so. */
const bounded = (text: string, left: number): string =>
  text.length <= left
    ? text
    : `${text.slice(0, Math.max(0, left))}\n… (diff cut: ${text.length} characters, over the review's budget)`;

type Round = RoundOutput | undefined;

/** A revision that wrote no documents, or not all, is evidence too: the
 *  next revision can still repair it. */
const missingEvidence = (round: Round, revision: number): string | null => {
  if ((round?.outputs.length ?? 0) === 0)
    return `<missing>${formatRoundLabel(revision)} wrote no documents.</missing>`;
  const missing = round?.missingOutputs ?? [];
  return missing.length > 0
    ? `<missing>Not written: ${missing.join(', ')}</missing>`
    : null;
};

/** The compile result: the failed logs' excerpts when they read, else at
 *  least which outputs failed. */
const compileEvidence = Effect.fn('document_review.compile')(function* (
  round: Round,
  logger: Documents['run']['logger'],
) {
  const compile = round?.compile;
  if (compile?._tag !== 'checked')
    return `No compile check ran${compile ? `: ${compile.reason}` : ''}. The documents are unverified.`;
  const failed = compile.failures;
  const read = yield* failureContextFromLogs(failed);
  if (read.kind === 'unreadable') logger.warn(read.warning);
  const context = read.kind === 'context' ? read.text : undefined;
  const listed = failed
    .map((f) => `${f.displayName} failed to compile (log ${f.logRelativePath})`)
    .join('\n');
  return context ?? (listed || 'No compile failures recorded.');
});

/**
 * `document_review`: the evidence about a revision: the user's instruction
 * and the requests it answered, the unified diff of each output against
 * its base, and its compile result.
 */
export const DocumentReviewTool = defineTool({
  name: 'document_review',
  description:
    "The evidence about a revision: the user's instruction, the task's requests so far, the diff of each output against the document it started from, and the compile result. Resolves to `{ prompt, diffs }`: `prompt` holds it all for a critic's `agent()` call, and `diffs` lists each output's unified diff as `{ path, text, cut }` (`text` null for an unchanged output, `cut` when it was too long to show whole) for a check in code.",
  scriptReturns:
    '{ prompt: string; diffs: { path: string; text: string | null; cut: boolean }[] }',
  replay: 'safe',
  schema: Schema.Struct({ revision: RevisionSchema }),
  execute: Effect.fn('document_review')(function* ({ revision }) {
    const docs = yield* documentsOfCall();
    const { requests } = docs.task;
    const round = roundOf(docs.rounds, revision);
    const fs = yield* FileSystem.FileSystem;
    const instruction = docs.run.config.instruction.trim();
    const parts = instruction
      ? [`<instruction>\n${instruction}\n</instruction>`]
      : [];
    for (const [index, request] of requests.slice(0, revision + 1).entries())
      parts.push(
        `<request revision="${index + 1}">\n${request.trim()}\n</request>`,
      );
    const missing = missingEvidence(round, revision);
    if (missing) parts.push(missing);
    // Each output's diff is computed concurrently; the budget below is
    // spent in output order.
    const diffs = yield* Effect.forEach(
      round?.outputs ?? [],
      Effect.fnUntraced(function* (output) {
        // The base its extraction recorded; an output with none is new: all
        // of it is the change. A base that is gone reads as empty.
        const base = output.lineage?.base;
        const before =
          base === undefined
            ? ''
            : yield* fs
                .readFileString(base.absolutePath)
                .pipe(Effect.catchIf(meansAbsent, () => Effect.succeed('')));
        const after = yield* fs.readFileString(output.location.absolutePath);
        return {
          path: fileLocationDisplayPath(output.location),
          text: yield* unifiedDiffOf(before, after),
        };
      }),
      { concurrency: 8 },
    );
    let left = MAX_DIFF_CHARS;
    const shownDiffs = diffs.map(({ path, text }) => {
      const shown = text === undefined ? '(unchanged)' : bounded(text, left);
      left -= shown.length;
      parts.push(`<diff path="${path}">\n${shown}\n</diff>`);
      return {
        path,
        text: text === undefined ? null : shown,
        cut: text !== undefined && shown !== text,
      };
    });
    parts.push(
      `<compile>\n${yield* compileEvidence(round, docs.run.logger)}\n</compile>`,
    );
    const prompt = parts.join('\n\n');
    return {
      ...executed(prompt, `${formatRoundLabel(revision)} review`),
      value: { prompt, diffs: shownDiffs },
    };
  }),
});
