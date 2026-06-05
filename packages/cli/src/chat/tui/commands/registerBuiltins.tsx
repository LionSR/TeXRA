// Registers the slash commands the input palette surfaces.

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import type { ExecutionId } from '@shared/schemas';

import { ApiModeForm } from '../forms/ApiModeForm';
import { AgentListForm } from '../forms/AgentListForm';
import { ApprovalPolicyForm } from '../forms/ApprovalPolicyForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { ModelListForm } from '../forms/ModelListForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { SkillsListForm } from '../forms/SkillsListForm';
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
type SelectionCompletion = 'afterAction' | 'beforeAction';

function patchSessionMeta<K extends 'agent' | 'model' | 'apiMode'>(
  key: K,
  value: K extends 'apiMode' ? CliApiMode : string,
): void {
  cliState.sessionMeta.set({ ...cliState.sessionMeta.get(), [key]: value });
}

/** Run a form selection handler with consistent completion and error routing. */
function runFormSelection<T>({
  action,
  value,
  onDone,
  onError,
  completion = 'afterAction',
}: {
  readonly action: () => void | Promise<void>;
  readonly value: T;
  readonly onDone: (value: T) => void;
  readonly onError?: ErrorHandler;
  readonly completion?: SelectionCompletion;
}): void {
  const runAction = (): Promise<void> => {
    try {
      return Promise.resolve(action());
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  };

  if (completion === 'beforeAction') {
    onDone(value);
  }

  void runAction()
    .catch((error: unknown) => onError?.(error))
    .finally(() => {
      if (completion === 'afterAction') {
        onDone(value);
      }
    });
}

export function registerBuiltinSlashCommands(options?: {
  onAgentSelect?: AgentSelectHandler;
  canSelectAgent?: () => boolean;
  getApprovalPolicy?: () => CliApprovalPolicy;
  onApprovalPolicySelect?: ApprovalPolicySelectHandler;
  onModelSelect?: ModelSelectHandler;
  canSelectModel?: () => boolean;
  getModelSwitchDisabledReason?: (model: string) => string | undefined;
  onApiModeSelect?: ApiModeSelectHandler;
  onMemorySelect?: MemorySelectHandler;
  onResumeSelect?: ResumeSelectHandler;
  onError?: ErrorHandler;
}): void {
  const onAgentSelect: AgentSelectHandler =
    options?.onAgentSelect ?? ((value) => patchSessionMeta('agent', value));
  const onModelSelect: ModelSelectHandler =
    options?.onModelSelect ?? ((value) => patchSessionMeta('model', value));
  const onApiModeSelect: ApiModeSelectHandler =
    options?.onApiModeSelect ?? ((value) => patchSessionMeta('apiMode', value));

  // Picking the root agent and the root model is a single up-front choice
  // before the first message, so advance straight from the agent picker into
  // the model picker instead of closing — the user chooses both in one flow.
  function openModelSelectionForm(): void {
    cliState.activeForm.set({
      commandName: 'model',
      render: (close, availableRows) => (
        <ModelListFormAdapter
          remainder=""
          availableRows={availableRows}
          onDone={() => close()}
        />
      ),
    });
  }

  function AgentListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().agent;
    const selectable = options?.canSelectAgent?.() ?? true;
    return (
      <AgentListForm
        currentAgent={current}
        availableRows={props.availableRows}
        selectable={selectable}
        onSelect={(value) => {
          // Chain into the model picker only while still choosing the root
          // (before the first message) and model selection is available.
          // Mirror ModelListFormAdapter's own default (`?? true`) so the two
          // agree on what "model selection available" means; otherwise close.
          const advanceToModel =
            selectable && (options?.canSelectModel?.() ?? true);
          runFormSelection({
            action: () => onAgentSelect(value),
            value,
            onDone: advanceToModel
              ? () => openModelSelectionForm()
              : props.onDone,
          });
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
        availableRows={props.availableRows}
        onSelect={(value) =>
          runFormSelection({
            action: () => onApiModeSelect(value),
            value,
            onDone: props.onDone,
            onError: options?.onError,
          })
        }
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = options?.getApprovalPolicy?.() ?? 'ask';
    return (
      <ApprovalPolicyForm
        availableRows={props.availableRows}
        currentPolicy={current}
        onSelect={(value) =>
          runFormSelection({
            action: () => options?.onApprovalPolicySelect?.(value),
            value,
            onDone: props.onDone,
          })
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
        getModelSwitchDisabledReason={options?.getModelSwitchDisabledReason}
        onSelect={(value) =>
          runFormSelection({
            action: () => onModelSelect(value),
            value,
            onDone: props.onDone,
          })
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
          runFormSelection({
            action: () => options?.onMemorySelect?.(value),
            value,
            onDone: props.onDone,
            onError: options?.onError,
            completion: 'beforeAction',
          })
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
          runFormSelection({
            action: () => options?.onResumeSelect?.(id),
            value: id,
            onDone: props.onDone,
            onError: options?.onError,
            completion: 'beforeAction',
          })
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

  function SkillsListFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <SkillsListForm
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
    name: 'login',
    description: 'Sign in to TeXRA included access',
  });
  registerSlashCommand({
    name: 'logout',
    description: 'Sign out of TeXRA',
  });
  registerSlashCommand({
    name: 'approval',
    description: 'Switch approval policy',
    formComponent: ApprovalPolicyFormAdapter,
    formEscapeAction: 'cancel',
  });
  registerSlashCommand({
    name: 'yolo',
    description: 'Auto-approve privileged actions',
  });
  registerSlashCommand({
    name: 'status',
    description: 'Show session details',
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
    name: 'skills',
    description: 'List available skills',
    aliases: ['skill'],
    formComponent: SkillsListFormAdapter,
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
