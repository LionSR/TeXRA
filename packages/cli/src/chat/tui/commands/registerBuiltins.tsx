// Registers the slash commands the input palette surfaces.

import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import { applyCliGitAuthorConfig } from '@cli/runtime/gitAuthor';
import type { GetModelSwitchDisabledReason } from '@cli/runtime/modelAccess';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { AgentCategory, type ExecutionId } from '@shared/schemas';
import {
  readSetting,
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import {
  CLI_STATE_SETTINGS,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { ApiModeForm } from '../forms/ApiModeForm';
import { AgentListForm } from '../forms/AgentListForm';
import { ApprovalPolicyForm } from '../forms/ApprovalPolicyForm';
import { ConfigForm } from '../forms/ConfigForm';
import { LoginForm, type LoginFormValue } from '../forms/LoginForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { ModelListForm } from '../forms/ModelListForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { SkillsListForm, type SkillActivation } from '../forms/SkillsListForm';
import { ToolsListForm } from '../forms/ToolsListForm';
import {
  activeForm,
  patchSessionMeta,
  sessionMeta,
  setCliSessionModelOverride,
} from '../state/cliState';
import { loginFromChat } from './handlers/loginCommands';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';
import { openCliSlashCommandForm } from './slashForms';

type AgentSelectHandler = (value: string) => void | Promise<void>;
type ApprovalPolicySelectHandler = (
  value: CliApprovalPolicy,
) => void | Promise<void>;
type ModelSelectHandler = (value: string) => void | Promise<void>;
type ApiModeSelectHandler = (value: CliApiMode) => void | Promise<void>;
type LoginSelectHandler = (value: LoginFormValue) => void | Promise<void>;
type MemorySelectHandler = (storagePath: string) => void | Promise<void>;
type ResumeSelectHandler = (id: ExecutionId) => void | Promise<void>;
type SkillSelectHandler = (value: SkillActivation) => void | Promise<void>;
type ErrorHandler = (error: unknown) => void | Promise<void>;
type SelectionCompletion = 'afterAction' | 'beforeAction';

async function applyCliConfigSettingSideEffects(
  entry: StateSettingEntry,
  stores: SettingsStores,
  value?: unknown,
  onApiModeSelect?: ApiModeSelectHandler,
): Promise<void> {
  if (entry.category === 'git') {
    applyCliGitAuthorConfig(stores.config);
  }
  if (entry.key === GlobalStateKey.USE_OPENROUTER) {
    invalidateModelOptionsCache();
    if (value === true) {
      await onApiModeSelect?.('personal');
    }
  }
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
  if (completion === 'beforeAction') {
    onDone(value);
  }

  const runAction = async (): Promise<void> => {
    await action();
  };

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
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  onApiModeSelect?: ApiModeSelectHandler;
  onLoginSelect?: LoginSelectHandler;
  onMemorySelect?: MemorySelectHandler;
  onResumeSelect?: ResumeSelectHandler;
  onSkillSelect?: SkillSelectHandler;
  getConfigStores?: () => SettingsStores;
  onError?: ErrorHandler;
}): void {
  const onAgentSelect: AgentSelectHandler =
    options?.onAgentSelect ?? ((agent) => patchSessionMeta({ agent }));
  const onModelSelect: ModelSelectHandler =
    options?.onModelSelect ?? setCliSessionModelOverride;
  const onApiModeSelect: ApiModeSelectHandler =
    options?.onApiModeSelect ?? ((apiMode) => patchSessionMeta({ apiMode }));
  const onLoginSelect: LoginSelectHandler =
    options?.onLoginSelect ?? loginFromChat;
  const canSelectAgent = options?.canSelectAgent ?? (() => true);
  const canSelectModel = options?.canSelectModel ?? (() => true);

  // Picking the root agent and the root model is a single up-front choice
  // before the first message, so advance straight from the agent picker into
  // the model picker instead of closing — the user chooses both in one flow.
  function openModelSelectionForm(): void {
    activeForm.set({
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
    const current = sessionMeta.get().agent;
    const selectable = canSelectAgent();
    return (
      <AgentListForm
        currentAgent={current}
        availableRows={props.availableRows}
        selectable={selectable}
        onSelect={(value) => {
          // Chain into the model picker only while still choosing the root
          // (before the first message) and model selection is available.
          const advanceToModel = selectable && canSelectModel();
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
    const current = sessionMeta.get().apiMode;
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
            completion: 'beforeAction',
          })
        }
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function LoginFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <LoginForm
        availableRows={props.availableRows}
        onSelect={(value) =>
          runFormSelection({
            action: () => onLoginSelect(value),
            value,
            onDone: props.onDone,
            onError: options?.onError,
            completion: 'beforeAction',
          })
        }
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ModelListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = sessionMeta.get().model;
    const selectable = canSelectModel();
    return (
      <ModelListForm
        currentModel={current}
        apiMode={sessionMeta.get().apiMode}
        agentCategory={AgentCategory.ToolUse}
        availableRows={props.availableRows}
        selectable={selectable}
        getModelSwitchDisabledReason={options?.getModelSwitchDisabledReason}
        onSelect={(value) =>
          runFormSelection({
            action: () => onModelSelect(value),
            value,
            onDone: props.onDone,
            onError: options?.onError,
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
        onSelect={(value) =>
          runFormSelection({
            action: () => options?.onSkillSelect?.(value),
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

  registerSlashCommand({
    name: 'help',
    description: 'Show available slash commands',
    category: 'session',
  });
  registerSlashCommand({
    name: 'clear',
    description: 'Start a fresh chat session',
    category: 'session',
  });
  registerSlashCommand({
    name: 'agent',
    description: 'List or choose the root agent',
    aliases: ['agents'],
    category: 'configuration',
    formComponent: AgentListFormAdapter,
  });
  registerSlashCommand({
    name: 'model',
    description: 'List available models',
    aliases: ['models'],
    category: 'configuration',
    formComponent: ModelListFormAdapter,
  });
  registerSlashCommand({
    name: 'api',
    description: 'Choose included TeXRA access or personal API keys',
    category: 'configuration',
    formComponent: ApiModeFormAdapter,
  });
  registerSlashCommand({
    name: 'subscription',
    description: 'Use your ChatGPT subscription for Codex models (on | off)',
    aliases: ['sub'],
    category: 'account',
    takesArgs: true,
  });
  registerSlashCommand({
    name: 'auth',
    description: 'Show TeXRA login status',
    category: 'account',
  });
  registerSlashCommand({
    name: 'login',
    description: 'Sign in to ChatGPT or Researcher Access',
    category: 'account',
    formComponent: LoginFormAdapter,
  });
  registerSlashCommand({
    name: 'logout',
    description: 'Sign out of TeXRA',
    category: 'account',
  });
  registerSlashCommand({
    name: 'approval',
    description: 'Switch approval policy',
    category: 'configuration',
    formComponent: ApprovalPolicyFormAdapter,
    formEscapeAction: 'cancel',
  });
  registerSlashCommand({
    name: 'yolo',
    description: 'Auto-approve privileged actions',
    category: 'configuration',
  });
  registerSlashCommand({
    name: 'status',
    description: 'Show session details',
    category: 'session',
  });
  registerSlashCommand({
    name: 'goal',
    description: 'Explain autonomous goal mode',
    aliases: ['goals'],
    category: 'session',
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session',
    category: 'session',
    formComponent: ResumeListFormAdapter,
  });
  registerSlashCommand({
    name: 'memory',
    description: 'List stored memories',
    category: 'configuration',
    formComponent: MemoryListFormAdapter,
  });
  registerSlashCommand({
    name: 'skills',
    description: 'List available skills',
    aliases: ['skill'],
    category: 'configuration',
    formComponent: SkillsListFormAdapter,
  });
  registerSlashCommand({
    name: 'tools',
    description: 'List or toggle external integrations',
    category: 'configuration',
    formComponent: ToolsListFormAdapter,
  });
  // Only offer /config when the host wired the stores it reads/writes — a
  // command that can't reach a store would render an inert panel.
  const getConfigStores = options?.getConfigStores;
  if (getConfigStores) {
    const ConfigFormAdapter = (props: SlashFormProps): React.JSX.Element => {
      const stores = getConfigStores();
      return (
        <ConfigForm
          availableRows={props.availableRows}
          entries={CLI_STATE_SETTINGS}
          readValue={(entry) => readSetting(entry, stores, 'cli')}
          writeValue={async (entry, value) => {
            await writeSetting(entry, value, stores, 'cli');
            await applyCliConfigSettingSideEffects(
              entry,
              stores,
              value,
              onApiModeSelect,
            );
          }}
          resetValue={async (entry) => {
            await resetSetting(entry, stores, 'cli');
            await applyCliConfigSettingSideEffects(
              entry,
              stores,
              undefined,
              onApiModeSelect,
            );
          }}
          openForm={(formName) => openCliSlashCommandForm(formName, '')}
          onClose={() => props.onDone(undefined)}
          onError={options?.onError}
        />
      );
    };
    registerSlashCommand({
      name: 'config',
      description: 'View and toggle settings',
      aliases: ['settings'],
      category: 'configuration',
      formComponent: ConfigFormAdapter,
      formEscapeAction: 'close',
    });
  }
  registerSlashCommand({
    name: 'compact',
    description: 'Request context compaction',
    category: 'session',
  });
  registerSlashCommand({
    name: 'exit',
    description: 'Exit the CLI session',
    aliases: ['quit'],
    category: 'session',
  });
}
