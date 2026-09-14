/**
 * The runtime request protocol (PRD one-fold-three-renderers, 8.2): one Zod
 * union of the requests a surface issues to its session's runtime and the
 * outcomes the runtime answers with. In process (the TUI, headless) the
 * Effect's own result is the response and no message exists; the envelope
 * and response a bridge posts (8.4) arrive with that bridge.
 *
 * Arm tags are `group.action` throughout, so two groups cannot claim one
 * tag. Every run-scoped arm names a bare `runId`: a `RunId` names one run
 * for its whole life (decision 9), so a request that waits while its run is
 * deleted can only miss, never land on a different run.
 * The union carries the arms the runtime answers today; a lane that routes
 * another retained command adds its arm with its handler.
 */
import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import {
  RequestDecisionSchema,
  RunIdSchema,
  WorkflowControlActionSchema,
} from '@shared/schemas';

const runScoped = { runId: RunIdSchema };

export const RuntimeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run.stop'),
    ...runScoped,
    detachActiveChildren: z.boolean().nullish(),
  }),
  z.object({ kind: z.literal('run.delete'), ...runScoped }),
  z.object({ kind: z.literal('run.compact'), ...runScoped }),
  z.object({
    kind: z.literal('followUp.send'),
    ...runScoped,
    text: z.string().min(1),
    displayText: z.string().nullish(),
    mediaFiles: z.array(z.string()).nullish(),
  }),
  /**
   * The one answer to a `request.opened` (one run model, section 3.7): the
   * decision lands as that run's `request.decided` row, which is what the
   * waiting run, the recovery bindings, and every surface read. A decision
   * for a request its run is not parked on is delivered as a follow-up.
   * `useOwnApiKey` is the host command that ends in
   * `{ action: 'retry', credentials: 'personal' }` here.
   */
  z.object({
    kind: z.literal('request.decide'),
    ...runScoped,
    requestId: z.string().min(1),
    decision: RequestDecisionSchema,
  }),
  /** The field-level mutation, not a snapshot: the authority applies it and
   *  publishes the resulting `approval.policy` (PRD 6, item 2). */
  z.object({
    kind: z.literal('policy.set'),
    change: z.object({
      field: z.literal('bypass'),
      ...runScoped,
      bypass: z.enum(APPROVAL_BYPASS_KINDS),
      enabled: z.boolean(),
    }),
  }),
  /** A workflow-script run's grandchild `agent()` call. `childRunId` is
   *  that call's own run, never the workflow run's: the control acts on one
   *  call, so concurrent skips and retries stay one request per target and
   *  the runtime's refusal names the call it acted on. It is the id the
   *  child list, focus, and kill already share. */
  z.object({
    kind: z.literal('workflow.control'),
    ...runScoped,
    childRunId: RunIdSchema,
    action: WorkflowControlActionSchema,
  }),
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

/** What the runtime answers with: a typed value the host renders. */
export const OutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({
    kind: z.literal('followUp'),
    status: z.enum(['sent', 'queued']),
    /** A queued input whose recovery wake did not reach the run. */
    wake: z.literal('failed').nullish(),
  }),
  z.object({
    kind: z.literal('deleted'),
    result: z.enum(['deleted', 'active', 'failed', 'superseded']),
  }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;
