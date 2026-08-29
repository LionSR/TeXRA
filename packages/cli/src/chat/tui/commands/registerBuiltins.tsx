// Registers the slash commands the input palette surfaces.

import type { GetModelSwitchDisabledReason } from '@cli/runtime/modelAccess';
import { parseCliHistoryId } from '@cli/runtime/history';
import type { CliModelAccessSelection } from '@cli/runtime/modelAccessRoute';
import {
  type CliLogoutTarget,
  type LoginFormValue,
  parseChatLoginSlashArgs,
} from '@cli/runtime/loginOptions';
import type { StreamArtifactReader } from '@cli/chat/tui/state/streamArtifactProjection';
import type { ApiProvider } from '@model/apiProviders';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type ExecutionId } from '@shared/schemas';
import { providerDisplayName } from '@shared/constants/providers';
import { OWN_API_KEYS } from '@shared/copy/modelAccess';
import { RESEARCHER_ACCESS_AUTH } from '@shared/copy/accountAuth';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { collapseWhitespace } from '@utils/text/stringUtils';

import {
  AccountAccessForm,
  type AccountAccessFormValue,
} from '../forms/AccountAccessForm';
import { AgentListForm } from '../forms/AgentListForm';
import { ApprovalPolicyForm } from '../forms/ApprovalPolicyForm';
import { CliConfigForm } from '../forms/CliConfigForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { EnabledModelsForm } from '../forms/EnabledModelsForm';
import { GoalModeForm } from '../forms/GoalModeForm';
import { ModelListForm } from '../forms/ModelListForm';
import { ProviderApiKeyForm } from '../forms/ProviderApiKeyForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { SkillsListForm, type SkillActivation } from '../forms/SkillsListForm';
import { ToolsListForm } from '../forms/ToolsListForm';
import {
  formProgress,
  goalAutoApproveAll,
  patchSessionMeta,
  sessionMeta,
  setTransientNotice,
  setCliSessionModelOverride,
} from '../state/cliState';
import { appendLocalAssistantTranscript } from '../state/transcript';
import {
  applyCliModelSelection,
  applyInitialCliAgentSelection,
} from './handlers/agentModelCommands';
import {
  applyCliModelAccessInput,
  applyCliModelAccessSelection,
  applyCliProviderApiKey,
  showCliAuthStatus,
} from './handlers/modelAccessCommands';
import {
  applyCliApprovalPolicySelection,
  YOLO_USAGE,
} from './handlers/approvalCommand';
import {
  loginFromChat,
  loginStartMessage,
  logoutFromChat,
} from './handlers/loginCommands';
import {
  type SlashCommandOutput,
  transcriptSlashCommandOutput,
} from './handlers/slashContext';
import {
  showCliMemoryList,
  showCliMemoryPreview,
} from './handlers/memoryCommands';
import {
  requestCliSessionCompaction,
  showCliGoalModeHelp,
  showCliSessionStatus,
  showCliSlashCommandHelp,
  showCliWorkPlan,
} from './handlers/sessionCommands';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';
import { openCliSlashCommandForm } from './slashForms';

type SelectHandler<T> = (value: T) => void | Promise<void>;
type FormActionResult =
  void | (Promise<void> & { readonly abort?: () => void });
/** Selection handler that reports progress while the form shows a busy frame. */
type FormActionHandler<T> = (
  value: T,
  output: SlashCommandOutput,
) => FormActionResult;
type ApiKeySaveHandler = (
  provider: ApiProvider,
  key: string,
) => string | void | Promise<string | void>;
type ErrorHandler = (error: unknown) => void | Promise<void>;
type SelectionCompletion = 'afterAction' | 'beforeAction' | 'busy';

/** Build a form selection handler with consistent completion and errors. */
function formSelectionHandler<T>({
  action,
  onDone,
  onError,
  onPersist,
  echoOnPersist = false,
  completion = 'afterAction',
  busyTitle,
  abandonNotice,
}: {
  readonly action: (value: T, output: SlashCommandOutput) => FormActionResult;
  readonly onDone: (value: T) => void;
  readonly onError?: ErrorHandler;
  readonly onPersist?: () => void;
  readonly echoOnPersist?: boolean;
  readonly completion?: SelectionCompletion;
  readonly busyTitle?: (value: T) => string;
  readonly abandonNotice?: (value: T) => string;
}): (value: T) => void {
  return (value) => {
    if (completion === 'busy') {
      // The submission token is the single owner of "is this submission still
      // live": resetCliState clears `formProgress`, so a stale token can never
      // match the current progress.
      const token = Symbol('form submission');
      const actionController: { abort?: () => void } = {};
      const currentProgress = () => {
        const current = formProgress.get();
        return current?.token === token ? current : undefined;
      };
      const close = (): void => {
        if (!currentProgress()) return;
        formProgress.set(undefined);
        onDone(value);
      };
      const cancel = (): void => {
        if (!currentProgress()) return;
        const canAbort = actionController.abort !== undefined;
        try {
          actionController.abort?.();
        } catch {
          // Detaching must still restore the form boundary if abort fails.
        }
        formProgress.set(undefined);
        onDone(value);
        if (!canAbort && abandonNotice !== undefined) {
          setTransientNotice(abandonNotice(value));
        }
      };
      const title = busyTitle?.(value) ?? 'Working';
      const archiveCopyable = (): void => {
        const current = currentProgress();
        if (!current?.copyableMessage || current.copyableMessageArchived) {
          return;
        }
        if (echoOnPersist) onPersist?.();
        appendLocalAssistantTranscript(current.copyableMessage);
        formProgress.set({
          ...current,
          message: 'Authentication instructions were written to scrollback.',
          copyableMessageArchived: true,
        });
      };
      formProgress.set({
        token,
        status: 'running',
        title,
        archiveCopyable,
        cancel,
        dismiss: close,
      });

      const output: SlashCommandOutput = {
        appendOutcome: (message) => {
          if (!currentProgress()) return;
          if (echoOnPersist) onPersist?.();
          appendLocalAssistantTranscript(message);
          const current = currentProgress();
          if (current) formProgress.set({ ...current, message });
        },
        setNotice: (message) => {
          if (currentProgress()) setTransientNotice(message);
        },
        writeProgress: (message, options) => {
          const current = currentProgress();
          if (!current) return;
          formProgress.set({
            ...current,
            message,
            ...(options?.copyable
              ? { copyableMessage: message, copyableMessageArchived: false }
              : {}),
          });
        },
      };

      let actionResult: FormActionResult;
      try {
        actionResult = action(value, output);
      } catch (error: unknown) {
        actionResult = Promise.reject(error);
      }
      if (actionResult?.abort) actionController.abort = actionResult.abort;

      void Promise.resolve(actionResult)
        .then(() => {
          const current = currentProgress();
          if (!current) return;
          if (current.copyableMessage) {
            formProgress.set({ ...current, status: 'succeeded' });
          } else {
            close();
          }
        })
        .catch(async (error: unknown) => {
          let current = currentProgress();
          if (!current) return;
          if (echoOnPersist) onPersist?.();
          const errorMessage = toErrorMessage(error);
          const copyableMessage = current.copyableMessage;
          const persistedError = copyableMessage
            ? new Error(
                `${collapseWhitespace(errorMessage)} · ${collapseWhitespace(
                  copyableMessage,
                )}`,
              )
            : error;
          await onError?.(persistedError);
          current = currentProgress();
          if (!current) return;
          if (current.copyableMessage) {
            formProgress.set({
              ...current,
              status: 'failed',
              message: errorMessage,
            });
          } else {
            close();
          }
        });
      return;
    }

    if (echoOnPersist) onPersist?.();
    if (completion === 'beforeAction') {
      onDone(value);
    }

    const runAction = async (): Promise<void> => {
      await action(value, transcriptSlashCommandOutput);
    };

    void runAction()
      .catch((error: unknown) => {
        if (!echoOnPersist) onPersist?.();
        return onError?.(error);
      })
      .finally(() => {
        if (completion === 'afterAction') {
          onDone(value);
        }
      });
  };
}

export function registerBuiltinSlashCommands(options?: {
  onAgentSelect?: SelectHandler<string>;
  canSelectAgent?: () => boolean;
  getApprovalPolicy?: () => TexraApprovalPolicy;
  onApprovalPolicySelect?: SelectHandler<TexraApprovalPolicy>;
  onModelSelect?: SelectHandler<string>;
  canSelectModel?: () => boolean;
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  onModelAccessSelect?: FormActionHandler<CliModelAccessSelection>;
  onApiKeySave?: ApiKeySaveHandler;
  onLoginSelect?: FormActionHandler<LoginFormValue>;
  onLogoutSelect?: FormActionHandler<CliLogoutTarget>;
  onMemorySelect?: SelectHandler<string>;
  onResumeSelect?: SelectHandler<ExecutionId>;
  onSkillSelect?: SelectHandler<SkillActivation>;
  workPlanSnapshots?: StreamArtifactReader;
  getConfigStores?: () => SettingsStores;
  onError?: ErrorHandler;
}): void {
  const onAgentSelect: SelectHandler<string> =
    options?.onAgentSelect ?? ((agent) => patchSessionMeta({ agent }));
  const onModelSelect: SelectHandler<string> =
    options?.onModelSelect ?? setCliSessionModelOverride;
  const onModelAccessSelect: FormActionHandler<CliModelAccessSelection> =
    options?.onModelAccessSelect ??
    ((selection, output) =>
      applyCliModelAccessSelection(selection, undefined, output));
  const onApiKeySave: ApiKeySaveHandler =
    options?.onApiKeySave ?? applyCliProviderApiKey;
  const onLoginSelect: FormActionHandler<LoginFormValue> =
    options?.onLoginSelect ??
    ((value, output) => loginFromChat(value, undefined, output));
  const onLogoutSelect: FormActionHandler<CliLogoutTarget> =
    options?.onLogoutSelect ??
    ((value, output) => logoutFromChat(value, output));
  const canSelectAgent = options?.canSelectAgent ?? (() => true);
  const canSelectModel = options?.canSelectModel ?? (() => true);

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
          // Picking the root agent and the root model is a single up-front
          // choice before the first message, so chain straight into the model
          // picker instead of closing — but only while still choosing the root
          // and model selection is available.
          onDone:
            selectable && canSelectModel()
              ? () => {
                  openCliSlashCommandForm('model', '');
                }
              : props.onDone,
          onError: options?.onError,
          onPersist: props.onPersist,
          echoOnPersist: props.echoOnPersist,
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function AccountAccessFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <AccountAccessForm
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<AccountAccessFormValue>({
          action: (value, output) => {
            switch (value.kind) {
              case 'access':
                return onModelAccessSelect(value.selection, output);
              case 'login':
                return onLoginSelect(value.target, output);
              case 'logout':
                return onLogoutSelect(value.target, output);
            }
          },
          onDone: props.onDone,
          onError: options?.onError,
          onPersist: props.onPersist,
          echoOnPersist: props.echoOnPersist,
          completion: 'busy',
          busyTitle: (value) => {
            switch (value.kind) {
              case 'access':
                return 'Updating model access';
              case 'login': {
                const args = parseChatLoginSlashArgs(value.target);
                return args ? loginStartMessage(args) : 'Signing in';
              }
              case 'logout':
                return 'Signing out';
            }
          },
          abandonNotice: (value) => {
            switch (value.kind) {
              case 'access':
                return 'Model access update abandoned; it may still complete.';
              case 'login':
                return 'Sign-in abandoned; the browser flow may still complete.';
              case 'logout':
                return 'Sign-out abandoned; it may still complete.';
            }
          },
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
        onSelect={formSelectionHandler<TexraApprovalPolicy>({
          action: (value) => options?.onApprovalPolicySelect?.(value),
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
          onPersist: props.onPersist,
          echoOnPersist: props.echoOnPersist,
        })}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function GoalModeFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <GoalModeForm
        autoApproveAll={goalAutoApproveAll.get()}
        availableRows={props.availableRows}
        onToggle={(enabled) => {
          goalAutoApproveAll.set(enabled);
          props.onDone(enabled);
        }}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ProviderApiKeyFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <ProviderApiKeyForm
        availableRows={props.availableRows}
        onSave={(provider, key) => Promise.resolve(onApiKeySave(provider, key))}
        onDone={(provider, modelNotice) => {
          const label = providerDisplayName(provider);
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

  function ModelListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = sessionMeta.get().model;
    const selectable = canSelectModel();
    return (
      <ModelListForm
        currentModel={current}
        availableRows={props.availableRows}
        selectable={selectable}
        getModelSwitchDisabledReason={options?.getModelSwitchDisabledReason}
        onSelect={formSelectionHandler<string>({
          action: onModelSelect,
          onDone: props.onDone,
          onError: options?.onError,
          onPersist: props.onPersist,
          echoOnPersist: props.echoOnPersist,
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

  // The plain list pickers differ only by their form and their selection
  // action; the completion mode, error routing, and persistence plumbing are
  // one shape, owned here rather than copied per command.
  function makeSelectFormAdapter<T>(
    Form: React.ComponentType<{
      readonly availableRows?: number;
      readonly onSelect: (value: T) => void;
      readonly onClose: () => void;
    }>,
    action: (value: T) => FormActionResult,
  ): React.ComponentType<SlashFormProps> {
    return (props) => (
      <Form
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<T>({
          action,
          onDone: props.onDone,
          onError: options?.onError,
          completion: 'beforeAction',
          onPersist: props.onPersist,
          echoOnPersist: props.echoOnPersist,
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  const MemoryListFormAdapter = makeSelectFormAdapter(
    MemoryListForm,
    (value: string) => options?.onMemorySelect?.(value),
  );
  const ResumeListFormAdapter = makeSelectFormAdapter(
    ResumeListForm,
    (id: ExecutionId) => options?.onResumeSelect?.(id),
  );
  const SkillsListFormAdapter = makeSelectFormAdapter(
    SkillsListForm,
    (value: SkillActivation) => options?.onSkillSelect?.(value),
  );

  registerSlashCommand({
    name: 'help',
    description: 'Show available slash commands',
    category: 'session',
    echo: 'never',
    handler: showCliSlashCommandHelp,
  });
  registerSlashCommand({
    name: 'clear',
    description: 'Start a fresh chat session',
    category: 'session',
    echo: 'ifPersists',
    handler: (_remainder, context) => context.resetSession(),
  });
  registerSlashCommand({
    name: 'agent',
    description: 'List or choose the root agent',
    aliases: ['agents'],
    category: 'configuration',
    echo: 'ifPersists',
    handler: applyInitialCliAgentSelection,
    formComponent: AgentListFormAdapter,
  });
  registerSlashCommand({
    name: 'model',
    description: 'Choose the model for this chat',
    category: 'configuration',
    echo: 'ifPersists',
    handler: applyCliModelSelection,
    formComponent: ModelListFormAdapter,
  });
  const EnabledModelsFormAdapter = (
    props: SlashFormProps,
  ): React.JSX.Element => (
    <EnabledModelsForm
      availableRows={props.availableRows}
      onClose={() => props.onDone(undefined)}
    />
  );
  registerSlashCommand({
    name: 'models',
    description: 'Enable or disable models in pickers',
    category: 'configuration',
    echo: 'never',
    formComponent: EnabledModelsFormAdapter,
  });
  registerSlashCommand({
    name: 'api',
    description: `Sign in, choose ChatGPT, Grok, Kimi Code, GLM, or ${OWN_API_KEYS.inline}`,
    category: 'account',
    echo: 'ifPersists',
    handler: applyCliModelAccessInput,
    formComponent: AccountAccessFormAdapter,
  });
  registerSlashCommand({
    name: 'key',
    description: 'Add a provider API key with masked input',
    aliases: ['keys'],
    category: 'configuration',
    echo: 'never',
    // A remainder never reaches the form: it could be the key itself, so it is
    // refused and dropped rather than pre-filled.
    handler: (remainder) => {
      if (remainder) {
        setTransientNotice(
          'For safety, `/key` does not accept a key as an argument. Enter it in the masked form.',
        );
      }
      openCliSlashCommandForm('key', '');
    },
    formComponent: ProviderApiKeyFormAdapter,
    formEscapeAction: 'close',
    redactInput: true,
  });
  registerSlashCommand({
    name: 'auth',
    description: 'Show signed-in accounts and active model access',
    category: 'account',
    echo: 'ifPersists',
    handler: showCliAuthStatus,
  });
  registerSlashCommand({
    name: 'login',
    description: RESEARCHER_ACCESS_AUTH.slashLoginDescription,
    category: 'account',
    // The form can complete a sign-out or a preference toggle too, so the
    // typed command is not an accurate transcript row; outcomes are written
    // by loginFromChat itself.
    echo: 'never',
    handler: (remainder, context) =>
      loginFromChat(remainder, context.cliContext),
    formComponent: AccountAccessFormAdapter,
  });
  registerSlashCommand({
    name: 'logout',
    description: 'Sign out of one account or all accounts',
    category: 'account',
    // Same merged-form mismatch as /login: the typed command does not
    // describe what the form actually did.
    echo: 'never',
    handler: (remainder) => logoutFromChat(remainder),
    formComponent: AccountAccessFormAdapter,
  });
  registerSlashCommand({
    name: 'approval',
    description: 'Switch approval policy',
    category: 'configuration',
    echo: 'ifPersists',
    handler: applyCliApprovalPolicySelection,
    formRemainders: ['status'],
    formComponent: ApprovalPolicyFormAdapter,
    formEscapeAction: 'cancel',
  });
  registerSlashCommand({
    name: 'yolo',
    description: 'Auto-approve privileged actions',
    category: 'configuration',
    echo: 'ifPersists',
    handler: (remainder, context) =>
      applyCliApprovalPolicySelection(remainder || 'yolo', context, YOLO_USAGE),
  });
  registerSlashCommand({
    name: 'status',
    description: 'Show session details',
    category: 'session',
    echo: 'ifPersists',
    handler: (_remainder, context) => showCliSessionStatus(context),
  });
  registerSlashCommand({
    name: 'plan',
    description: 'Read the focused session work plan',
    category: 'session',
    echo: 'never',
    handler: () => showCliWorkPlan(options?.workPlanSnapshots),
  });
  registerSlashCommand({
    name: 'goal',
    description: 'Configure autonomous goal mode',
    aliases: ['goals'],
    category: 'session',
    echo: 'never',
    handler: showCliGoalModeHelp,
    formComponent: GoalModeFormAdapter,
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session',
    category: 'session',
    echo: 'ifPersists',
    handler: async (remainder, context) => {
      const id = parseCliHistoryId(remainder);
      if (!id) throw new Error(`Invalid execution id: ${remainder}`);
      await context.resumeExecution(id);
    },
    formComponent: ResumeListFormAdapter,
  });
  registerSlashCommand({
    name: 'memory',
    description: 'List stored memories',
    category: 'configuration',
    echo: 'never',
    handler: async (remainder) => {
      if (remainder.toLowerCase() === 'list') await showCliMemoryList();
      else await showCliMemoryPreview(remainder);
    },
    formComponent: MemoryListFormAdapter,
  });
  registerSlashCommand({
    name: 'skills',
    description: 'List skills or activate one',
    aliases: ['skill'],
    category: 'configuration',
    echo: 'never',
    formComponent: SkillsListFormAdapter,
  });
  registerSlashCommand({
    name: 'tools',
    description: 'List or toggle external integrations',
    category: 'configuration',
    echo: 'never',
    formComponent: ToolsListFormAdapter,
  });
  // Only offer /config when the host wired the stores it reads/writes — a
  // command that can't reach a store would render an inert panel.
  const getConfigStores = options?.getConfigStores;
  if (getConfigStores) {
    const ConfigFormAdapter = (props: SlashFormProps): React.JSX.Element => {
      const stores = getConfigStores();
      return (
        <CliConfigForm
          stores={stores}
          availableRows={props.availableRows}
          // Same hook `/approval` drives, so the approval-policy row updates the
          // live session and the status bar from whichever surface set it —
          // including its "Approval mode: …" transcript line, which is the
          // confirmation that the change reached the running session and not
          // just the config file.
          onApprovalPolicyChanged={options?.onApprovalPolicySelect}
          onClose={() => props.onDone(undefined)}
          onError={async (error) => {
            props.onPersist?.();
            await options?.onError?.(error);
          }}
        />
      );
    };
    registerSlashCommand({
      name: 'config',
      description: 'View and toggle settings',
      aliases: ['settings'],
      category: 'configuration',
      echo: 'never',
      formComponent: ConfigFormAdapter,
      formEscapeAction: 'close',
    });
  }
  registerSlashCommand({
    name: 'compact',
    description: 'Request context compaction',
    category: 'session',
    echo: 'ifPersists',
    handler: requestCliSessionCompaction,
  });
  registerSlashCommand({
    name: 'exit',
    description: 'Exit the CLI session',
    aliases: ['quit'],
    category: 'session',
    echo: 'never',
    handler: (_remainder, context) => {
      context.session.stopRequested = true;
      context.interruptActive();
      context.requestInputExit();
    },
  });
}
