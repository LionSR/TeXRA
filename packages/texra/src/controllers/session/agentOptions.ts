/**
 * The agent options every launcher lists: the launch form's agent menu and
 * the terminal's agent list.
 */
import { Effect } from 'effect';

import { AGENT_TOOL_NAME } from '@texra-ai/harness/plugins';
import {
  AgentCatalog,
  type AgentEntry,
  type WorkspaceAgentsStores,
} from '@texra-ai/harness/host';
import { agentKeyOf } from '@texra-ai/harness/schemas';
import type { AgentOptionData } from '@texra/shared/pickerOptions';
import { PREFERRED_TOOL_USE_AGENTS } from '@texra/shared/constants/agents';

const PREFERRED: readonly string[] = PREFERRED_TOOL_USE_AGENTS;
const preferredRank = ({ name }: AgentEntry) => {
  const rank = PREFERRED.indexOf(name);
  return rank < 0 ? PREFERRED.length : rank;
};

/** The workspace's visible agents, the preferred ones first and the rest by
 *  name. */
export const agentOptionsData = (stores: WorkspaceAgentsStores) =>
  Effect.map(
    Effect.flatMap(AgentCatalog, (catalog) =>
      catalog.workspaceAgents(stores).visible(),
    ),
    (entries) =>
      entries
        .toSorted(
          (a, b) =>
            preferredRank(a) - preferredRank(b) || a.name.localeCompare(b.name),
        )
        .map((entry): AgentOptionData => ({
          value: agentKeyOf(entry),
          label: entry.name,
          isOrchestrator: entry.tools?.includes(AGENT_TOOL_NAME) === true,
          source: entry.source,
        })),
  );
