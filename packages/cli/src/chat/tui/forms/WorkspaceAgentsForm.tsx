import { Effect } from 'effect';
import { useState } from 'react';

import {
  AgentCatalog,
  type AgentEntry,
  type WorkspaceAgentsStores,
} from '@texra-ai/harness/host';
import { agentKeyOf, formatResultCount } from '@texra-ai/harness/schemas';
import {
  readCliWorkspaceAgents,
  type CliWorkspaceAgentsRecord,
} from '@cli/runtime/workspaceAgents';

import { setWorkspaceCliChatAgent } from '@cli/runtime/platform/cliConfig';
import { TICK } from '@cli/tui/ui/glyphs';
import { ToneLine } from '@cli/tui/ui/ToneLine';
import type { SelectItem } from '@cli/tui/ui/Select';

import { renderAsyncListFormTransient } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { runFormWrite, useAsyncListForm } from './_shared/useAsyncListForm';
import type { ProcessServices } from '@texra-ai/harness/host';
import { useChatProcess } from '../chatProcess';

type WorkspaceAgentsFormMode = 'overview' | 'chat-default' | 'custom';

interface WorkspaceAgentsData {
  readonly record: CliWorkspaceAgentsRecord;
  readonly agents: readonly AgentEntry[];
}

/** The workspace's agent selection over the process's catalog. */
const workspaceAgentsOf = (roots: WorkspaceAgentsStores) =>
  Effect.map(AgentCatalog, (catalog) => catalog.workspaceAgents(roots));

interface WorkspaceAgentsFormProps {
  /** The project the process opened, shown beside the workspace agents. */
  readonly workspaceRoot: string | undefined;
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
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
  selection: CliWorkspaceAgentsRecord['agentKeys'],
  agents: readonly AgentEntry[],
): readonly string[] {
  if (selection === 'all') return agents.map(agentKeyOf);
  return selection;
}

export function WorkspaceAgentsForm(
  props: WorkspaceAgentsFormProps,
): React.JSX.Element | null {
  const [mode, setMode] = useState<WorkspaceAgentsFormMode>('overview');
  // The workspace agents read, every workspace agents write and the default chat-agent write
  // below all target the slots this form was handed.
  const { roots, runtime } = useChatProcess();
  const { data, error, reload, reportError } =
    useAsyncListForm<WorkspaceAgentsData>({
      // The workspace agents read loads the local agent catalog the lists read.
      load: () =>
        Effect.map(
          Effect.all({
            record: readCliWorkspaceAgents(roots),
            catalog: AgentCatalog,
          }),
          ({ record, catalog }): WorkspaceAgentsData => ({
            record,
            agents: [...catalog.list()],
          }),
        ),
      onClose: props.onClose,
      onError: props.onError,
    });

  const write = (
    action: () => Effect.Effect<void, Error, ProcessServices>,
    nextMode = mode,
  ): void =>
    runFormWrite(runtime, action, {
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
      loadingLabel: 'Loading agents…',
    });
  }

  const notices = error
    ? [<ToneLine key="error" tone="danger" text={error} />]
    : [];
  const frame = <T extends string>(
    items: readonly SelectItem<T>[],
    onSelect: (value: T) => void,
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
    const showsAll = data.record.selection.kind === 'all';
    return frame<'all' | 'chat-default' | 'custom'>(
      [
        {
          value: 'all',
          label: `${showsAll ? `${TICK} ` : ''}All agents`,
          description: 'Show every agent in this workspace',
        },
        {
          value: 'custom',
          label: 'Custom selection',
          description:
            data.record.agentKeys === 'all'
              ? 'all agents'
              : formatResultCount(data.record.agentKeys.length, 'agent'),
        },
        {
          value: 'chat-default',
          label: 'Default chat agent',
          description: data.record.defaultChatAgent ?? '(automatic)',
        },
      ],
      (value) => {
        if (value !== 'all') return setMode(value);
        write(() =>
          Effect.flatMap(workspaceAgentsOf(roots), (agents) =>
            agents.select({ kind: 'all' }),
          ),
        );
      },
      props.onClose,
    );
  }

  if (mode === 'chat-default') {
    return frame(
      buildChatDefaultAgentItems(
        data.agents,
        selectedAgentKeys(data.record.agentKeys, data.agents),
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

  const agents = data.agents;
  const selected = new Set(selectedAgentKeys(data.record.agentKeys, agents));
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
        Effect.flatMap(workspaceAgentsOf(roots), (agents) =>
          agents.setAgentEnabled({
            source: agent.source,
            name: agent.name,
            enabled: !selected.has(value),
          }),
        ),
      );
    },
    () => setMode('overview'),
  );
}
