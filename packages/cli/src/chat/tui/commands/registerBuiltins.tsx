// Registers the slash commands the input palette surfaces.

import { ApiModeForm } from '../forms/ApiModeForm';
import { AgentListForm } from '../forms/AgentListForm';
import { ApprovalPolicyForm } from '../forms/ApprovalPolicyForm';
import { ModelListForm } from '../forms/ModelListForm';
import { cliState } from '../state/cliState';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';
import type { CliApiMode } from '../../../runtime/apiAccessMode';
import type { CliApprovalPolicy } from '../../../runtime/approvalPolicy';

type AgentSelectHandler = (value: string) => void | Promise<void>;
type ApprovalPolicySelectHandler = (
  value: CliApprovalPolicy,
) => void | Promise<void>;
type ModelSelectHandler = (value: string) => void | Promise<void>;
type ApiModeSelectHandler = (value: CliApiMode) => void | Promise<void>;

function patchSessionMeta<K extends 'agent' | 'model' | 'apiMode'>(
  key: K,
  value: K extends 'apiMode' ? CliApiMode : string,
): void {
  cliState.sessionMeta.set({ ...cliState.sessionMeta.get(), [key]: value });
}

export function registerBuiltinSlashCommands(options?: {
  onAgentSelect?: AgentSelectHandler;
  canSelectAgent?: () => boolean;
  getApprovalPolicy?: () => CliApprovalPolicy;
  onApprovalPolicySelect?: ApprovalPolicySelectHandler;
  onModelSelect?: ModelSelectHandler;
  canSelectModel?: () => boolean;
  onApiModeSelect?: ApiModeSelectHandler;
}): void {
  const onAgentSelect: AgentSelectHandler =
    options?.onAgentSelect ?? ((value) => patchSessionMeta('agent', value));
  const onApprovalPolicySelect = options?.onApprovalPolicySelect;
  const onModelSelect: ModelSelectHandler =
    options?.onModelSelect ?? ((value) => patchSessionMeta('model', value));
  const onApiModeSelect: ApiModeSelectHandler =
    options?.onApiModeSelect ?? ((value) => patchSessionMeta('apiMode', value));

  function AgentListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().agent;
    const selectable = options?.canSelectAgent?.() ?? true;
    return (
      <AgentListForm
        currentAgent={current}
        selectable={selectable}
        onSelect={(value) => {
          void Promise.resolve(onAgentSelect(value)).finally(() =>
            props.onDone(value),
          );
        }}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ApiModeFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().apiMode;
    return (
      <ApiModeForm
        currentMode={current}
        onSelect={(value) => {
          void Promise.resolve(onApiModeSelect(value)).finally(() =>
            props.onDone(value),
          );
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = options?.getApprovalPolicy?.() ?? 'ask';
    return (
      <ApprovalPolicyForm
        currentPolicy={current}
        onSelect={(value) => {
          void Promise.resolve(onApprovalPolicySelect?.(value)).finally(() =>
            props.onDone(value),
          );
        }}
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
        onSelect={(value) => {
          void Promise.resolve(onModelSelect(value)).finally(() =>
            props.onDone(value),
          );
        }}
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
    formComponent: AgentListFormAdapter,
  });
  registerSlashCommand({
    name: 'model',
    description: 'List available models',
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
  });
  registerSlashCommand({
    name: 'exit',
    description: 'Exit the CLI session',
    aliases: ['quit'],
  });
}
