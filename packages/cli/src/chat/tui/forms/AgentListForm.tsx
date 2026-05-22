// `/agent` form. It lists visible tool-use agents and workflows. Before the
// first message, tool-use agents can be chosen as the root chat agent.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import { computeAgentOptionsData } from '@agent/index';
import type { AgentOptionData } from '@shared/schemas';

import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

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

interface AgentFrameProps {
  readonly color: string;
  readonly title: string;
  readonly children: React.ReactNode;
}

function AgentFrame(props: AgentFrameProps): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={props.color}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={props.color}>
        {props.title}
      </Text>
      {props.children}
      <Box marginTop={1}>
        <KeyHints
          hints={[{ key: 'Esc', action: 'close' }]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}

function agentDescription(agent: AgentOptionData): string {
  const source = agent.isRemote
    ? 'remote'
    : agent.isCustom
      ? 'custom'
      : 'built-in';
  const kind = agent.isOrchestrator ? 'orchestrator' : 'tool-use';
  return agent.description ? `${kind}; ${source}; ${agent.description}` : kind;
}

export function agentSelectWindow({
  availableRows,
  itemCount,
  workflowCount,
}: {
  readonly availableRows: number | undefined;
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
  const selectRows = Math.max(1, availableRows - 8);
  if (itemCount > selectRows) {
    if (selectRows < 3) {
      return {
        maxVisibleItems: selectRows,
        showOverflow: false,
        maxVisibleWorkflows: 0,
        showWorkflowOverflow: false,
      };
    }

    return {
      maxVisibleItems: Math.max(1, selectRows - 2),
      showOverflow: true,
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    };
  }

  const remainingRows = availableRows - 8 - itemCount;
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
  const [agents, setAgents] = useState<AgentGroups>({
    toolUse: [],
    workflow: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if ((loading || error) && key.escape) {
      props.onClose();
    }
  });

  useEffect(() => {
    let cancelled = false;
    void computeAgentOptionsData()
      .then((options) => {
        if (cancelled) return;
        setAgents({
          toolUse: options.toolUse,
          workflow: options.workflow,
        });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <AgentFrame color="cyan" title="/agent">
        <Spinner label="Loading agent registry..." />
      </AgentFrame>
    );
  }

  if (error) {
    return (
      <AgentFrame color="red" title="/agent - error">
        <Text>{error}</Text>
      </AgentFrame>
    );
  }

  const selectable = props.selectable === true;
  const items = agents.toolUse.map((agent) => ({
    value: agent.label,
    label: agent.label,
    description: agentDescription(agent),
  }));
  // The current agent may be stored as a canonical key (`source:name`) or a
  // bare name; rows are keyed by bare name, so resolve to the matching label
  // so Select can render the ✓ on the active row.
  const activeAgent = agents.toolUse.find(
    (agent) =>
      agent.value === props.currentAgent || agent.label === props.currentAgent,
  );
  const activeValue = activeAgent?.label ?? props.currentAgent;
  const workflowRows = agents.workflow.map((agent) => ({
    name: agent.label,
    description: agentDescription(agent),
  }));
  const selectWindow = agentSelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
    workflowCount: workflowRows.length,
  });
  const visibleWorkflowRows = workflowRows.slice(
    0,
    selectWindow.maxVisibleWorkflows,
  );

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        /agent
      </Text>
      <Text dimColor>
        {selectable
          ? 'Choose the root tool-use agent for the first message.'
          : 'Available agents. Start a new chat with texra --agent=<name> to choose the root tool-use agent.'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Tool-use agents</Text>
        <Select
          items={items}
          activeValue={activeValue}
          maxVisibleItems={selectWindow.maxVisibleItems}
          showOverflow={selectWindow.showOverflow}
          onSelect={(value) => {
            if (selectable) {
              props.onSelect?.(value);
              return;
            }
            props.onClose();
          }}
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
