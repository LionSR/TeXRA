// Registers the slash commands the input palette surfaces.

import { Cause, Effect, Fiber } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { GetModelSwitchDisabledReason } from '@cli/runtime/modelAccess';
import { parseCliHistoryId } from '@cli/runtime/history';
import type { CliModelAccessSelection } from '@cli/runtime/modelAccessRoute';
import {
  type CliLogoutTarget,
  type LoginFormValue,
  parseChatLoginSlashArgs,
} from '@cli/runtime/loginOptions';
import type { ApiProvider } from '@model/apiProviders';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { OWN_API_KEYS } from '@ui/copy/modelAccess';
import { RESEARCHER_ACCESS_AUTH } from '@ui/copy/accountAuth';
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
  type SlashCommandEffect,
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

type SelectHandler<T> = (value: T) => SlashCommandEffect;
/** Selection handler that reports progress while the form shows a busy frame. */
type FormActionHandler<T> = (
  value: T,
  output: SlashCommandOutput,
) => SlashCommandEffect;
/** The key write as a program; the form that collects the key runs it. */
type ApiKeySaveHandler = (
  provider: ApiProvider,
  key: string,
) => Effect.Effect<string | void, Error>;
type ErrorHandler = (error: unknown) => void;
type SelectionCompletion = 'afterAction' | 'beforeAction' | 'busy';

/** Build a form selection handler with consistent completion and errors. */
function formSelectionHandler<T>({
  runtime,
  action,
  onDone,
  onError,
  onPersist,
  echoOnPersist = false,
  completion = 'afterAction',
  busyTitle,
}: {
  readonly runtime: ProcessRuntime;
  readonly action: (value: T, output: SlashCommandOutput) => SlashCommandEffect;
  readonly onDone: (value: T) => void;
  readonly onError?: ErrorHandler;
  readonly onPersist?: () => void;
  readonly echoOnPersist?: boolean;
  readonly completion?: SelectionCompletion;
  readonly busyTitle?: (value: T) => string;
}): (value: T) => void {
  // Every host's error hook writes to its transcript and returns; reporting
  // is a step of the failure path, not a wait inside it.
  const reportError = (error: unknown): Effect.Effect<void> =>
    Effect.sync(() => {
      onError?.(error);
    });
  return (value) => {
    if (completion === 'busy') {
      // The submission token is the single owner of "is this submission still
      // live": resetCliState clears `formProgress`, so a stale token can never
      // match the current progress.
      const token = Symbol('form submission');
      const currentProgress = () => {
        const current = formProgress.get();
        return current?.token === token ? current : undefined;
      };
      const close = (): void => {
        if (!currentProgress()) return;
        formProgress.set(undefined);
        onDone(value);
      };
      // The running submission IS the forked fiber below, so Escape
      // interrupts it instead of detaching from a promise that keeps running.
      const cancel = (): void => {
        if (!currentProgress()) return;
        runtime.runFork(Fiber.interrupt(actionFiber));
        formProgress.set(undefined);
        onDone(value);
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

      const actionFiber = runtime.runFork(
        Effect.suspend(() => action(value, output)).pipe(
          Effect.matchCauseEffect({
            onSuccess: () =>
              Effect.sync(() => {
                const current = currentProgress();
                if (!current) return;
                if (current.copyableMessage) {
                  formProgress.set({ ...current, status: 'succeeded' });
                } else {
                  close();
                }
              }),
            onFailure: (cause) =>
              Effect.gen(function* () {
                let current = currentProgress();
                if (!current) return;
                if (echoOnPersist) onPersist?.();
                const error = Cause.squash(cause);
                const errorMessage = toErrorMessage(error);
                const copyableMessage = current.copyableMessage;
                yield* reportError(
                  copyableMessage
                    ? new Error(
                        `${collapseWhitespace(errorMessage)} · ${collapseWhitespace(
                          copyableMessage,
                        )}`,
                      )
                    : error,
                );
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
              }),
          }),
        ),
      );
      return;
    }

    if (echoOnPersist) onPersist?.();
    if (completion === 'beforeAction') {
      onDone(value);
    }

    runtime.runFork(
      Effect.suspend(() => action(value, transcriptSlashCommandOutput)).pipe(
        Effect.catchCause((cause) =>
          Effect.suspend(() => {
            if (!echoOnPersist) onPersist?.();
            return reportError(Cause.squash(cause));
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (completion === 'afterAction') {
              onDone(value);
            }
          }),
        ),
      ),
    );
  };
}

export function registerBuiltinSlashCommands(options: {
  /**
   * The process secret store and the three setting slots the built-in forms and handlers
   * read: every one of them runs outside Effect, so the stores arrive from the
   * surface that registers the commands.
   */
  secrets: PlatformSecrets;
  stores: SettingsStores;
  /** The process runtime the account commands and the `/resume` listing run
   *  their programs on, from the same surface. */
  runtime: ProcessRuntime;
  /** The session `/resume` lists history from and `/plan` and `/compact` act
   *  on, threaded from the surface that registers the commands. */
  runtimeSession: SessionHandle;
  onAgentSelect?: SelectHandler<string>;
  canSelectAgent?: () => boolean;
  getApprovalPolicy?: () => TexraApprovalPolicy;
  /** Stays a plain callback: `/config`'s shared write path takes the same
   *  hook as a void-returning port, so an Effect here would never run. */
  onApprovalPolicySelect?: (policy: TexraApprovalPolicy) => void;
  onModelSelect?: SelectHandler<string>;
  canSelectModel?: () => boolean;
  getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  onModelAccessSelect?: FormActionHandler<CliModelAccessSelection>;
  onApiKeySave?: ApiKeySaveHandler;
  onLoginSelect?: FormActionHandler<LoginFormValue>;
  onLogoutSelect?: FormActionHandler<CliLogoutTarget>;
  onMemorySelect?: SelectHandler<string>;
  onResumeSelect?: SelectHandler<RunId>;
  onSkillSelect?: SelectHandler<SkillActivation>;
  configStores?: SettingsStores;
  onError?: ErrorHandler;
}): void {
  const { secrets, stores, runtime } = options;
  const modelStores = { ...stores, secrets, runtime };
  const onAgentSelect: SelectHandler<string> =
    options.onAgentSelect ??
    ((agent) => Effect.sync(() => patchSessionMeta({ agent })));
  const onModelSelect: SelectHandler<string> =
    options.onModelSelect ??
    ((model) => Effect.sync(() => setCliSessionModelOverride(model)));
  const onModelAccessSelect: FormActionHandler<CliModelAccessSelection> =
    options.onModelAccessSelect ??
    ((selection, output) =>
      applyCliModelAccessSelection(stores, selection, undefined, output));
  const onApiKeySave: ApiKeySaveHandler =
    options.onApiKeySave ??
    ((provider, key) => applyCliProviderApiKey(secrets, stores, provider, key));
  const onLoginSelect: FormActionHandler<LoginFormValue> =
    options.onLoginSelect ??
    ((value, output) =>
      loginFromChat(value, stores, runtime, undefined, output));
  const onLogoutSelect: FormActionHandler<CliLogoutTarget> =
    options.onLogoutSelect ??
    ((value, output) => logoutFromChat(value, stores, secrets, output));
  const canSelectAgent = options.canSelectAgent ?? (() => true);
  const canSelectModel = options.canSelectModel ?? (() => true);

  function AgentListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = sessionMeta.get().agent;
    const selectable = canSelectAgent();
    return (
      <AgentListForm
        runtime={runtime}
        stores={stores}
        currentAgent={current}
        availableRows={props.availableRows}
        selectable={selectable}
        onSelect={formSelectionHandler<string>({
          runtime,
          action: onAgentSelect,
          // Picking the root agent and the root model is a single up-front
          // choice before the first message, so chain straight into the model
          // picker instead of closing — but only while still choosing the root
          // and model selection is available. The agent form closes first:
          // `takeActiveForm` requeues what it displaces, and a finished pick
          // must not come back when the model picker closes.
          onDone:
            selectable && canSelectModel()
              ? (value) => {
                  props.onDone(value);
                  openCliSlashCommandForm('model', '');
                }
              : props.onDone,
          onError: options.onError,
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
        secrets={secrets}
        stores={stores}
        runtime={runtime}
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<AccountAccessFormValue>({
          runtime,
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
          onError: options.onError,
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
        })}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = options.getApprovalPolicy?.() ?? 'ask';
    return (
      <ApprovalPolicyForm
        availableRows={props.availableRows}
        currentPolicy={current}
        onSelect={formSelectionHandler<TexraApprovalPolicy>({
          runtime,
          action: (value) =>
            Effect.sync(() => options.onApprovalPolicySelect?.(value)),
          onDone: props.onDone,
          onError: options.onError,
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
        runtime={runtime}
        onSave={onApiKeySave}
        onDone={(provider, modelNotice) => {
          // The shared key controller posts the "key has been set" notice on
          // every host; only the coding-plan tip is this surface's to write.
          if (modelNotice) appendLocalAssistantTranscript(modelNotice);
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
        stores={modelStores}
        availableRows={props.availableRows}
        selectable={selectable}
        getModelSwitchDisabledReason={options.getModelSwitchDisabledReason}
        onSelect={formSelectionHandler<string>({
          runtime,
          action: onModelSelect,
          onDone: props.onDone,
          onError: options.onError,
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
        state={stores.globalState}
        runtime={runtime}
        workspaceRoot={options.runtimeSession.roots.workspace}
        config={options.runtimeSession.roots.config}
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
    action: (value: T) => SlashCommandEffect,
  ): React.ComponentType<SlashFormProps> {
    return (props) => (
      <Form
        availableRows={props.availableRows}
        onSelect={formSelectionHandler<T>({
          runtime,
          action,
          onDone: props.onDone,
          onError: options.onError,
          completion: 'beforeAction',
          onPersist: props.onPersist,
          echoOnPersist: props.echoOnPersist,
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  const MemoryListFormAdapter = makeSelectFormAdapter<string>(
    (formProps) => (
      <MemoryListForm
        runtime={runtime}
        roots={options.runtimeSession.roots}
        {...formProps}
      />
    ),
    (value: string) => options.onMemorySelect?.(value) ?? Effect.void,
  );
  // `/resume` reads history from the process session; bind it here so the
  // command still uses the one plain-picker adapter.
  const ResumeListFormAdapter = makeSelectFormAdapter<RunId>(
    (formProps) => (
      <ResumeListForm
        runtime={runtime}
        session={options.runtimeSession}
        {...formProps}
      />
    ),
    (id: RunId) => options.onResumeSelect?.(id) ?? Effect.void,
  );
  const SkillsListFormAdapter = makeSelectFormAdapter(
    (formProps) => (
      <SkillsListForm
        runtime={runtime}
        workspaceRoot={options.runtimeSession.roots.workspace}
        stores={options.runtimeSession.roots}
        {...formProps}
      />
    ),
    (value: SkillActivation) => options.onSkillSelect?.(value) ?? Effect.void,
  );

  registerSlashCommand({
    name: 'help',
    description: 'Show available slash commands',
    category: 'session',
    echo: 'never',
    handler: () => Effect.sync(showCliSlashCommandHelp),
  });
  registerSlashCommand({
    name: 'clear',
    description: 'Start a fresh chat session',
    category: 'session',
    echo: 'ifPersists',
    handler: (_remainder, context) => Effect.sync(() => context.resetSession()),
  });
  registerSlashCommand({
    name: 'agent',
    description: 'List or choose the root agent',
    aliases: ['agents'],
    category: 'configuration',
    echo: 'ifPersists',
    handler: (remainder, context) =>
      applyInitialCliAgentSelection(remainder, context),
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
      state={stores.globalState}
      runtime={runtime}
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
    handler: (remainder, context) =>
      applyCliModelAccessInput(stores, remainder, context),
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
    handler: (remainder) =>
      Effect.sync(() => {
        if (remainder) {
          setTransientNotice(
            'For safety, `/key` does not accept a key as an argument. Enter it in the masked form.',
          );
        }
        openCliSlashCommandForm('key', '');
      }),
    formComponent: ProviderApiKeyFormAdapter,
    formEscapeAction: 'close',
    redactInput: true,
  });
  registerSlashCommand({
    name: 'auth',
    description: 'Show signed-in accounts and active model access',
    category: 'account',
    echo: 'ifPersists',
    handler: () => showCliAuthStatus(stores, secrets),
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
      loginFromChat(remainder, stores, runtime, context.cliContext),
    formComponent: AccountAccessFormAdapter,
  });
  registerSlashCommand({
    name: 'logout',
    description: 'Sign out of one account or all accounts',
    category: 'account',
    // Same merged-form mismatch as /login: the typed command does not
    // describe what the form actually did.
    echo: 'never',
    handler: (remainder) => logoutFromChat(remainder, stores, secrets),
    formComponent: AccountAccessFormAdapter,
  });
  registerSlashCommand({
    name: 'approval',
    description: 'Switch approval policy',
    category: 'configuration',
    echo: 'ifPersists',
    handler: (remainder, context) =>
      Effect.sync(() => applyCliApprovalPolicySelection(remainder, context)),
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
      Effect.sync(() =>
        applyCliApprovalPolicySelection(
          remainder || 'yolo',
          context,
          YOLO_USAGE,
        ),
      ),
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
    handler: () => Effect.sync(() => showCliWorkPlan(options.runtimeSession)),
  });
  registerSlashCommand({
    name: 'goal',
    description: 'Configure autonomous goal mode',
    aliases: ['goals'],
    category: 'session',
    echo: 'never',
    handler: () => Effect.sync(showCliGoalModeHelp),
    formComponent: GoalModeFormAdapter,
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session',
    category: 'session',
    echo: 'ifPersists',
    handler: (remainder, context) =>
      Effect.gen(function* () {
        const id = parseCliHistoryId(remainder);
        if (!id)
          return yield* Effect.fail(new Error(`Invalid run id: ${remainder}`));
        yield* context.resumeRun(id);
      }),
    formComponent: ResumeListFormAdapter,
  });
  registerSlashCommand({
    name: 'memory',
    description: 'List stored memories',
    category: 'configuration',
    echo: 'never',
    handler: (remainder) =>
      Effect.suspend(() => {
        const roots = options.runtimeSession.roots;
        return remainder.toLowerCase() === 'list'
          ? showCliMemoryList(roots)
          : showCliMemoryPreview(roots, remainder);
      }),
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
  const configStores = options.configStores;
  if (configStores) {
    const ConfigFormAdapter = (props: SlashFormProps): React.JSX.Element => {
      return (
        <CliConfigForm
          stores={configStores}
          secrets={secrets}
          runtime={runtime}
          workspaceRoot={options.runtimeSession.roots.workspace}
          availableRows={props.availableRows}
          // Same hook `/approval` drives, so the approval-policy row updates the
          // live session and the status bar from whichever surface set it —
          // including its "Approval mode: …" transcript line, which is the
          // confirmation that the change reached the running session and not
          // just the config file.
          onApprovalPolicyChanged={options.onApprovalPolicySelect}
          onClose={() => props.onDone(undefined)}
          onError={async (error) => {
            props.onPersist?.();
            await options.onError?.(error);
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
    handler: () => requestCliSessionCompaction(options.runtimeSession),
  });
  registerSlashCommand({
    name: 'exit',
    description: 'Exit the CLI session',
    aliases: ['quit'],
    category: 'session',
    echo: 'never',
    handler: (_remainder, context) =>
      Effect.sync(() => {
        // Deliberately does NOT interrupt: the graceful teardown owns that
        // policy and skips the interrupt for a resumable-idle root, so `/exit`
        // agrees with Ctrl-C by construction instead of pre-empting it.
        //
        // `stopRequested` stays and is the sole writer on this path. The
        // teardown awaits the follow-up queue's `idle` BEFORE setting the flag
        // itself, and the queued task polls this flag — dropping it would hang
        // `/exit` forever with a follow-up queued and no stream id yet.
        context.session.stopRequested = true;
        context.requestInputExit();
      }),
  });
}
