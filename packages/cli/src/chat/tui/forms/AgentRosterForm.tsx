import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { platform } from '@platform/platform';
import { getAgentsByCategory, loadAgents, type AgentEntry } from '@agent/index';
import {
  cliAgentRosterController,
  readCliAgentRoster,
  type CliAgentRosterRecord,
} from '@cli/runtime/agentRoster';
import { setWorkspaceCliChatAgent } from '@cli/runtime/cliConfig';
import { agentKeyOf, type AgentCategory } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  STARTER_AGENT_MODE_PRESET,
  parseAgentModePresets,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import { KeyHints } from '../ui/KeyHints';
import { Select, type SelectItem } from '../ui/Select';
import { FormFrame } from './_shared/FormFrame';

type AgentRosterFormMode =
  | 'overview'
  | 'workspace'
  | 'default'
  | 'chat-default'
  | 'custom-category'
  | AgentCategory;

interface AgentRosterData {
  readonly record: CliAgentRosterRecord;
  readonly presets: readonly AgentModePreset[];
  readonly workflow: readonly AgentEntry[];
  readonly toolUse: readonly AgentEntry[];
}

export interface AgentRosterFormProps {
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

function selectionLabel(record: CliAgentRosterRecord): string {
  const selection = record.selection;
  if (selection.kind === 'team') return `team: ${selection.teamId}`;
  return selection.kind;
}

async function loadRosterData(): Promise<AgentRosterData> {
  await loadAgents({ includeRemote: false });
  const { workspaceState } = platform();
  return {
    record: await readCliAgentRoster(),
    presets: [
      STARTER_AGENT_MODE_PRESET,
      ...AGENT_MODE_PRESETS,
      ...parseAgentModePresets(
        workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
      ),
    ],
    workflow: getAgentsByCategory('workflow'),
    toolUse: getAgentsByCategory('toolUse'),
  };
}

export function AgentRosterForm(
  props: AgentRosterFormProps,
): React.JSX.Element {
  const [mode, setMode] = useState<AgentRosterFormMode>('overview');
  const [data, setData] = useState<AgentRosterData>();
  const [error, setError] = useState<string>();

  const refresh = (): void => {
    void loadRosterData()
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        props.onError?.(reason);
      });
  };

  useEffect(refresh, []);

  const write = (action: () => Promise<void>, nextMode = mode): void => {
    void action()
      .then(() => {
        setMode(nextMode);
        refresh();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        props.onError?.(reason);
      });
  };

  if (!data) {
    return (
      <FormFrame title="/config · Agents">
        <Text>{error ?? 'Loading agent roster...'}</Text>
      </FormFrame>
    );
  }

  const frame = (
    items: readonly SelectItem<string>[],
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) => (
    <FormFrame title="/config · Agents" showCloseHint={false}>
      {error ? <Text color="red">{error}</Text> : null}
      <Select items={[...items]} onSelect={onSelect} onCancel={onCancel} />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'select' },
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );

  if (mode === 'overview') {
    return frame(
      [
        {
          value: 'workspace',
          label: 'Workspace roster',
          description: selectionLabel(data.record),
        },
        {
          value: 'default',
          label: 'Default team',
          description: data.record.defaultTeamId ?? '(none)',
        },
        {
          value: 'chat-default',
          label: 'Default chat agent',
          description: data.record.defaultChatAgent ?? '(automatic)',
        },
        {
          value: 'custom-category',
          label: 'Custom selection',
          description: `${data.record.workflowAgentKeys.length} workflow, ${data.record.toolUseAgentKeys.length} tool-use`,
        },
      ],
      (value) => setMode(value as AgentRosterFormMode),
      props.onClose,
    );
  }

  if (mode === 'workspace') {
    const items: SelectItem<string>[] = [
      {
        value: 'inherit',
        label: 'Inherit default',
        description: 'Use the default team, or all agents when it is unset',
      },
      {
        value: 'all',
        label: 'All agents',
        description: 'Show the complete catalog in this workspace',
      },
      ...data.presets.map((preset) => ({
        value: `team:${preset.id}`,
        label: preset.name,
        description: preset.description,
      })),
    ];
    return frame(
      items,
      (value) => {
        const roster = cliAgentRosterController();
        if (value === 'inherit') write(() => roster.setInherited(), 'overview');
        else if (value === 'all') write(() => roster.setAll(), 'overview');
        else
          write(() => roster.setTeam(value.slice('team:'.length)), 'overview');
      },
      () => setMode('overview'),
    );
  }

  if (mode === 'default') {
    return frame(
      [
        {
          value: '',
          label: 'No default team',
          description: 'Inherited workspaces show all agents',
        },
        ...[STARTER_AGENT_MODE_PRESET, ...AGENT_MODE_PRESETS].map((preset) => ({
          value: preset.id,
          label: preset.name,
          description: preset.description,
        })),
      ],
      (value) => {
        const roster = cliAgentRosterController();
        write(
          () =>
            value ? roster.setDefaultTeam(value) : roster.clearDefaultTeam(),
          'overview',
        );
      },
      () => setMode('overview'),
    );
  }

  if (mode === 'chat-default') {
    return frame(
      [
        {
          value: '',
          label: 'Automatic',
          description: 'Choose from the effective workspace roster',
        },
        ...data.toolUse.map((agent) => ({
          value: agentKeyOf(agent),
          label: agent.name,
          description: agent.description,
        })),
      ],
      (value) => {
        const cwd = platform().workspace.getWorkspacePath();
        if (!cwd) return;
        write(
          () => setWorkspaceCliChatAgent(cwd, value || undefined),
          'overview',
        );
      },
      () => setMode('overview'),
    );
  }

  if (mode === 'custom-category') {
    return frame(
      [
        {
          value: 'workflow',
          label: 'Workflow agents',
          description: 'Choose document-processing agents',
        },
        {
          value: 'toolUse',
          label: 'Tool-use agents',
          description: 'Choose chat and delegation agents',
        },
      ],
      (value) => setMode(value as AgentCategory),
      () => setMode('overview'),
    );
  }

  const agents = data[mode];
  const selected = new Set(
    mode === 'workflow'
      ? data.record.workflowAgentKeys
      : data.record.toolUseAgentKeys,
  );
  return frame(
    agents.map((agent) => ({
      value: agentKeyOf(agent),
      label: `${selected.has(agentKeyOf(agent)) ? '✓ ' : ''}${agent.name}`,
      description: agent.description,
    })),
    (value) => {
      const agent = agents.find((candidate) => agentKeyOf(candidate) === value);
      if (!agent) return;
      write(() =>
        cliAgentRosterController().setAgentEnabled({
          category: mode,
          source: agent.source,
          name: agent.name,
          enabled: !selected.has(value),
        }),
      );
    },
    () => setMode('custom-category'),
  );
}
