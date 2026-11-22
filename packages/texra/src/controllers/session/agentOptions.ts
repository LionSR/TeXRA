/**
 * The agent options every launcher lists: the launch form's agent menu and
 * the terminal's agent list.
 */
import { Effect } from 'effect';

import { AGENT_TOOL_NAME } from '@texra-ai/harness/builtins';
import { AgentCatalog, agentToolNames } from '@texra-ai/harness/host';
import { agentKeyOf } from '@texra-ai/harness/schemas';
import type { AgentOptionData } from '@texra/shared/pickerOptions';
import { compareAgentsForDefault } from '@texra/shared/constants/agents';

/** Every agent in the order every agent list shows them, so the first is
 *  the agent a new conversation starts on when none is chosen
 *  (`pickDefaultToolUseAgent`). */
export const agentOptionsData = Effect.map(AgentCatalog, (catalog) =>
  catalog
    .list()
    .toSorted((a, b) => compareAgentsForDefault(a.name, b.name))
    .map((entry): AgentOptionData => ({
      value: agentKeyOf(entry),
      label: entry.name,
      isOrchestrator: agentToolNames(entry).includes(AGENT_TOOL_NAME),
      source: entry.source,
    })),
);
