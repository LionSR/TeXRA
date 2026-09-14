// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@shared/schemas';

/**
 * Build the fabricated `AgentConfig` a tool-use child run needs to feed the
 * live wire (run registration, transcript labeling) when the run itself has
 * no ordinary launch input — a delegated CLI agent (Claude Code, Codex) or a
 * shell command. `model` is omitted for runs, like `bash`, that have none.
 */
export function buildSyntheticToolUseConfig(fields: {
  readonly agent: string;
  readonly instruction: string;
  readonly model?: string;
}): AgentConfig {
  return AgentConfigSchema.parse({
    ...fields,
    agentCategory: AgentCategory.ToolUse,
  });
}
