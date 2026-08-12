import { Box, Text } from 'ink';
import { useState } from 'react';

import {
  createWorkspaceAgentRosterController,
  getAgentsByCategory,
  loadAgents,
  type AgentEntry,
} from '@agent/index';
import {
  readCliAgentRoster,
  type CliAgentRosterRecord,
} from '@cli/runtime/agentRoster';
import { setWorkspaceCliChatAgent } from '@cli/runtime/cliConfig';
import { COLOR_ERROR, COLOR_WARNING } from '@cli/tui/ui/colors';
import { CROSS, TICK, WARNING } from '@cli/tui/ui/glyphs';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import {
  computeSelectWindowSize,
  type SelectWindowSize,
} from '@cli/tui/selectWindow';
import { platform } from '@platform/platform';
import type { AgentRosterCategorySelection } from '@shared/schemas';
import {
  agentKeyOf,
  byCategory,
  type AgentCategory,
  type ByCategory,
} from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

import { FormFrame, renderAsyncListFormTransient } from './_shared/FormFrame';
import { useAsyncListForm } from './_shared/useAsyncListForm';

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
  readonly agents: ByCategory<readonly AgentEntry[]>;
}

export interface AgentRosterFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

function selectionLabel(record: CliAgentRosterRecord): string {
  const selection = record.selection;
  if (selection.kind === 'team') return `team: ${selection.teamId}`;
  return selection.kind;
}

export function buildChatDefaultAgentItems(
  agents: readonly AgentEntry[],
  effectiveKeys: readonly string[],
): SelectItem<string>[] {
  const effective = new Set(effectiveKeys);
  return [
    {
      value: '',
      label: 'Automatic',
      description: 'Choose from the effective workspace roster',
    },
    ...agents
      .filter((agent) => effective.has(agentKeyOf(agent)))
      .map((agent) => ({
        value: agentKeyOf(agent),
        label: agent.name,
        description: agent.description,
      })),
  ];
}

export function selectedAgentKeys(
  selection: AgentRosterCategorySelection,
  agents: readonly AgentEntry[],
): readonly string[] {
  if (selection === 'all') return agents.map(agentKeyOf);
  return selection;
}

function selectionSizeLabel(selection: AgentRosterCategorySelection): string {
  return selection === 'all' ? 'all' : String(selection.length);
}

export function agentRosterSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  return computeSelectWindowSize({ ...args, chromeRows: 5 });
}

export async function setChatDefaultAgent(
  workspacePath: string | undefined,
  agent: string | undefined,
): Promise<void> {
  if (!workspacePath) {
    throw new Error('Default chat-agent selection requires a workspace.');
  }
  await setWorkspaceCliChatAgent(workspacePath, agent);
}

async function loadRosterData(): Promise<AgentRosterData> {
  await loadAgents({ includeRemote: false });
  return {
    record: await readCliAgentRoster(),
    presets: createWorkspaceAgentRosterController().allPresets(),
    agents: byCategory((category) => getAgentsByCategory(category)),
  };
}

export function AgentRosterForm(
  props: AgentRosterFormProps,
): React.JSX.Element | null {
  const [mode, setMode] = useState<AgentRosterFormMode>('overview');
  const { data, error, reload, reportError } = useAsyncListForm<AgentRosterData>({
    load: loadRosterData,
    onClose: props.onClose,
    onError: props.onError,
  });

  const write = (action: () => Promise<void>, nextMode = mode): void => {
    void action()
      .then(() => {
        setMode(nextMode);
        reload();
      })
      .catch((reason: unknown) => reportError(reason));
  };

  if (!data) {
    return renderAsyncListFormTransient({
      loading: error === undefined,
      error,
      title: '/config · Agents',
      loadingLabel: 'Loading agents...',
    });
  }

  const frame = (
    items: readonly SelectItem<string>[],
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) => {
    const window = agentRosterSelectWindow({
      availableRows: props.availableRows,
      itemCount: items.length,
    });
    return (
      <FormFrame title="/config · Agents" showCloseHint={false}>
        {error ? <Text color={COLOR_ERROR}>{`${CROSS} ${error}`}</Text> : null}
        {data.record.missingTeamId ? (
          <Text color={COLOR_WARNING}>
            {WARNING} Team "{data.record.missingTeamId}" is unavailable; showing
            all agents.
          </Text>
        ) : null}
        <Select
          items={[...items]}
          maxVisibleItems={window.maxVisibleItems}
          showOverflow={window.showOverflow}
          onSelect={onSelect}
          onCancel={onCancel}
        />
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
  };

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
          description: `${selectionSizeLabel(data.record.agentKeys.workflow)} workflow, ${selectionSizeLabel(data.record.agentKeys.toolUse)} tool-use`,
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
        description: 'Show every agent in this workspace',
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
        const roster = createWorkspaceAgentRosterController();
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
        const roster = createWorkspaceAgentRosterController();
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
      buildChatDefaultAgentItems(
        data.agents.toolUse,
        selectedAgentKeys(data.record.agentKeys.toolUse, data.agents.toolUse),
      ),
      (value) => {
        const cwd = platform().workspace.getWorkspacePath();
        write(() => setChatDefaultAgent(cwd, value || undefined), 'overview');
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

  const agents = data.agents[mode];
  const selected = new Set(
    selectedAgentKeys(data.record.agentKeys[mode], agents),
  );
  return frame(
    agents.map((agent) => {
      const key = agentKeyOf(agent);
      return {
        value: key,
        label: `${selected.has(key) ? `${TICK} ` : ''}${agent.name}`,
        description: agent.description,
      };
    }),
    (value) => {
      const agent = agents.find((candidate) => agentKeyOf(candidate) === value);
      if (!agent) return;
      write(() =>
        createWorkspaceAgentRosterController().setAgentEnabled({
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
