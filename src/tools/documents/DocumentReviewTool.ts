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
import { fileLocationDisplayPath, ToolError } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import {
  documentsOfCall,
  RevisionSchema,
} from '@tools/documents/documentTools';
import { renderPrompt } from '@utils/prompt';
import { reportDiffTimeout, unifiedDiffText } from '@utils/text/unifiedDiff';

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
    if (round === undefined || round.outputs.length === 0)
      return yield* Effect.fail(
        new ToolError(`Revision ${revision + 1} has no outputs to review.`),
      );
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
    const mapping = traceFileLineage(docs.state, docs.baseFiles, revision);
    for (const output of round.outputs) {
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
      parts.push(`<diff path="${path}">\n${text ?? '(unchanged)'}\n</diff>`);
    }
    const failures = yield* failureContextFromLogs(
      round.compileFailures,
      docs.deps.logger,
    );
    parts.push(
      `<compile>\n${failures ?? 'No compile failures recorded.'}\n</compile>`,
    );
    const prompt = parts.join('\n\n');
    return {
      ...executed(prompt, `Review of revision ${revision + 1}`),
      value: { prompt },
    };
  }),
});
