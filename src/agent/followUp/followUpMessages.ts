import { DELIVERY_TAG } from '@shared/deliveryTags';
import {
  deliveryTagOf,
  formatWorkflowScriptDeliverySummary,
  parseWorkflowScriptDeliverySummary,
  summarizeFollowupMessage,
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
  if (followUp.origin !== 'subagent_result') {
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
  return { text: summarizeFollowupMessage(followUp.text) };
}

export function userFollowUpInstruction(
  followUps: readonly FollowUpContent[],
): string | undefined {
  const instruction = followUps
    .filter((followUp) => followUp.origin === 'user')
    .map((followUp) => followUp.text)
    .join('\n\n')
    .trim();
  return instruction || undefined;
}
