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
import type { AgentTrace, ToolCardHandle } from '@texra-ai/harness/plugins';
import type { ToolUseLog } from '@texra-ai/harness/schemas';

// Third-party type imports
import type { SDKBackgroundTasksChangedMessage } from '@anthropic-ai/claude-agent-sdk';

type BackgroundTasks = SDKBackgroundTasksChangedMessage['tasks'];
const CLAUDE_BACKGROUND_TASK_TOOL_NAME = 'claude:background_tasks';

function buildBackgroundTaskLog(tasks: BackgroundTasks): ToolUseLog {
  return {
    toolName: CLAUDE_BACKGROUND_TASK_TOOL_NAME,
    summary: `${tasks.length} Claude background task${tasks.length === 1 ? '' : 's'}`,
    input: { source: 'background_tasks_changed' },
    output: { tasks },
    status: 'in_progress',
  };
}

/** One-query tracker; construct a fresh instance whenever a CLI process starts. */
export class ClaudeBackgroundTaskTracker {
  private active: ToolCardHandle | undefined;

  private readonly logger: AgentTrace;
  constructor(logger: AgentTrace) {
    this.logger = logger;
  }

  replace(tasks: BackgroundTasks): void {
    const log = buildBackgroundTaskLog(tasks);
    if (tasks.length === 0) {
      this.settle(log, 'No Claude background tasks remain');
      return;
    }

    const card = this.active ?? this.logger.openToolCard(log);
    card.update(log);
    this.active = card;
  }

  /** Close the card because every query starts with an empty background set. */
  finish(): void {
    if (!this.active) return;
    this.settle(this.active.log, 'Claude session ended');
  }

  private settle(log: ToolUseLog, summary: string): void {
    if (!this.active) return;
    this.active.update({ ...log, summary, status: 'completed' });
    this.active = undefined;
  }
}
