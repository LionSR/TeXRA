// `/agent` form. It lists the visible tool-use agents and, before the first
// message, can choose the root agent for the chat.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import { computeAgentOptionsData } from '@agent/index';
import type { AgentOptionData } from '@shared/schemas';

import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface AgentListFormProps {
  readonly currentAgent: string;
  readonly selectable?: boolean;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
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

export function AgentListForm(props: AgentListFormProps): React.JSX.Element {
  const [agents, setAgents] = useState<readonly AgentOptionData[]>([]);
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
        setAgents(options.toolUse);
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
  const items = agents.map((agent) => ({
    value: agent.label,
    label: agent.label,
    description: agentDescription(agent),
  }));

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
          ? 'Choose the root agent for the first message.'
          : 'Available agents. Start a new chat with texra --agent=<name> to choose the root agent.'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={items}
          activeValue={props.currentAgent}
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
      <Box marginTop={1}>
        {selectable ? (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: '1-9', action: 'select' },
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
