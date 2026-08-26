// Internal imports
import {
  ReportReviewIssueInputSchema,
  type ReviewIssueReport,
} from '@agent/review/reviewIssues';
import { currentSession } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
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

export class ReportReviewIssueTool extends defineTool({
  name: 'report_review_issue',
  description:
    'Report one finding from an agent review of the current change set. The issue appears in the Agent Review panel and as an editor diagnostic with quick fixes. Only accepted while an agent review session is collecting issues.',
  schema: NormalizedReportReviewIssueSchema.zodSchema,
}) {
  protected async execute(input: ReviewIssueReport): Promise<ToolResult> {
    const sink = currentSession().interactions.reportReviewIssue;
    if (!sink) {
      return executed(
        'Agent review is not available in this host.',
        'Review issue not accepted',
      );
    }

    try {
      const result = sink(input);
      if (!result.accepted) {
        return executed(
          result.reason ?? 'The review issue was not accepted.',
          'Review issue not accepted',
        );
      }
      const summary = `Reported review issue ${input.file}:${input.startLine} [${input.severity}] ${input.title}`;
      return executed(summary, summary);
    } catch (error) {
      const detail = toErrorMessage(error);
      log.error(`Failed to report review issue: ${detail}`);
      throw new ToolError(`Failed to report review issue: ${detail}`);
    }
  }
}
