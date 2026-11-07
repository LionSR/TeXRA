import { qualifyAggregateId, type SessionRowDraft } from '@shared/schemas';
import { inquiryThreadFact } from '@texra/shared/plugins/externalInquiry';

/** An inquiry thread's row as a decision commits it, under the run that
 *  asked (none for a thread no run owns). */
export const inquiryThreadRow = (
  summary: Parameters<typeof inquiryThreadFact>[0],
): Extract<SessionRowDraft, { type: 'plugin.fact' }> => {
  const { aggregate, ...fact } = inquiryThreadFact(summary);
  return {
    type: 'plugin.fact',
    aggregateId: qualifyAggregateId('plugin', aggregate),
    ...fact,
    parent: summary.parentRunId,
  };
};
