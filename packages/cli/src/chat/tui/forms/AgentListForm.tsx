// `/agent` form. It lists visible tool-use agents, the team presets, and
// workflows. Before the first message, an agent or a team can be chosen to
// lead the chat.

import { Box, Text } from 'ink';
import { Effect } from 'effect';

import {
  computeAgentOptionsData,
  getCategoryAgent,
  type WorkspaceAgentsStores,
} from '@agent/index';
import { Select } from '@cli/tui/ui/Select';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
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

/** How the Workflows section renders: its full list, one summary row, not at
 *  all when there are no workflows, or in the compact frame when even one
 *  select row and the summary row do not fit the full frame. */
type WorkflowLayout = 'list' | 'summary' | 'none' | 'compact';

/**
 * Window the picker within its sections; never drop one. The selectable list
 * scrolls inside the rows left over once the Workflows section (heading, one
 * row per workflow, the `texra run <name>` hint) has its rows. When that full
 * section would squeeze the selectable list below three rows, it folds into
 * one summary row that still names the section and the run hint; below that,
 * the picker takes its compact frame.
 */
function agentSelectWindow({
  availableRows,
  extraRows,
  itemCount,
  workflowCount,
}: {
  readonly availableRows: number | undefined;
  readonly extraRows: number;
  readonly itemCount: number;
  readonly workflowCount: number;
}): SelectWindowSize & { readonly workflowLayout: WorkflowLayout } {
  // Border, title, description, section heading, and key hints are the fixed
  // chrome for the primary selectable list.
  const chromeRows = 8 + extraRows;
  const window = (workflowRows: number): SelectWindowSize =>
    computeSelectWindowSize({
      availableRows,
      itemCount,
      chromeRows: chromeRows + workflowRows,
    });
  if (workflowCount === 0) return { ...window(0), workflowLayout: 'none' };
  // Decide on the raw budget: `computeSelectWindowSize` floors its list at
  // one row, so its result cannot say whether the reserved rows fit.
  const listRows = workflowCount + 2;
  const spareRows =
    availableRows == null ? Infinity : availableRows - chromeRows;
  if (spareRows - listRows >= Math.min(3, itemCount)) {
    return { ...window(listRows), workflowLayout: 'list' };
  }
  return {
    ...window(1),
    workflowLayout: spareRows >= 2 ? 'summary' : 'compact',
  };
}

// Border, title, section heading, one select row, the workflow summary row,
// and the key hints: the compact frame's rows once workflows join it.
const COMPACT_ROWS_WITH_WORKFLOWS = 7;

const WORKFLOW_RUN_HINT = 'texra run <name> --input=<file>';

/** The Workflows section folded to one row: heading, run hint, then names. */
function WorkflowSummaryRow(props: {
  readonly names: readonly string[];
}): React.JSX.Element {
  return (
    <Text wrap="truncate-end">
      <Text bold>Workflows</Text>
      <Text dimColor>{` · ${WORKFLOW_RUN_HINT}: `}</Text>
      {props.names.join(', ')}
    </Text>
  );
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
        const teams = loadTeamOptions(
          yield* createTeamCatalogPorts(props.stores.repoState),
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
  const workflowNames = agents.workflow.map((agent) => agent.label);
  const extraRows = currentAgentHint ? 1 : 0;
  const selectWindow = agentSelectWindow({
    availableRows: props.availableRows,
    extraRows,
    itemCount: items.length,
    workflowCount: workflowNames.length,
  });
  if (picker.transient) return picker.transient;

  const currentAgentHintRow = currentAgentHint ? (
    <Text dimColor wrap="truncate-end">
      {currentAgentHint}
    </Text>
  ) : null;

  if (
    (isCompactFormRows(props.availableRows) ||
      selectWindow.workflowLayout === 'compact') &&
    items.length > 0
  ) {
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
        {workflowNames.length > 0 &&
        (props.availableRows ?? 0) >=
          COMPACT_ROWS_WITH_WORKFLOWS + extraRows ? (
          <WorkflowSummaryRow names={workflowNames} />
        ) : null}
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
      {selectWindow.workflowLayout === 'list' ? (
        <Box flexDirection="column">
          <Text bold>Workflows</Text>
          {agents.workflow.map((workflow) => (
            <Text key={workflow.value} wrap="truncate-end">
              {'  '}
              {workflow.label}
            </Text>
          ))}
          <Text dimColor wrap="truncate-end">
            {`Run a workflow with ${WORKFLOW_RUN_HINT}.`}
          </Text>
        </Box>
      ) : null}
      {selectWindow.workflowLayout === 'summary' ? (
        <WorkflowSummaryRow names={workflowNames} />
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
