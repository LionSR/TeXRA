// `/agent` form. It lists the visible agents and the
// team presets. Before the first message, an agent or a team can be chosen to
// lead the chat.

import { Box, Text } from 'ink';
import { Effect } from 'effect';

import { AgentCatalog } from '@texra-ai/harness/host';
import { agentName, joinFacts } from '@texra-ai/harness/schemas';
import type { SelectItem } from '@cli/tui/ui/Select';
import {
  isAgentOption,
  type TeamOptionData,
} from '@texra/shared/pickerOptions';
import { loadTeamOptions } from '@texra/agent/teams/teamLaunch';
import type { AgentOptionData } from '@texra/shared/pickerOptions';
import { agentOptionsData } from '@texra/controllers/session/agentOptions';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';

import { ListForm, useAsyncPickerForm } from './_shared/ListForm';
import { useChatProcess } from '../chatProcess';

interface AgentListFormProps {
  readonly currentAgent: string;
  /** The team leading this chat, when one was chosen. */
  readonly currentTeamId?: string;
  readonly availableRows?: number;
  readonly selectable: boolean;
  readonly onSelect?: (value: AgentPickerValue) => void;
  readonly onClose: () => void;
}

/** One `/agent` row: a single agent, or a team preset that brings its lead. */
export type AgentPickerValue =
  | { readonly kind: 'agent'; readonly agent: string }
  | { readonly kind: 'team'; readonly teamId: string };

interface AgentGroups {
  readonly agents: readonly (AgentOptionData & {
    readonly description?: string;
  })[];
  readonly teams: readonly TeamOptionData[];
}

function teamRowDescription(team: TeamOptionData): string {
  if (team.disabledReason != null) return team.disabledReason;
  const missing = team.unavailableMembers.length;
  return joinFacts([missing > 0 && `${missing} unavailable`, team.description]);
}

function agentPickerItems(
  groups: AgentGroups,
): ReadonlyArray<SelectItem<AgentPickerValue>> {
  return [
    ...groups.agents.map(({ description, ...agent }) => {
      return {
        value: { kind: 'agent' as const, agent: agent.value },
        label: agent.label,
        ...(description ? { description } : {}),
      };
    }),
    ...groups.teams.map((team) => ({
      value: { kind: 'team' as const, teamId: team.value },
      label: joinFacts(['Team', team.label]),
      description: teamRowDescription(team),
      ...(team.disabledReason != null ? { disabled: true } : {}),
    })),
  ];
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
  const picker = useAsyncPickerForm<AgentGroups, AgentPickerValue>({
    title: '/agent',
    loadingLabel: 'Loading agents...',
    load: Effect.fn('load')(function* () {
      const catalog = yield* AgentCatalog;
      const agents = (yield* agentOptionsData(roots)).map((agent) => ({
        ...agent,
        description: catalog.get(agent.value)?.description,
      }));
      const teams = loadTeamOptions(
        yield* createTeamCatalogPorts(roots.repoState),
      );
      return { agents, teams };
    }),
    isEmpty: (groups) => groups.agents.length === 0,
    closeEmptyOnEnter: true,
    items: agentPickerItems,
    selectable: props.selectable,
    onSelect: (value) => props.onSelect?.(value),
    onClose: props.onClose,
  });

  if (picker.transient) return picker.transient;

  const agents: AgentGroups = picker.data ?? { agents: [], teams: [] };
  const primarySectionTitle = `${agentPickerPrimarySectionTitle(agents.agents)}${
    agents.teams.length > 0 ? ', then teams' : ''
  }`;
  const items = picker.items;
  // The current agent may be stored as a canonical key (`source:name`) or a
  // bare name; rows are keyed by canonical value, so match Select in that same
  // identity space when rendering the ✓ on the active row. A chosen team
  // outranks its lead, which also appears as an agent row.
  const activeAgent = currentVisibleAgent(agents.agents, props.currentAgent);
  const activeValue = items.find(({ value }) =>
    props.currentTeamId !== undefined
      ? value.kind === 'team' && value.teamId === props.currentTeamId
      : value.kind === 'agent' && value.agent === activeAgent?.value,
  )?.value;
  const currentAgentHint = hiddenCurrentAgentHint(
    agents.agents,
    props.currentAgent,
  );
  const currentAgentHintRow = currentAgentHint ? (
    <Text dimColor wrap="truncate-end">
      {currentAgentHint}
    </Text>
  ) : null;

  return (
    <ListForm
      title="/agent"
      availableRows={props.availableRows}
      items={items}
      activeValue={activeValue}
      description={
        <Text dimColor wrap="truncate-end">
          {props.selectable
            ? 'Choose an agent, or a team it leads, for this chat.'
            : 'Viewing agents. Use texra chat --agent <name> to switch in a new chat.'}
        </Text>
      }
      detail={
        <>
          {currentAgentHintRow}
          {items.length > 0 ? (
            <Box marginTop={1}>
              <Text bold>{primarySectionTitle}</Text>
            </Box>
          ) : null}
        </>
      }
      // The hint row, then the section heading behind its blank row.
      detailRows={(currentAgentHint ? 1 : 0) + 2}
      compactDetail={
        <>
          {currentAgentHintRow}
          <Text bold>{primarySectionTitle}</Text>
        </>
      }
      emptyClosesOnEnter
      emptyMessage="No agents are available in this workspace."
      action={props.selectable ? 'select' : 'close'}
      onSelect={picker.select}
      onCancel={props.onClose}
    />
  );
}
