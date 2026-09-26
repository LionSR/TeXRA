// `/agent` form. It lists visible tool-use agents, the team presets, and
// workflows. Before the first message, an agent or a team can be chosen to
// lead the chat.

import { Box, Text } from 'ink';
import { Effect } from 'effect';

import {
  computeAgentOptionsData,
  getCategoryAgent,
  type AgentRosterStores,
} from '@agent/index';
import { moreRowsText } from '@cli/tui/overflowText';
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
import { AgentCategory, agentName } from '@shared/schemas';

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
  /** The roster slots of this chat's project, from the surface that registered
   *  this form: the list shows that project's visible agents. */
  readonly stores: AgentRosterStores;
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
  readonly toolUse: readonly AgentOptionData[];
  readonly workflow: readonly AgentOptionData[];
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
    ...groups.toolUse.map((agent) => {
      const description = getCategoryAgent(
        AgentCategory.ToolUse,
        agent.value,
      )?.description;
      return {
        value: { kind: 'agent' as const, agent: agent.value },
        label: agent.label,
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
  const hasToolUseSpecialists = agents.some(
    (agent) => agent.isOrchestrator !== true,
  );

  if (hasDelegatingAgents && hasToolUseSpecialists) {
    return 'Tool-use and delegating agents';
  }
  return hasDelegatingAgents ? 'Delegating agents' : 'Tool-use agents';
}

export function currentVisibleAgent(
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

export function hiddenCurrentAgentHint(
  agents: readonly AgentIdentity[],
  currentAgent: string,
): string | undefined {
  const current = currentAgent.trim();
  if (!current || currentVisibleAgent(agents, current)) return undefined;
  return `Current: ${agentName(current)} (hidden from picker)`;
}

export function agentSelectWindow({
  availableRows,
  extraRows = 0,
  itemCount,
  workflowCount,
}: {
  readonly availableRows: number | undefined;
  readonly extraRows?: number;
  readonly itemCount: number;
  readonly workflowCount: number;
}): {
  readonly maxVisibleItems: number | undefined;
  readonly showOverflow: boolean;
  readonly maxVisibleWorkflows: number;
  readonly showWorkflowOverflow: boolean;
} {
  if (availableRows == null) {
    return {
      maxVisibleItems: undefined,
      showOverflow: false,
      maxVisibleWorkflows: workflowCount,
      showWorkflowOverflow: false,
    };
  }

  // Border, title, description, tool-use heading, and key hints are the fixed
  // chrome for the primary selectable list.
  const chromeRows = 8 + Math.max(0, extraRows);
  const selectRows = Math.max(1, availableRows - chromeRows);
  if (itemCount > selectRows) {
    return {
      ...computeSelectWindowSize({ availableRows, itemCount, chromeRows }),
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    };
  }

  const remainingRows = availableRows - chromeRows - itemCount;
  if (workflowCount === 0 || remainingRows < 3) {
    return {
      maxVisibleItems: itemCount,
      showOverflow: false,
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    };
  }

  // Workflow heading and run hint are the fixed rows for the secondary list.
  const workflowRows = remainingRows - 2;
  if (workflowCount <= workflowRows) {
    return {
      maxVisibleItems: itemCount,
      showOverflow: false,
      maxVisibleWorkflows: workflowCount,
      showWorkflowOverflow: false,
    };
  }

  return {
    maxVisibleItems: itemCount,
    showOverflow: false,
    maxVisibleWorkflows: Math.max(0, workflowRows - 1),
    showWorkflowOverflow: true,
  };
}

export function AgentListForm(props: AgentListFormProps): React.JSX.Element {
  const picker = useAsyncPickerForm<AgentGroups, AgentPickerValue>({
    title: '/agent',
    loadingLabel: 'Loading agents...',
    load: () =>
      Effect.gen(function* () {
        const { toolUse, workflow } = yield* computeAgentOptionsData(
          props.stores,
        );
        const teams = yield* loadTeamOptions(
          yield* createTeamCatalogPorts(props.stores.workspaceState),
        );
        return { toolUse, workflow, teams };
      }),
    runtime: props.runtime,
    isEmpty: (groups) => groups.toolUse.length === 0,
    closeEmptyOnEnter: true,
    items: agentPickerItems,
    selectable: props.selectable,
    onSelect: (value) => props.onSelect?.(value),
    onClose: props.onClose,
  });

  const agents: AgentGroups = picker.data ?? {
    toolUse: [],
    workflow: [],
    teams: [],
  };
  const primarySectionTitle = `${agentPickerPrimarySectionTitle(agents.toolUse)}${
    agents.teams.length > 0 ? ', then teams' : ''
  }`;
  const items = picker.items;
  // The current agent may be stored as a canonical key (`source:name`) or a
  // bare name; rows are keyed by canonical value, so match Select in that same
  // identity space when rendering the ✓ on the active row. A chosen team
  // outranks its lead, which also appears as an agent row.
  const activeAgent = currentVisibleAgent(agents.toolUse, props.currentAgent);
  const activeValue = items.find(({ value }) =>
    props.currentTeamId !== undefined
      ? value.kind === 'team' && value.teamId === props.currentTeamId
      : value.kind === 'agent' && value.agent === activeAgent?.value,
  )?.value;
  const currentAgentHint = hiddenCurrentAgentHint(
    agents.toolUse,
    props.currentAgent,
  );
  const workflowRows = agents.workflow.map((agent) => ({
    value: agent.value,
    name: agent.label,
  }));
  const selectWindow = agentSelectWindow({
    availableRows: props.availableRows,
    extraRows: currentAgentHint ? 1 : 0,
    itemCount: items.length,
    workflowCount: workflowRows.length,
  });
  const visibleWorkflowRows = workflowRows.slice(
    0,
    selectWindow.maxVisibleWorkflows,
  );
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
      {visibleWorkflowRows.length > 0 || selectWindow.showWorkflowOverflow ? (
        <Box flexDirection="column">
          <Text bold>Workflows</Text>
          {visibleWorkflowRows.map((workflow) => (
            <Text key={workflow.value} wrap="truncate-end">
              {'  '}
              {workflow.name}
            </Text>
          ))}
          {selectWindow.showWorkflowOverflow ? (
            <Text dimColor>
              {moreRowsText(workflowRows.length - visibleWorkflowRows.length)}
            </Text>
          ) : null}
          <Text dimColor wrap="truncate-end">
            {'Run a workflow with texra run <name> --input=<file>.'}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <PickerKeyHints
          selectable={props.selectable}
          hasItems={items.length > 0}
        />
      </Box>
    </FormFrame>
  );
}
