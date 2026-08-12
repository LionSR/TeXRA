// Third-party imports
import { z } from 'zod';

// Internal imports
import { REVIEW_SEVERITIES } from '@agent/review/reviewIssues';
import { currentSession } from '@agent/runtime/SessionHandle';
import { createLog } from '@logger/logUtils';
import { type ToolResult, ToolError } from '@shared/schemas/toolResult';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { defineTool } from './core/define';
import { normalizeStructuredOutputSchema } from './structuredOutput';

const log = createLog('ReportReviewIssueTool');

const ReportReviewIssueInputSchema = z.strictObject({
  file: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Repository-relative path of the file the issue is in, exactly as it appears in the diff.',
    ),
  startLine: z
    .int()
    .min(1)
    .describe(
      '1-based line number in the current version of the file where the issue starts.',
    ),
  endLine: z
    .int()
    .min(1)
    .nullish()
    .describe('Optional 1-based inclusive end line of the issue.'),
  severity: z
    .enum(REVIEW_SEVERITIES)
    .describe(
      'critical = bug, security problem, or accidental commit; warning = likely problem worth fixing; info = minor but material.',
    ),
  title: z.string().trim().min(1).describe('Short one-line summary.'),
  description: z
    .string()
    .describe('What is wrong and why it matters, in 1-3 sentences.'),
  suggestion: z.string().nullish().describe('Optional concrete fix.'),
});

type ReportReviewIssueInput = z.infer<typeof ReportReviewIssueInputSchema>;
const NormalizedReportReviewIssueSchema = normalizeStructuredOutputSchema(
  ReportReviewIssueInputSchema,
);

export class ReportReviewIssueTool extends defineTool({
  name: 'report_review_issue',
  description:
    'Report one finding from an agent review of the current change set. The issue appears in the Agent Review panel and as an editor diagnostic with quick fixes. Only accepted while an agent review session is collecting issues.',
  schema: NormalizedReportReviewIssueSchema.zodSchema,
}) {
  protected async execute(input: ReportReviewIssueInput): Promise<ToolResult> {
    const sink = currentSession().interactions.reportReviewIssue;
    if (!sink) {
      return executed(
        'Agent review is not available in this host.',
        'Review issue not accepted',
      );
    }

    try {
      const result = sink({
        file: input.file,
        startLine: input.startLine,
        endLine: input.endLine ?? undefined,
        severity: input.severity,
        title: input.title,
        description: input.description,
        suggestion: input.suggestion ?? undefined,
      });
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
