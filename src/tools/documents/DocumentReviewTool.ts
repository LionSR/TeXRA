/**
 * The `document_review` tool: the evidence a document task's critic reviews
 * between revisions when the task reflects (`toolConfig.reflect`; the
 * recipe in `@agent/output/documentRecipe` calls it). The bundled `critic`
 * persona holds the instructions; this tool only gathers what it reads.
 */
import { Effect, FileSystem } from 'effect';
import { z } from 'zod';

import { failureContextFromLogs } from '@agent/output/compileFailureRoundContext';
import { traceFileLineage } from '@agent/output/lineageMapping';
import { fileLocationDisplayPath, type RoundOutput } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import type { Documents } from '@tools/documents/documentState';
import {
  documentsOfCall,
  RevisionSchema,
} from '@tools/documents/documentTools';
import { renderPrompt } from '@utils/prompt';
import { reportDiffTimeout, unifiedDiffText } from '@utils/text/unifiedDiff';

/** The most of one output's diff a critic reads: a whole rewrite of a long
 *  document would not fit its model's context. */
const MAX_DIFF_CHARS = 40_000;

/** `text` cut to `MAX_DIFF_CHARS`, saying so. */
const bounded = (text: string): string =>
  text.length <= MAX_DIFF_CHARS
    ? text
    : `${text.slice(0, MAX_DIFF_CHARS)}\n… (diff cut at ${MAX_DIFF_CHARS} characters of ${text.length})`;

type Round = RoundOutput | undefined;

/** A revision that wrote no documents, or not all, is evidence too: the
 *  next revision can still repair it. */
const missingEvidence = (round: Round, revision: number): string | null => {
  if ((round?.outputs.length ?? 0) === 0)
    return `<missing>Revision ${revision + 1} wrote no documents.</missing>`;
  const missing = round?.missingOutputs ?? [];
  return missing.length > 0
    ? `<missing>Not written: ${missing.join(', ')}</missing>`
    : null;
};

/** The compile result: the failed logs' excerpts when they read, else at
 *  least which outputs failed. */
const compileEvidence = Effect.fn('document_review.compile')(function* (
  round: Round,
  logger: Documents['deps']['logger'],
) {
  const failed = round?.compileFailures ?? [];
  const context = yield* failureContextFromLogs(failed, logger);
  const listed = failed
    .map((f) => `${f.displayName} failed to compile (log ${f.logRelativePath})`)
    .join('\n');
  return context ?? (listed || 'No compile failures recorded.');
});

/**
 * `document_review`: the critic's prompt for a revision — the user's
 * instruction and the requests it answered, the unified diff of each output
 * against its base, and its compile result.
 */
export const DocumentReviewTool = defineTool({
  name: 'document_review',
  description:
    "The evidence a critic reviews for a revision: the user's instruction, the task's requests so far, the diff of each output against the document it started from, and the compile result. Resolves to `{ prompt }`, to pass to the `critic` agent.",
  scriptReturns: '{ prompt: string }',
  replay: 'safe',
  schema: z.strictObject({ revision: RevisionSchema }),
  execute: Effect.fn('document_review')(function* ({ revision }) {
    const docs = yield* documentsOfCall('document_review');
    const round = docs.state.rounds.get(revision);
    const fs = yield* FileSystem.FileSystem;
    const inputs = docs.run.opening?.inputs ?? {};
    const instruction = docs.run.config.instruction.trim();
    const parts = instruction
      ? [`<instruction>\n${instruction}\n</instruction>`]
      : [];
    for (const [index, request] of docs.task.requests
      .slice(0, revision + 1)
      .entries())
      parts.push(
        `<request revision="${index + 1}">\n${(yield* renderPrompt(request, inputs)).trim()}\n</request>`,
      );
    const missing = missingEvidence(round, revision);
    if (missing) parts.push(missing);
    const mapping = traceFileLineage(docs.state, docs.baseFiles, revision);
    for (const output of round?.outputs ?? []) {
      const path = fileLocationDisplayPath(output.location);
      const base = mapping.get(path)?.base;
      // An output with no base document is new: all of it is the change.
      const before =
        base !== undefined && (yield* fs.exists(base.absolutePath))
          ? yield* fs.readFileString(base.absolutePath)
          : '';
      const after = yield* fs.readFileString(output.location.absolutePath);
      const { text, timeout } = unifiedDiffText(before, after);
      yield* reportDiffTimeout(timeout);
      parts.push(
        `<diff path="${path}">\n${text === undefined ? '(unchanged)' : bounded(text)}\n</diff>`,
      );
    }
    parts.push(
      `<compile>\n${yield* compileEvidence(round, docs.deps.logger)}\n</compile>`,
    );
    const prompt = parts.join('\n\n');
    return {
      ...executed(prompt, `Review of revision ${revision + 1}`),
      value: { prompt },
    };
  }),
});
