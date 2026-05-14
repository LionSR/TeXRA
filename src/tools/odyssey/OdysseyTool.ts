import { platform } from '@platform/platform';
import { formatOdysseyTime } from '@agent/odyssey/formatOdysseyTime';
import { tryUseRunContext } from '@agent/runtime/RunContext';

import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import { requireNonEmptyString } from '../utils';

import {
  ODYSSEY_TOOL_NAME,
  ODYSSEY_FEATURE_FLAG_KEY,
  OdysseyToolInputSchema,
  type Odyssey,
  type OdysseyToolInput,
} from './odysseyMeta';
import { OdysseyStore } from './odysseyStore';

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}K`;
}

function formatView(odyssey: Odyssey): string {
  const lines = [
    `Odyssey: ${odyssey.odysseyId}`,
    `Status: ${odyssey.status}`,
    `Objective: ${odyssey.objective}`,
    `Tokens used: ${formatTokens(odyssey.tokensUsed)}`,
    `Time elapsed: ${formatOdysseyTime(odyssey.timeUsedMs)}`,
  ];
  if (odyssey.completedReason) {
    lines.push(`Completion reason: ${odyssey.completedReason}`);
  }
  if (odyssey.history.length > 0) {
    lines.push('');
    lines.push('Recent events:');
    for (const event of odyssey.history.slice(-10)) {
      const detail = event.detail ? ` — ${event.detail}` : '';
      lines.push(`  [${event.at}] ${event.kind}${detail}`);
    }
  }
  return lines.join('\n');
}

/**
 * Odyssey tool — manage a persistent autonomous objective for the current
 * stream. Single tool with a `command` enum discriminator, mirroring the
 * MemoryTool pattern.
 *
 * The tool itself does not start the continuation loop; that lives in
 * ToolUseWaitNode.exec(). The tool's role is to expose the four model-facing
 * verbs (view, start, pause, complete) and to gate everything on the
 * experimental feature flag.
 */
export class OdysseyTool extends defineTool({
  name: ODYSSEY_TOOL_NAME,
  description: `Manage the autonomous Odyssey for this conversation.

Commands:
- view: Read the current odyssey state (objective, status, history, time/tokens used).
- start: Propose and start a new odyssey toward a stated objective. Only valid when no odyssey is active.
- pause: Self-pause the odyssey when you cannot proceed without user input. Provide a reason describing what you need from the user.
- complete: Mark the odyssey complete. Provide a reason describing HOW you verified completion against current external state (filesystem, command output, test results) — never conversation memory.`,
  schema: OdysseyToolInputSchema,
}) {
  protected async execute(input: OdysseyToolInput): Promise<ToolResult> {
    if (!platform().config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false)) {
      throw new ToolError(
        `The odyssey feature is disabled. Enable it with the ` +
          `"${ODYSSEY_FEATURE_FLAG_KEY}" setting.`,
      );
    }

    const ctx = tryUseRunContext();
    const streamId = ctx?.streamId;
    if (!streamId) {
      throw new ToolError(
        'odyssey tool requires an active stream context; ' +
          'no streamId available in the current run.',
      );
    }

    switch (input.command) {
      case 'view':
        return this.view(streamId);
      case 'start':
        return this.start(
          streamId,
          requireNonEmptyString(input.objective, 'objective'),
        );
      case 'pause':
        return this.pause(
          streamId,
          requireNonEmptyString(input.reason, 'reason'),
        );
      case 'complete':
        return this.complete(
          streamId,
          requireNonEmptyString(input.reason, 'reason'),
        );
      default:
        throw new ToolError(
          `Unrecognized command: ${(input as { command: string }).command}`,
        );
    }
  }

  private async view(streamId: string): Promise<ToolResult> {
    const odyssey = OdysseyStore.getForStream(streamId);
    if (!odyssey) {
      return {
        summary: 'No odyssey set for this stream.',
        output:
          'No odyssey is currently set for this stream. ' +
          'Use command="start" with an objective to begin one.',
      };
    }
    return {
      summary: `Odyssey ${odyssey.status} — ${odyssey.objective.slice(0, 80)}`,
      output: formatView(odyssey),
    };
  }

  private async start(
    streamId: string,
    objective: string,
  ): Promise<ToolResult> {
    const odyssey = await OdysseyStore.start(streamId, objective);
    return {
      summary: `Odyssey started: ${odyssey.objective.slice(0, 80)}`,
      output:
        `Odyssey ${odyssey.odysseyId} is now active. ` +
        `Continue working toward the objective; call command="complete" ` +
        `when you have verified the stopping condition against current external state.\n\n` +
        formatView(odyssey),
    };
  }

  private async pause(streamId: string, reason: string): Promise<ToolResult> {
    const odyssey = OdysseyStore.getForStream(streamId);
    if (!odyssey) {
      throw new ToolError('No odyssey to pause.');
    }
    if (odyssey.status !== 'active') {
      return {
        summary: `Odyssey already ${odyssey.status}; nothing to pause.`,
        output: `Odyssey is ${odyssey.status}; pause is a no-op.`,
      };
    }
    const updated =
      (await OdysseyStore.setStatus(streamId, 'paused', reason)) ?? odyssey;
    return {
      summary: 'Odyssey paused.',
      output: `Odyssey paused: ${reason}\n\n${formatView(updated)}`,
    };
  }

  private async complete(
    streamId: string,
    reason: string,
  ): Promise<ToolResult> {
    const odyssey = OdysseyStore.getForStream(streamId);
    if (!odyssey) {
      throw new ToolError('No odyssey to complete.');
    }
    if (odyssey.status === 'complete') {
      return {
        summary: 'Odyssey already complete.',
        output: `Odyssey is already complete. Reason on record: ${odyssey.completedReason ?? '(none)'}`,
      };
    }
    if (odyssey.status === 'abandoned') {
      throw new ToolError(
        'Odyssey was abandoned by the user; complete is rejected. ' +
          'The user must start a new odyssey explicitly.',
      );
    }
    const updated =
      (await OdysseyStore.setStatus(streamId, 'complete', reason)) ?? odyssey;
    return {
      summary: 'Odyssey complete.',
      output:
        `Odyssey ${updated.odysseyId} marked complete.\n\n` +
        `Reason: ${reason}\n\n` +
        `The autonomous continuation loop has stopped. ` +
        `Returning control to the user.`,
    };
  }
}
