// Registers the slash commands the input palette surfaces.

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliApprovalPolicy } from '@cli/runtime/approvalPolicy';
import type { ExecutionId } from '@shared/schemas';

import { ApiModeForm } from '../forms/ApiModeForm';
import { AgentListForm } from '../forms/AgentListForm';
import { ApprovalPolicyForm } from '../forms/ApprovalPolicyForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { ModelListForm } from '../forms/ModelListForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { ToolsListForm } from '../forms/ToolsListForm';
import { cliState } from '../state/cliState';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';

type AgentSelectHandler = (value: string) => void | Promise<void>;
type ApprovalPolicySelectHandler = (
  value: CliApprovalPolicy,
) => void | Promise<void>;
type ModelSelectHandler = (value: string) => void | Promise<void>;
type ApiModeSelectHandler = (value: CliApiMode) => void | Promise<void>;
type MemorySelectHandler = (storagePath: string) => void | Promise<void>;
type ResumeSelectHandler = (id: ExecutionId) => void | Promise<void>;
type ErrorHandler = (error: unknown) => void | Promise<void>;

function patchSessionMeta<K extends 'agent' | 'model' | 'apiMode'>(
  key: K,
  value: K extends 'apiMode' ? CliApiMode : string,
): void {
  cliState.sessionMeta.set({ ...cliState.sessionMeta.get(), [key]: value });
}

/** Run a select handler (sync or async) and close the form with the selected
 *  value once it settles, routing any rejection to `onError` first. */
function settleThenDone<T>(
  result: void | Promise<void>,
  value: T,
  onDone: (value: T) => void,
  onError?: ErrorHandler,
): void {
  void Promise.resolve(result)
    .catch((error: unknown) => onError?.(error))
    .finally(() => onDone(value));
}

export function registerBuiltinSlashCommands(options?: {
  onAgentSelect?: AgentSelectHandler;
  canSelectAgent?: () => boolean;
  getApprovalPolicy?: () => CliApprovalPolicy;
  onApprovalPolicySelect?: ApprovalPolicySelectHandler;
  onModelSelect?: ModelSelectHandler;
  canSelectModel?: () => boolean;
  onApiModeSelect?: ApiModeSelectHandler;
  onMemorySelect?: MemorySelectHandler;
  onMemoryError?: ErrorHandler;
  onResumeSelect?: ResumeSelectHandler;
  onResumeError?: ErrorHandler;
}): void {
  const onAgentSelect: AgentSelectHandler =
    options?.onAgentSelect ?? ((value) => patchSessionMeta('agent', value));
  const onApprovalPolicySelect = options?.onApprovalPolicySelect;
  const onModelSelect: ModelSelectHandler =
    options?.onModelSelect ?? ((value) => patchSessionMeta('model', value));
  const onApiModeSelect: ApiModeSelectHandler =
    options?.onApiModeSelect ?? ((value) => patchSessionMeta('apiMode', value));
  const onMemorySelect = options?.onMemorySelect;
  const onMemoryError = options?.onMemoryError;
  const onResumeSelect = options?.onResumeSelect;
  const onResumeError = options?.onResumeError;

  function AgentListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().agent;
    const selectable = options?.canSelectAgent?.() ?? true;
    return (
      <AgentListForm
        currentAgent={current}
        availableRows={props.availableRows}
        selectable={selectable}
        onSelect={(value) =>
          settleThenDone(onAgentSelect(value), value, props.onDone)
        }
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ApiModeFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().apiMode;
    return (
      <ApiModeForm
        currentMode={current}
        onSelect={(value) =>
          settleThenDone(onApiModeSelect(value), value, props.onDone)
        }
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = options?.getApprovalPolicy?.() ?? 'ask';
    return (
      <ApprovalPolicyForm
        currentPolicy={current}
        onSelect={(value) =>
          settleThenDone(onApprovalPolicySelect?.(value), value, props.onDone)
        }
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ModelListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().model;
    const selectable = options?.canSelectModel?.() ?? true;
    return (
      <ModelListForm
        currentModel={current}
        apiMode={cliState.sessionMeta.get().apiMode}
        availableRows={props.availableRows}
        selectable={selectable}
        onSelect={(value) =>
          settleThenDone(onModelSelect(value), value, props.onDone)
        }
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function MemoryListFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <MemoryListForm
        availableRows={props.availableRows}
        onSelect={(value) =>
          settleThenDone(
            onMemorySelect?.(value),
            value,
            props.onDone,
            onMemoryError,
          )
        }
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ResumeListFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <ResumeListForm
        availableRows={props.availableRows}
        onSelect={(id) =>
          settleThenDone(onResumeSelect?.(id), id, props.onDone, onResumeError)
        }
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ToolsListFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <ToolsListForm
        availableRows={props.availableRows}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  registerSlashCommand({
    name: 'help',
    description: 'Show available slash commands',
  });
  registerSlashCommand({
    name: 'clear',
    description: 'Start a fresh chat session',
  });
  registerSlashCommand({
    name: 'agent',
    description: 'List or choose the root agent',
    aliases: ['agents'],
    formComponent: AgentListFormAdapter,
  });
  registerSlashCommand({
    name: 'model',
    description: 'List available models',
    aliases: ['models'],
    formComponent: ModelListFormAdapter,
  });
  registerSlashCommand({
    name: 'api',
    description: 'Switch between included relay and personal API keys',
    formComponent: ApiModeFormAdapter,
  });
  registerSlashCommand({
    name: 'auth',
    description: 'Show TeXRA login status',
  });
  registerSlashCommand({
    name: 'approval',
    description: 'Switch approval policy',
    formComponent: ApprovalPolicyFormAdapter,
  });
  registerSlashCommand({
    name: 'yolo',
    description: 'Approve privileged actions automatically',
  });
  registerSlashCommand({
    name: 'status',
    description: 'Open the session status tabs',
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session',
    formComponent: ResumeListFormAdapter,
  });
  registerSlashCommand({
    name: 'memory',
    description: 'List stored memories',
    formComponent: MemoryListFormAdapter,
  });
  registerSlashCommand({
    name: 'tools',
    description: 'List or toggle external integrations',
    formComponent: ToolsListFormAdapter,
  });
  registerSlashCommand({
    name: 'compact',
    description: 'Request context compaction',
  });
  registerSlashCommand({
    name: 'exit',
    description: 'Exit the CLI session',
    aliases: ['quit'],
  });
}
