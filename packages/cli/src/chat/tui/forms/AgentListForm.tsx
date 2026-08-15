// `/agent` form. It lists visible tool-use agents and workflows. Before the
// first message, tool-use agents can be chosen as the root chat agent.

import { Box, Text } from 'ink';

import { computeAgentOptionsData } from '@agent/index';
import { Select } from '@cli/tui/ui/Select';
import {
  computeSelectWindowSize,
  isCompactFormRows,
} from '@cli/tui/selectWindow';
import type { AgentOptionData } from '@shared/schemas';
import { agentName } from '@shared/schemas';

import {
  CompactPickerKeyHints,
  FormFrame,
  PickerKeyHints,
} from './_shared/FormFrame';
import { useAsyncPickerForm } from './_shared/ListForm';

export interface AgentListFormProps {
  readonly currentAgent: string;
  readonly availableRows?: number;
  readonly selectable: boolean;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

interface AgentGroups {
  readonly toolUse: readonly AgentOptionData[];
  readonly workflow: readonly AgentOptionData[];
}

type AgentIdentity = Pick<AgentOptionData, 'label' | 'value'>;
type AgentDelegationFlag = Pick<AgentOptionData, 'isOrchestrator'>;

export function agentPickerPrimarySectionTitle(
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
    return (
      agent.value === current ||
      valueName === current ||
      valueName === currentName
    );
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
  const picker = useAsyncPickerForm<AgentGroups, string>({
    title: '/agent',
    loadingLabel: 'Loading agents...',
    load: async () => {
      const options = await computeAgentOptionsData();
      return { toolUse: options.toolUse, workflow: options.workflow };
    },
    isEmpty: (groups) => groups.toolUse.length === 0,
    closeEmptyOnEnter: true,
    items: (groups) =>
      groups.toolUse.map((agent) => ({
        value: agent.value,
        label: agent.label,
      })),
    selectable: props.selectable,
    onSelect: (value) => props.onSelect?.(value),
    onClose: props.onClose,
  });

  const agents: AgentGroups = picker.data ?? { toolUse: [], workflow: [] };
  const primarySectionTitle = agentPickerPrimarySectionTitle(agents.toolUse);
  const items = picker.items;
  // The current agent may be stored as a canonical key (`source:name`) or a
  // bare name; rows are keyed by canonical value, so match Select in that same
  // identity space when rendering the ✓ on the active row.
  const activeAgent = currentVisibleAgent(agents.toolUse, props.currentAgent);
  const activeValue = activeAgent?.value ?? props.currentAgent;
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
          ? 'Choose the root agent for this chat.'
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
            <Text dimColor>{`… ${
              workflowRows.length - visibleWorkflowRows.length
            } more workflows`}</Text>
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
