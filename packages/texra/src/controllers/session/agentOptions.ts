/**
 * The agent options every launcher lists: the launch form's agent menu and
 * the terminal's agent list.
 */
import { Effect } from 'effect';

import { AGENT_TOOL_NAME } from '@texra-ai/harness/plugins';
import {
  AgentCatalog,
  agentToolNames,
  type WorkspaceAgentsStores,
} from '@texra-ai/harness/host';
import { agentKeyOf } from '@texra-ai/harness/schemas';
import type { AgentOptionData } from '@texra/shared/pickerOptions';
import { compareAgentsForDefault } from '@texra/shared/constants/agents';

/** The workspace's visible agents in the order every agent list shows them,
 *  so the first is the agent a new conversation starts on when none is
 *  chosen (`pickDefaultToolUseAgent`). */
export const agentOptionsData = (stores: WorkspaceAgentsStores) =>
  Effect.map(
    Effect.flatMap(AgentCatalog, (catalog) =>
      catalog.workspaceAgents(stores).visible(),
    ),
    (entries) =>
      entries
        .toSorted((a, b) => compareAgentsForDefault(a.name, b.name))
        .map((entry): AgentOptionData => ({
          value: agentKeyOf(entry),
          label: entry.name,
          isOrchestrator: agentToolNames(entry).includes(AGENT_TOOL_NAME),
          source: entry.source,
        })),
  );
