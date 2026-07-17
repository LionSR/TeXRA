// Registers the slash commands the input palette surfaces.

import type { GetModelSwitchDisabledReason } from '@cli/runtime/modelAccess';
import type { CliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import type { CliLogoutTarget } from '@cli/runtime/loginOptions';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import type { ApiProvider } from '@model/apiProviders';
import { AgentCategory, type ExecutionId } from '@shared/schemas';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import type { SettingsStores } from '@shared/config/settingsAccess';

import { ModelAccessForm } from '../forms/ModelAccessForm';
import { AgentListForm } from '../forms/AgentListForm';
import { ApprovalPolicyForm } from '../forms/ApprovalPolicyForm';
import { ConfigForm } from '../forms/ConfigForm';
import { createCliConfigFormProps } from '../forms/CliConfigForm';
import { LoginForm, type LoginFormValue } from '../forms/LoginForm';
import { LogoutForm } from '../forms/LogoutForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { ModelListForm } from '../forms/ModelListForm';
import { ProviderApiKeyForm } from '../forms/ProviderApiKeyForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { SkillsListForm, type SkillActivation } from '../forms/SkillsListForm';
import { ToolsListForm } from '../forms/ToolsListForm';
import {
  activeForm,
  patchSessionMeta,
  sessionMeta,
  setCliSessionModelOverride,
} from '../state/cliState';
import { appendLocalAssistantTranscript } from '../state/transcript';
import { applyCliProviderApiKey } from './handlers/apiModeCommands';
import { loginFromChat, logoutFromChat } from './handlers/loginCommands';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';
import { openCliSlashCommandForm } from './slashForms';

type AgentSelectHandler = (value: string) => void | Promise<void>;
type ApprovalPolicySelectHandler = (
  value: CliApprovalPolicy,
) => void | Promise<void>;
type ModelSelectHandler = (value: string) => void | Promise<void>;
type ModelAccessSelectHandler = (
  value: CliModelAccessRoute,
) => void | Promise<void>;
type ApiKeySaveHandler = (
  provider: ApiProvider,
  key: string,
) => string | void | Promise<string | void>;
type LoginSelectHandler = (value: LoginFormValue) => void | Promise<void>;
type LogoutSelectHandler = (value: CliLogoutTarget) => void | Promise<void>;
type MemorySelectHandler = (storagePath: string) => void | Promise<void>;
type ResumeSelectHandler = (id: ExecutionId) => void | Promise<void>;
type SkillSelectHandler = (value: SkillActivation) => void | Promise<void>;
type ErrorHandler = (error: unknown) => void | Promise<void>;
type SelectionCompletion = 'afterAction' | 'beforeAction';

/** Build a form selection handler with consistent completion and errors. */
function formSelectionHandler<T>({
  action,
  onDone,
  onError,
  completion = 'afterAction',
}: {
  readonly action: (value: T) => void | Promise<void>;
  readonly onDone: (value: T) => void;
  readonly onError?: ErrorHandler;
  readonly completion?: SelectionCompletion;
}): (value: T) => void {
  return (value) => {
    if (completion === 'beforeAction') {
      onDone(value);
    }

    const runAction = async (): Promise<void> => {
      await action(value);
    };

    void runAction()
      .catch((error: unknown) => onError?.(error))
      .finally(() => {
        if (completion === 'afterAction') {
          onDone(value);
        }
      });
  };
}

export function registerBuiltinSlashCommands(options?: {
  onAgentSelect?: AgentSelectHandler;
  canSelectAgent?: () => boolean;
  getApprovalPolicy?: () => CliApprovalPolicy;
  onApprovalPolicySelect?: ApprovalPolicySelectHandler;
  onModelSelect?: ModelSelectHandler;
  canSelectModel?: () => boolean;
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  onModelAccessSelect?: ModelAccessSelectHandler;
  onApiKeySave?: ApiKeySaveHandler;
  onLoginSelect?: LoginSelectHandler;
  onLogoutSelect?: LogoutSelectHandler;
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
  const onModelAccessSelect: ModelAccessSelectHandler =
    options?.onModelAccessSelect ??
    ((route) => {
      if (route !== 'chatgpt') patchSessionMeta({ apiMode: route });
    });
  const onApiKeySave: ApiKeySaveHandler =
    options?.onApiKeySave ?? applyCliProviderApiKey;
  const onLoginSelect: LoginSelectHandler =
    options?.onLoginSelect ?? loginFromChat;
  const onLogoutSelect: LogoutSelectHandler =
    options?.onLogoutSelect ?? logoutFromChat;
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
        onSelect={formSelectionHandler<string>({
          action: onAgentSelect,
          // Chain into the model picker only while still choosing the root
          // and model selection is available.
          onDone:
            selectable && canSelectModel()
              ? () => openModelSelectionForm()
              : props.onDone,
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ModelAccessFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = sessionMeta.get().apiMode;
    return (
      <ModelAccessForm
        apiMode={current}
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<CliModelAccessRoute>({
          action: onModelAccessSelect,
          onDone: props.onDone,
          onError: options?.onError,
        })}
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
        onSelect={formSelectionHandler<CliApprovalPolicy>({
          action: (value) => options?.onApprovalPolicySelect?.(value),
          onDone: props.onDone,
          completion: 'beforeAction',
        })}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ProviderApiKeyFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <ProviderApiKeyForm
        availableRows={props.availableRows}
        onSave={(provider, key) => Promise.resolve(onApiKeySave(provider, key))}
        onDone={(provider, modelNotice) => {
          const label = PROVIDER_DISPLAY_NAMES[provider] ?? provider;
          appendLocalAssistantTranscript(
            [
              `Saved the ${label} API key.`,
              ...(modelNotice ? [modelNotice] : []),
            ].join('\n'),
          );
          props.onDone(provider);
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function LoginFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <LoginForm
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<LoginFormValue>({
          action: onLoginSelect,
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
        })}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function LogoutFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <LogoutForm
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<CliLogoutTarget>({
          action: onLogoutSelect,
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
        })}
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
        onSelect={formSelectionHandler<string>({
          action: onModelSelect,
          onDone: props.onDone,
          onError: options?.onError,
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function MemoryListFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <MemoryListForm
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<string>({
          action: (value) => options?.onMemorySelect?.(value),
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ResumeListFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <ResumeListForm
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<ExecutionId>({
          action: (id) => options?.onResumeSelect?.(id),
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
        })}
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
        onSelect={formSelectionHandler<SkillActivation>({
          action: (value) => options?.onSkillSelect?.(value),
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
        })}
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
    description: 'Choose ChatGPT, included TeXRA, or personal model access',
    category: 'configuration',
    formComponent: ModelAccessFormAdapter,
  });
  registerSlashCommand({
    name: 'key',
    description: 'Add a provider API key with masked input',
    aliases: ['keys'],
    category: 'configuration',
    formComponent: ProviderApiKeyFormAdapter,
    formEscapeAction: 'close',
    redactInput: true,
  });
  registerSlashCommand({
    name: 'subscription',
    description: 'Adjust the legacy ChatGPT preference (on | off)',
    aliases: ['sub'],
    category: 'account',
    takesArgs: true,
  });
  registerSlashCommand({
    name: 'auth',
    description: 'Show both accounts and active model access',
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
    description: 'Sign out of one account or all accounts',
    category: 'account',
    formComponent: LogoutFormAdapter,
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
          {...createCliConfigFormProps({
            stores,
            availableRows: props.availableRows,
            openExternalForm: (formName) =>
              openCliSlashCommandForm(formName, ''),
            onClose: () => props.onDone(undefined),
            onError: options?.onError,
            onApiModePersonal: () => onModelAccessSelect('personal'),
          })}
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
