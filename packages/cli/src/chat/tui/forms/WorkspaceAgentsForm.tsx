import { Effect } from 'effect';
import { Text } from 'ink';
import { useState } from 'react';

import {
  createWorkspaceAgentsController,
  getAgentsByCategory,
  type AgentEntry,
} from '@agent/index';
import {
  readCliWorkspaceAgents,
  type CliWorkspaceAgentsRecord,
} from '@cli/runtime/workspaceAgents';

import { setWorkspaceCliChatAgent } from '@cli/runtime/cliConfig';
import { COLOR_ERROR, COLOR_WARNING } from '@cli/tui/ui/colors';
import { CROSS, TICK, WARNING } from '@cli/tui/ui/glyphs';
import type { SelectItem } from '@cli/tui/ui/Select';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  AGENT_MODE_PRESETS,
  agentKeyOf,
  byCategory,
  STARTER_AGENT_MODE_PRESET,
  type AgentCategory,
  type AgentModePreset,
  type WorkspaceAgentsCategorySelection,
  type ByCategory,
} from '@shared/schemas';

import { renderAsyncListFormTransient } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { runFormWrite, useAsyncListForm } from './_shared/useAsyncListForm';

type WorkspaceAgentsFormMode =
  | 'overview'
  | 'workspace'
  | 'default'
  | 'chat-default'
  | 'custom-category'
  | AgentCategory;

interface WorkspaceAgentsData {
  readonly record: CliWorkspaceAgentsRecord;
  readonly presets: readonly AgentModePreset[];
  readonly agents: ByCategory<readonly AgentEntry[]>;
}

interface WorkspaceAgentsFormProps {
  /** The process runtime the workspace agents read and the default-agent write run on,
   *  from the config form that owns this one. */
  readonly runtime: ProcessRuntime;
  /** The settings slots the workspace agents read and every workspace agents write target, from
   *  the config form that owns this one. */
  readonly stores: SettingsStores;
  /** The project the process opened, shown beside the workspace agents. */
  readonly workspaceRoot: string | undefined;
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

function selectionLabel(record: CliWorkspaceAgentsRecord): string {
  const selection = record.selection;
  if (selection.kind === 'team') return `team: ${selection.teamId}`;
  return selection.kind;
}

function buildChatDefaultAgentItems(
  agents: readonly AgentEntry[],
  effectiveKeys: readonly string[],
): SelectItem<string>[] {
  const effective = new Set(effectiveKeys);
  return [
    {
      value: '',
      label: 'Automatic',
      description: 'Choose from the workspace agents',
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

function selectedAgentKeys(
  selection: WorkspaceAgentsCategorySelection,
  agents: readonly AgentEntry[],
): readonly string[] {
  if (selection === 'all') return agents.map(agentKeyOf);
  return selection;
}

function selectionSizeLabel(
  selection: WorkspaceAgentsCategorySelection,
): string {
  return selection === 'all' ? 'all' : String(selection.length);
}

export function WorkspaceAgentsForm(
  props: WorkspaceAgentsFormProps,
): React.JSX.Element | null {
  const [mode, setMode] = useState<WorkspaceAgentsFormMode>('overview');
  // The workspace agents read, every workspace agents write and the default chat-agent write
  // below all target the slots this form was handed.
  const roots = props.stores;
  const { data, error, reload, reportError } =
    useAsyncListForm<WorkspaceAgentsData>({
      // The workspace agents read loads the local agent catalog the lists read.
      load: () =>
        Effect.map(
          Effect.all({
            record: readCliWorkspaceAgents(roots),
            presets: createWorkspaceAgentsController(roots).allPresets(),
          }),
          ({ record, presets }): WorkspaceAgentsData => ({
            record,
            presets,
            agents: byCategory((category) => getAgentsByCategory(category)),
          }),
        ),
      runtime: props.runtime,
      onClose: props.onClose,
      onError: props.onError,
    });

  const write = (
    action: () => Effect.Effect<void, Error, ProcessServices>,
    nextMode = mode,
  ): void =>
    runFormWrite(props.runtime, action, {
      onSuccess: () => {
        setMode(nextMode);
        reload();
      },
      onError: reportError,
    });

  if (!data) {
    return renderAsyncListFormTransient({
      loading: error === undefined,
      error,
      title: '/config · Agents',
      loadingLabel: 'Loading agents...',
    });
  }

  const notices = [
    error ? (
      <Text key="error" color={COLOR_ERROR}>{`${CROSS} ${error}`}</Text>
    ) : null,
    data.record.missingTeamId ? (
      <Text key="missing-team" color={COLOR_WARNING}>
        {WARNING} Team "{data.record.missingTeamId}" is unavailable; showing all
        agents.
      </Text>
    ) : null,
  ].filter((notice) => notice !== null);
  const frame = (
    items: readonly SelectItem<string>[],
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) => (
    <ListForm
      title="/config · Agents"
      availableRows={props.availableRows}
      items={items}
      detail={notices}
      detailRows={notices.length}
      action="select"
      escapeAction="back"
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );

  if (mode === 'overview') {
    return frame(
      [
        {
          value: 'workspace',
          label: 'Workspace agents',
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
      (value) => setMode(value as WorkspaceAgentsFormMode),
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
        const workspaceAgents = createWorkspaceAgentsController(roots);
        if (value === 'inherit')
          write(() => workspaceAgents.setInherited(), 'overview');
        else if (value === 'all')
          write(() => workspaceAgents.setAll(), 'overview');
        else
          write(
            () => workspaceAgents.setTeam(value.slice('team:'.length)),
            'overview',
          );
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
        const workspaceAgents = createWorkspaceAgentsController(roots);
        write(
          () =>
            value
              ? workspaceAgents.setDefaultTeam(value)
              : workspaceAgents.clearDefaultTeam(),
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
        const cwd = props.workspaceRoot;
        write(
          () =>
            cwd
              ? setWorkspaceCliChatAgent(roots, value || undefined)
              : Effect.fail(
                  new Error(
                    'Default chat-agent selection requires a workspace.',
                  ),
                ),
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
        createWorkspaceAgentsController(roots).setAgentEnabled({
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
