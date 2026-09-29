/**
 * The attempt a run has sent and not yet seen answered, and how the provider
 * rows committed before its response move it: `identified` names the
 * provider's response, `accepted` holds the background operation a resume
 * observes, and `cancelled` retires that operation after a user stop, so a
 * resume submits anew instead of observing work the user stopped.
 */
import type { InvocationRef } from '@shared/schemas';
import type { ModelOrigin, RemoteOperation } from '@texra-ai/llm/turn';
import type { ModelMessagePayload } from './ledgerTurns';

export type OpenAttempt = {
  readonly invocation: InvocationRef;
  readonly request: string; // its recorded request's address
  readonly origin: ModelOrigin;
  readonly delivery: 'stream' | 'blocking' | 'background';
  readonly providerResponseId: string | null;
  readonly returnedModel: string | null;
  readonly accepted: {
    readonly operation: RemoteOperation;
    readonly deadlineAtMs: number;
  } | null;
};

type ProviderRow = Extract<
  ModelMessagePayload,
  { kind: 'identified' | 'accepted' | 'cancelled' }
>;

/** The open attempt after provider row `p`, or why `p` cannot follow it. */
export function openAttemptAfter(
  open: OpenAttempt,
  p: ProviderRow,
): OpenAttempt | string {
  switch (p.kind) {
    case 'identified':
      return {
        ...open,
        providerResponseId: p.providerResponseId,
        returnedModel: p.returnedModel,
      };
    case 'accepted':
      return {
        ...open,
        accepted: { operation: p.operation, deadlineAtMs: p.deadlineAtMs },
      };
    case 'cancelled':
      return open.accepted === null
        ? 'cancelled names no accepted operation'
        : { ...open, accepted: null };
  }
}
