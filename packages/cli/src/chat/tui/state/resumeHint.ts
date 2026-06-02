// Builds the "Resume this session with: …" hint printed to scrollback on exit.
//
// Lists the main session plus each resumable tool-use subagent so any route
// can be continued by its own id. Workflows are excluded — they don't resume
// (only tool-use agents do). Reads only the in-memory stream tree, which still
// holds finished subagents for the session, so no exit-time disk I/O is needed.

import { AGENT_CATEGORY, type StreamTabId } from '@shared/schemas';

import type { StreamSlice } from './cliState';

export interface ResumeTarget {
  readonly executionId: string;
  /** Human label for the route (agent name for subagents, "main" for root). */
  readonly label: string;
  readonly isRoot: boolean;
}

export interface ResumeTargetsInput {
  readonly rootExecutionId: string | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}

/** The main session followed by each tool-use subagent (any depth), deduped by
 *  executionId. Subagents whose stream isn't a tool-use agent — workflow
 *  children, tool processes — are skipped because they can't be resumed. */
export function collectResumeTargets({
  rootExecutionId,
  streams,
}: ResumeTargetsInput): readonly ResumeTarget[] {
  const targets: ResumeTarget[] = [];
  const seen = new Set<string>();

  if (rootExecutionId) {
    targets.push({ executionId: rootExecutionId, label: 'main', isRoot: true });
    seen.add(rootExecutionId);
  }

  for (const slice of streams.values()) {
    for (const child of slice.childStreams) {
      if (!child.childStreamId || seen.has(child.executionId)) continue;
      const childSlice = streams.get(child.childStreamId);
      if (childSlice?.category !== AGENT_CATEGORY.TOOL_USE) continue;
      seen.add(child.executionId);
      targets.push({
        executionId: child.executionId,
        label: child.agentName || child.toolName || child.executionId,
        isRoot: false,
      });
    }
  }

  return targets;
}

/** Multi-line reopen hint, or undefined when there's nothing to resume. */
export function formatResumeHint(
  targets: readonly ResumeTarget[],
): string | undefined {
  if (targets.length === 0) return undefined;
  const lines = ['Resume this session with:'];
  for (const target of targets) {
    lines.push(`  texra --resume ${target.executionId}  (${target.label})`);
  }
  return lines.join('\n');
}
