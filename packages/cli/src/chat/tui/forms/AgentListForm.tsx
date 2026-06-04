// `/agent` form. It lists visible tool-use agents and workflows. Before the
// first message, tool-use agents can be chosen as the root chat agent.

import { Box, Text, useWindowSize } from 'ink';
import { Spinner } from '@inkjs/ui';

import { computeAgentOptionsData } from '@agent/index';
import type { AgentOptionData } from '@shared/schemas';
import { agentName } from '@shared/schemas/agent';

import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';

export interface AgentListFormProps {
  readonly currentAgent: string;
  readonly availableRows?: number;
  readonly selectable?: boolean;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

interface AgentGroups {
  readonly toolUse: readonly AgentOptionData[];
  readonly workflow: readonly AgentOptionData[];
}

type AgentIdentity = Pick<AgentOptionData, 'label' | 'value'>;
type AgentOrchestrationFlag = Pick<AgentOptionData, 'isOrchestrator'>;

const AGENT_FORM_MAX_WIDTH = 80;

export function agentFormWidth(columns: number | undefined): number {
  const normalized =
    columns != null && Number.isFinite(columns) && columns > 0
      ? Math.floor(columns)
      : AGENT_FORM_MAX_WIDTH;
  return Math.max(1, Math.min(normalized, AGENT_FORM_MAX_WIDTH));
}

function agentDescription(agent: AgentOptionData): string {
  const source = agent.isRemote
    ? 'remote'
    : agent.isCustom
      ? 'custom'
      : 'built-in';
  const kind = isOrchestratorAgent(agent) ? 'orchestrator' : 'tool-use';
  return agent.description ? `${kind}; ${source}; ${agent.description}` : kind;
}

function isOrchestratorAgent(agent: AgentOrchestrationFlag): boolean {
  return agent.isOrchestrator === true;
}

export function agentPickerPrimarySectionTitle(
  agents: readonly AgentOrchestrationFlag[],
): string {
  const hasOrchestrators = agents.some(isOrchestratorAgent);
  const hasToolUseSpecialists = agents.some(
    (agent) => !isOrchestratorAgent(agent),
  );

  if (hasOrchestrators && hasToolUseSpecialists) {
    return 'Tool-use and orchestrator agents';
  }
  return hasOrchestrators ? 'Orchestrator agents' : 'Tool-use agents';
}

export function currentVisibleAgent(
  agents: readonly AgentIdentity[],
  currentAgent: string,
): AgentIdentity | undefined {
  const current = currentAgent.trim();
  const currentName = agentName(current);
  return agents.find(
    (agent) =>
      agent.value === current ||
      agent.label === current ||
      agent.label === currentName,
  );
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

  const chromeRows = 8 + Math.max(0, extraRows);
  // Border, title, description, tool-use heading, and key hints are the fixed
  // chrome for the primary selectable list.
  const selectRows = Math.max(1, availableRows - chromeRows);
  if (itemCount > selectRows) {
    return {
      ...computeSelectWindowSize({ availableRows, itemCount, chromeRows }),
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    };
  }

  const remainingRows = availableRows - chromeRows - itemCount;
  if (workflowCount === 0 || remainingRows < 4) {
    return {
      maxVisibleItems: itemCount,
      showOverflow: false,
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    };
  }

  const workflowRows = remainingRows - 3;
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
  const { columns } = useWindowSize();
  const { data, loading, error } = useAsyncListForm<AgentGroups>({
    load: async () => {
      const options = await computeAgentOptionsData();
      return { toolUse: options.toolUse, workflow: options.workflow };
    },
    onClose: props.onClose,
  });

  if (loading) {
    return (
      <FormFrame color="cyan" title="/agent">
        <Spinner label="Loading agent registry..." />
      </FormFrame>
    );
  }

  if (error) {
    return (
      <FormFrame color="red" title="/agent - error">
        <Text>{error}</Text>
      </FormFrame>
    );
  }

  const agents: AgentGroups = data ?? { toolUse: [], workflow: [] };
  const selectable = props.selectable === true;
  const primarySectionTitle = agentPickerPrimarySectionTitle(agents.toolUse);
  const items = agents.toolUse.map((agent) => ({
    value: agent.label,
    label: agent.label,
    description: agentDescription(agent),
  }));
  // The current agent may be stored as a canonical key (`source:name`) or a
  // bare name; rows are keyed by bare name, so resolve to the matching label
  // so Select can render the ✓ on the active row.
  const activeAgent = currentVisibleAgent(agents.toolUse, props.currentAgent);
  const activeValue = activeAgent?.label ?? props.currentAgent;
  const currentAgentHint = hiddenCurrentAgentHint(
    agents.toolUse,
    props.currentAgent,
  );
  const workflowRows = agents.workflow.map((agent) => ({
    name: agent.label,
    description: agentDescription(agent),
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
  const handleSelectItem = (value: string): void => {
    if (selectable) {
      props.onSelect?.(value);
      return;
    }
    props.onClose();
  };

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame color="cyan" title="/agent" showCloseHint={false}>
        {currentAgentHint ? (
          <Text dimColor wrap="truncate-end">
            {currentAgentHint}
          </Text>
        ) : null}
        <Text bold>{primarySectionTitle}</Text>
        <Select
          items={items.map(({ value, label }) => ({ value, label }))}
          activeValue={activeValue}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={handleSelectItem}
          onCancel={props.onClose}
        />
        <CompactFormKeyHints
          primary={
            selectable
              ? { key: '1-9/a-z/Enter', action: 'select' }
              : { key: 'Enter', action: 'close' }
          }
        />
      </FormFrame>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
      width={agentFormWidth(columns)}
    >
      <Text bold color="cyan">
        /agent
      </Text>
      <Text dimColor wrap="truncate-end">
        {selectable
          ? 'Choose the root agent for the first message.'
          : 'Available agents. Start a new chat with texra chat --agent=<name> to choose the root agent.'}
      </Text>
      {currentAgentHint ? (
        <Text dimColor wrap="truncate-end">
          {currentAgentHint}
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text bold>{primarySectionTitle}</Text>
        <Select
          items={items}
          activeValue={activeValue}
          maxVisibleItems={selectWindow.maxVisibleItems}
          showOverflow={selectWindow.showOverflow}
          onSelect={handleSelectItem}
          onCancel={props.onClose}
        />
      </Box>
      {visibleWorkflowRows.length > 0 || selectWindow.showWorkflowOverflow ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Workflows</Text>
          {visibleWorkflowRows.map((workflow) => (
            <Text key={workflow.name} wrap="truncate-end">
              {'  '}
              {workflow.name}
              <Text dimColor>{` — ${workflow.description}`}</Text>
            </Text>
          ))}
          {selectWindow.showWorkflowOverflow ? (
            <Text dimColor>{`... ${
              workflowRows.length - visibleWorkflowRows.length
            } more workflows`}</Text>
          ) : null}
          <Text dimColor wrap="truncate-end">
            {'Run a workflow with texra run <name> --input=<file>.'}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {selectable ? (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: '1-9/a-z', action: 'select' },
            ]}
          />
        ) : (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: 'Enter', action: 'close' },
              { key: 'Esc', action: 'close' },
            ]}
            confirmCancel={false}
          />
        )}
      </Box>
    </Box>
  );
}
