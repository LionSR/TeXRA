import { DELIVERY_TAG } from '@shared/deliveryTags';
import {
  deliveryTagOf,
  formatWorkflowScriptDeliverySummary,
  parseWorkflowScriptDeliverySummary,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';
import type {
  FollowUpContent,
  WorkflowScriptDeliverySummary,
} from '@shared/schemas';

interface FollowUpDisplay {
  readonly text: string;
  /** Typed workflow delivery facts logged beside the collapsed row text. */
  readonly workflowSummary?: WorkflowScriptDeliverySummary;
}

export function followUpDisplay(followUp: FollowUpContent): FollowUpDisplay {
  if (followUp.displayText != null) {
    return { text: followUp.displayText };
  }
  const { from } = followUp;
  if (from.kind !== 'run' || from.relation !== 'child') {
    return { text: followUp.text };
  }
  // This is where a delivery envelope becomes a transcript row: parse the
  // workflow summary once here and carry it structured, so renderers never
  // re-extract it from the rendered text. Only the workflow envelopes own a
  // `<workflow-summary>` element — other tags' bodies are entity-escaped.
  const tag = deliveryTagOf(followUp.text);
  const workflowSummary =
    tag === DELIVERY_TAG.workflowScriptResult ||
    tag === DELIVERY_TAG.workflowScriptError
      ? parseWorkflowScriptDeliverySummary(followUp.text)
      : undefined;
  if (workflowSummary) {
    return {
      text: formatWorkflowScriptDeliverySummary(workflowSummary),
      workflowSummary,
    };
  }
  return { text: summarizeSubagentFollowup(followUp.text) };
}

/** Input that asks the run to do something: its user's and its parent's.
 *  A child's report, any other run's message and a host notice inform the
 *  run and never instruct it. */
export function isInstruction({ from }: FollowUpContent): boolean {
  return (
    from.kind === 'user' || (from.kind === 'run' && from.relation === 'parent')
  );
}

/** What the run was asked to do, joined from its instructing input. */
export function userFollowUpInstruction(
  followUps: readonly FollowUpContent[],
): string | undefined {
  const instruction = followUps
    .filter(isInstruction)
    .map((followUp) => followUp.text)
    .join('\n\n')
    .trim();
  return instruction || undefined;
}
