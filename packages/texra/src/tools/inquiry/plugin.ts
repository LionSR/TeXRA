/** The external-inquiry plugin: its tool, thread rows and decision, and its card. */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { ALWAYS_AVAILABLE } from '@texra-ai/harness/plugins';
import { APP_PLUGIN_ARMS } from '@texra/shared/plugins/appArms';
import type { TexraPlugin } from '@texra/tools/registry';
import { ExternalInquiryTool } from './ExternalInquiryTool';
import { recordInquiryDecision } from './inquiryActions';
import { inquiryRecordsLayer } from './inquiryRecords';

export const externalInquiry: TexraPlugin = {
  id: 'external-inquiry',
  tools: [ExternalInquiryTool],
  arms: APP_PLUGIN_ARMS['external-inquiry'],
  toggle: 'off',
  availability: ALWAYS_AVAILABLE,
  // The answer is recorded on the thread and delivered to the run that
  // asked, before the decision commits.
  decision: {
    kind: 'externalInquiry',
    record: ({ payload, decision, inbox, commit }) =>
      payload.kind === 'externalInquiry'
        ? recordInquiryDecision(payload.data, decision, inbox, commit).pipe(
            Effect.provide(inquiryRecordsLayer),
          )
        : Effect.die(
            new Error(`external-inquiry records no ${payload.kind} decision.`),
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
