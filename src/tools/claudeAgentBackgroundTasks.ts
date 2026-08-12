/**
 * Project Claude Code's process-local background-task level signal onto one
 * ordinary TeXRA tool card inside the owning `claude_code` stream.
 *
 * These are not TeXRA child executions: the SDK supplies no TeXRA stream or
 * execution identity. The SDK also specifies that this level must not be
 * paired with task edge messages, whose ordering is independent. Replacing
 * the card from each full snapshot therefore keeps the adapter small and
 * preserves TeXRA's execution registry as the sole child-stream owner.
 */

// Local imports
import {
  emitToolUseCard,
  endToolUseCard,
  type AgentTrace,
  type ToolUseCardRef,
} from '@agent/trace';
import type { ToolUseLog } from '@shared/schemas';

// Third-party type imports
import type { SDKBackgroundTasksChangedMessage } from '@anthropic-ai/claude-agent-sdk';

type BackgroundTasks = SDKBackgroundTasksChangedMessage['tasks'];

function buildBackgroundTaskLog(tasks: BackgroundTasks): ToolUseLog {
  return {
    toolName: 'claude:background_tasks',
    summary: `${tasks.length} Claude background task${tasks.length === 1 ? '' : 's'}`,
    input: { source: 'background_tasks_changed' },
    output: { tasks },
    status: 'in_progress',
  };
}

/** One-query tracker; construct a fresh instance whenever a CLI process starts. */
export class ClaudeBackgroundTaskTracker {
  private active:
    { readonly ref: ToolUseCardRef; readonly log: ToolUseLog } | undefined;

  constructor(private readonly logger: AgentTrace) {}

  replace(tasks: BackgroundTasks): void {
    if (tasks.length === 0) {
      this.finish('No Claude background tasks remain', tasks);
      return;
    }

    const log = buildBackgroundTaskLog(tasks);
    if (!this.active) {
      const ref = emitToolUseCard(this.logger, log);
      endToolUseCard(this.logger, ref, log, 'in_progress');
      this.active = { ref, log };
      return;
    }
    endToolUseCard(this.logger, this.active.ref, log, 'in_progress');
    this.active = { ...this.active, log };
  }

  /** Close the card because every query starts with an empty background set. */
  finish(summary = 'Claude session ended', tasks?: BackgroundTasks): void {
    if (!this.active) return;
    const { status: _status, ...baseLog } = tasks
      ? buildBackgroundTaskLog(tasks)
      : this.active.log;
    endToolUseCard(
      this.logger,
      this.active.ref,
      { ...baseLog, summary },
      'completed',
    );
    this.active = undefined;
  }
}
