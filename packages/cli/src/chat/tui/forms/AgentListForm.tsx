// `/agent` form. It lists the visible agents. Before the first message, one
// can be chosen to lead the chat.

import { Box, Text } from 'ink';
import { Effect } from 'effect';

import { AgentCatalog } from '@texra-ai/harness/host';
import { agentName } from '@texra-ai/harness/schemas';
import type { SelectItem } from '@cli/tui/ui/Select';
import {
  isAgentOption,
  type AgentOptionData,
} from '@texra/shared/pickerOptions';
import { agentOptionsData } from '@texra/controllers/session/agentOptions';

import { AsyncListForm } from './_shared/ListForm';
import { useChatProcess } from '../chatProcess';

interface AgentListFormProps {
  readonly currentAgent: string;
  readonly availableRows?: number;
  readonly selectable: boolean;
  /** Takes the picked agent's key. */
  readonly onSelect?: (agent: string) => void;
  readonly onClose: () => void;
}

type AgentRow = AgentOptionData & { readonly description?: string };

function agentPickerItems(
  agents: readonly AgentRow[],
): ReadonlyArray<SelectItem<string>> {
  return agents.map(({ description, ...agent }) => ({
    value: agent.value,
    label: agent.label,
    ...(description ? { description } : {}),
  }));
}

type AgentIdentity = Pick<AgentOptionData, 'label' | 'value'>;
type AgentDelegationFlag = Pick<AgentOptionData, 'isOrchestrator'>;

function agentPickerPrimarySectionTitle(
  agents: readonly AgentDelegationFlag[],
): string {
  const hasDelegatingAgents = agents.some(
    (agent) => agent.isOrchestrator === true,
  );
  const hasSpecialists = agents.some((agent) => agent.isOrchestrator !== true);
  return hasDelegatingAgents && !hasSpecialists
    ? 'Delegating agents'
    : 'Agents';
}

function currentVisibleAgent(
  agents: readonly AgentIdentity[],
  currentAgent: string,
): AgentIdentity | undefined {
  const current = currentAgent.trim();
  return agents.find((agent) => isAgentOption(agent.value, current));
}

function hiddenCurrentAgentHint(
  agents: readonly AgentIdentity[],
  currentAgent: string,
): string | undefined {
  const current = currentAgent.trim();
  if (!current || currentVisibleAgent(agents, current)) return undefined;
  return `Current: ${agentName(current)} (hidden from picker)`;
}

export function AgentListForm(props: AgentListFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  const hintRow = (agents: readonly AgentRow[]): React.JSX.Element | null => {
    const hint = hiddenCurrentAgentHint(agents, props.currentAgent);
    return hint ? (
      <Text dimColor wrap="truncate-end">
        {hint}
      </Text>
    ) : null;
  };
  return (
    <AsyncListForm<readonly AgentRow[], string>
      title="/agent"
      loadingLabel="Loading agents…"
      load={Effect.fn('load')(function* () {
        const catalog = yield* AgentCatalog;
        return (yield* agentOptionsData(roots)).map((agent) => ({
          ...agent,
          description: catalog.get(agent.value)?.description,
        }));
      })}
      isEmpty={(agents) => agents.length === 0}
      items={agentPickerItems}
      selectable={props.selectable}
      // The current agent may be stored as a canonical key (`source:name`) or
      // a bare name; rows are keyed by canonical value, so match Select in
      // that same identity space when rendering the ✓ on the active row.
      activeValueFor={(agents) =>
        currentVisibleAgent(agents, props.currentAgent)?.value
      }
      availableRows={props.availableRows}
      description={
        <Text dimColor wrap="truncate-end">
          {props.selectable
            ? 'Choose an agent for this chat.'
            : 'Viewing agents. Use texra chat --agent <name> to switch in a new chat.'}
        </Text>
      }
      detailFor={(agents) => (
        <>
          {hintRow(agents)}
          {agents.length > 0 ? (
            <Box marginTop={1}>
              <Text bold>{agentPickerPrimarySectionTitle(agents)}</Text>
            </Box>
          ) : null}
        </>
      )}
      // The hint row, then the section heading behind its blank row.
      detailRowsFor={(agents) => (hintRow(agents) ? 1 : 0) + 2}
      compactDetailFor={(agents) => (
        <>
          {hintRow(agents)}
          <Text bold>{agentPickerPrimarySectionTitle(agents)}</Text>
        </>
      )}
      emptyClosesOnEnter
      emptyMessage="No agents are available in this workspace."
      action={props.selectable ? 'select' : 'close'}
      onSelect={(agent) => props.onSelect?.(agent)}
      onCancel={props.onClose}
    />
  );
}
