// Third-party imports
import { Effect } from 'effect';

// Internal imports
import {
  ReportReviewIssueInputSchema,
  type ReviewIssueReport,
} from '@agent/review/reviewIssues';
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { currentSession } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import { type ToolResult, ToolError } from '@shared/schemas';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { defineTool } from './core/define';
import { normalizeStructuredOutputSchema } from './structuredOutput';

const log = createLog('ReportReviewIssueTool');

const NormalizedReportReviewIssueSchema = normalizeStructuredOutputSchema(
  ReportReviewIssueInputSchema,
);

/** The review sink a host attaches, as the session exposes it. */
type ReviewIssueSink = NonNullable<HostInteractions['reportReviewIssue']>;

const report = Effect.fn('ReportReviewIssueTool.execute')(function* (
  sink: ReviewIssueSink | undefined,
  input: ReviewIssueReport,
) {
  if (!sink) {
    return executed(
      'Agent review is not available in this host.',
      'Review issue not accepted',
    );
  }

  const result = yield* Effect.try({
    try: () => sink(input),
    catch: (error) => {
      const detail = toErrorMessage(error);
      log.error(`Failed to report review issue: ${detail}`);
      return new ToolError(`Failed to report review issue: ${detail}`);
    },
  });
  if (!result.accepted) {
    return executed(
      result.reason ?? 'The review issue was not accepted.',
      'Review issue not accepted',
    );
  }
  const summary = `Reported review issue ${input.file}:${input.startLine} [${input.severity}] ${input.title}`;
  return executed(summary, summary);
});

export class ReportReviewIssueTool extends defineTool({
  name: 'report_review_issue',
  description:
    'Report one finding from an agent review of the current change set. The issue appears in the Agent Review panel and as an editor diagnostic with quick fixes. Only accepted while an agent review session is collecting issues.',
  schema: NormalizedReportReviewIssueSchema.zodSchema,
}) {
  protected execute(input: ReviewIssueReport): Promise<ToolResult> {
    // The sink is read here, in the caller's run context, and handed to the
    // program: the session is scoped to the calling turn, not to the fiber.
    return effectRuntime().runPromise(
      report(currentSession().interactions.reportReviewIssue, input),
    );
  }
}
