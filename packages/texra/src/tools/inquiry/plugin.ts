/** The external-inquiry plugin: its tool, thread rows and decision, and its card. */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { APP_FACT_KINDS } from '@texra/shared/plugins/appFactKinds';
import {
  INQUIRY_REQUEST,
  InquiryRequestSchema,
} from '@texra/shared/plugins/externalInquiry';
import type { TexraPlugin } from '@texra/tools/registry';
import { ExternalInquiryTool } from './ExternalInquiryTool';
import { recordInquiryDecision } from './inquiryActions';
import { inquiryRecordsLayer } from './inquiryRecords';

export const externalInquiry: TexraPlugin = {
  id: INQUIRY_REQUEST.plugin,
  tools: [ExternalInquiryTool],
  factKinds: APP_FACT_KINDS['external-inquiry'],
  toggle: 'off',
  // The answer is recorded on the thread before the decision commits; the
  // thread's row and the continuation to the run that asked commit with it.
  decision: {
    record: ({ payload, decision }) =>
      Schema.decodeUnknownEffect(InquiryRequestSchema)(payload.data).pipe(
        Effect.flatMap((inquiry) => recordInquiryDecision(inquiry, decision)),
        Effect.provide(inquiryRecordsLayer),
      ),
  },
  card: {
    name: 'External Inquiry',
    description:
      'Use premium chat subscriptions such as ChatGPT Pro, Claude Opus, Gemini Deep Think, and Grok without an API key. The agent drafts a question, you paste the answer back, and the run continues. Useful for the deep-reasoning tiers that aren’t available through the API.',
    setup: {
      configNotes:
        'No local install required. Uses your own external chat subscription through a human-in-the-loop copy/paste flow.',
      authNote: 'Uses your premium chat subscription',
    },
  },
};
