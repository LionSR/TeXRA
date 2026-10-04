// `/agent` form. It lists the visible agents (document tasks marked) and the
// team presets. Before the first message, an agent or a team can be chosen to
// lead the chat.

import { Box, Text } from 'ink';
import { Effect } from 'effect';

import {
  computeAgentOptionsData,
  getCatalogAgent,
  type WorkspaceAgentsStores,
} from '@agent/index';
import { Select } from '@cli/tui/ui/Select';
import {
  computeSelectWindowSize,
  isCompactFormRows,
} from '@cli/tui/selectWindow';
import type { SelectItem } from '@cli/tui/ui/Select';
import { loadTeamOptions } from '@common/teams/TeamPlan';
import { createTeamCatalogPorts } from '@controllers/mainView/teamCatalogPorts';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { AgentOptionData, TeamOptionData } from '@shared/schemas';
import { agentName } from '@shared/schemas';

import {
  CompactPickerKeyHints,
  FormFrame,
  PickerKeyHints,
} from './_shared/FormFrame';
import { useAsyncPickerForm } from './_shared/ListForm';

interface AgentListFormProps {
  /** The process runtime the catalog read runs on, from the surface that
   *  registered this form. */
  readonly runtime: ProcessRuntime;
  /** The workspace agents slots of this chat's project, from the surface that registered
   *  this form: the list shows that project's visible agents. */
  readonly stores: WorkspaceAgentsStores;
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
  readonly agents: readonly AgentOptionData[];
  readonly teams: readonly TeamOptionData[];
}

function teamRowDescription(team: TeamOptionData): string {
  if (team.disabled === true) return team.disabledReason ?? 'Unavailable';
  const missing = team.unavailableMembers.length;
  return missing > 0
    ? `${missing} unavailable · ${team.description}`
    : team.description;
}

function agentPickerItems(
  groups: AgentGroups,
): ReadonlyArray<SelectItem<AgentPickerValue>> {
  return [
    ...groups.agents.map((agent) => {
      const description = getCatalogAgent(agent.value)?.description;
      return {
        value: { kind: 'agent' as const, agent: agent.value },
        label:
          agent.rounds === undefined
            ? agent.label
            : `${agent.label} · document task`,
        ...(description ? { description } : {}),
      };
    }),
    ...groups.teams.map((team) => ({
      value: { kind: 'team' as const, teamId: team.value },
      label: `Team · ${team.label}`,
      description: teamRowDescription(team),
      ...(team.disabled === true ? { disabled: true } : {}),
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
  const currentName = agentName(current);
  return agents.find((agent) => {
    const valueName = agentName(agent.value);
    return agent.value === current || valueName === currentName;
  });
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
  const picker = useAsyncPickerForm<AgentGroups, AgentPickerValue>({
    title: '/agent',
    loadingLabel: 'Loading agents...',
    load: () =>
      Effect.gen(function* () {
        const agents = yield* computeAgentOptionsData(props.stores);
        const teams = loadTeamOptions(
          yield* createTeamCatalogPorts(props.stores.repoState),
        );
        return { agents, teams };
      }),
    runtime: props.runtime,
    isEmpty: (groups) => groups.agents.length === 0,
    closeEmptyOnEnter: true,
    items: agentPickerItems,
    selectable: props.selectable,
    onSelect: (value) => props.onSelect?.(value),
    onClose: props.onClose,
  });

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
  // Border, title, description, section heading, and key hints are the fixed
  // chrome around the selectable list.
  const selectWindow = computeSelectWindowSize({
    availableRows: props.availableRows,
    itemCount: items.length,
    chromeRows: 8 + (currentAgentHint ? 1 : 0),
  });
  if (picker.transient) return picker.transient;

  const currentAgentHintRow = currentAgentHint ? (
    <Text dimColor wrap="truncate-end">
      {currentAgentHint}
    </Text>
  ) : null;

  if (isCompactFormRows(props.availableRows) && items.length > 0) {
    return (
      <FormFrame title="/agent" showCloseHint={false}>
        {currentAgentHintRow}
        <Text bold>{primarySectionTitle}</Text>
        <Select
          items={items}
          activeValue={activeValue}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={picker.select}
          onCancel={props.onClose}
        />
        <CompactPickerKeyHints selectable={props.selectable} />
      </FormFrame>
    );
  }

  return (
    <FormFrame title="/agent" showCloseHint={false}>
      <Text dimColor wrap="truncate-end">
        {props.selectable
          ? 'Choose an agent, or a team it leads, for this chat.'
          : 'Viewing agents. Use texra chat --agent <name> to switch in a new chat.'}
      </Text>
      {currentAgentHintRow}
      <Box marginTop={1} flexDirection="column">
        <Text bold>{primarySectionTitle}</Text>
        <Select
          items={items}
          activeValue={activeValue}
          maxVisibleItems={selectWindow.maxVisibleItems}
          showOverflow={selectWindow.showOverflow}
          onSelect={picker.select}
          onCancel={props.onClose}
        />
      </Box>
      <Box marginTop={1}>
        <PickerKeyHints
          selectable={props.selectable}
          hasItems={items.length > 0}
        />
      </Box>
    </FormFrame>
  );
}
