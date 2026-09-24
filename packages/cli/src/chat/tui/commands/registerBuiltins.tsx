// The built-in slash command contributions, built from the surface's runtime
// options and installed once at startup.

import { Effect } from 'effect';

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
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';

import {
  AccountAccessForm,
  type AccountAccessFormValue,
} from '../forms/AccountAccessForm';
import { AgentListForm } from '../forms/AgentListForm';
import {
  ApprovalPolicyForm,
  type ApprovalFormValue,
} from '../forms/ApprovalPolicyForm';
import { CliConfigForm } from '../forms/CliConfigForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { EnabledModelsForm } from '../forms/EnabledModelsForm';
import { ModelListForm } from '../forms/ModelListForm';
import { ProviderApiKeyForm } from '../forms/ProviderApiKeyForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { SkillsListForm, type SkillActivation } from '../forms/SkillsListForm';
import {
  goalAutoApproveAll,
  patchSessionMeta,
  selectedRunId,
  sessionMeta,
  setTransientNotice,
  setCliSessionModelOverride,
} from '../state/cliState';
import { currentView, runViewOf } from '../state/sessionView';
import { appendLocalAssistantTranscript } from '../state/transcript';
import {
  applyCliModelSelection,
  applyInitialCliAgentSelection,
} from './handlers/agentModelCommands';
import {
  applyCliModelAccessSelection,
  applyCliProviderApiKey,
  showCliAccountStatus,
} from './handlers/modelAccessCommands';
import {
  applyCliApprovalPolicySelection,
  setCliRunBypass,
} from './handlers/approvalCommand';
import {
  loginFromChat,
  loginStartMessage,
  logoutFromChat,
} from './handlers/loginCommands';
import {
  type SlashCommandEffect,
  type SlashCommandOutput,
} from './handlers/slashContext';
import {
  showCliMemoryList,
  showCliMemoryPreview,
} from './handlers/memoryCommands';
import {
  requestCliSessionCompaction,
  showCliSessionStatus,
  showCliSlashCommandHelp,
  showCliWorkPlan,
} from './handlers/sessionCommands';
import { type ErrorHandler, formSelectionHandler } from './formSelection';
import {
  installSlashCommands,
  type SlashCommandContribution,
  type SlashFormProps,
} from './slashRegistry';
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

/**
 * Build the built-in contributions from the surface's runtime options and
 * install them, replacing the installed slash command table.
 */
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
    // The run the status bar describes: its bypass badges are how a toggle
    // here reads as applied.
    const runId = runViewOf(currentView(), selectedRunId.get())?.id;
    const bypasses =
      runId === undefined
        ? undefined
        : currentView().policy.get(runId)?.bypasses;
    const bypassState = (kind: 'bash' | 'toolEdit'): boolean | undefined =>
      runId === undefined ? undefined : bypasses?.[kind] === true;
    return (
      <ApprovalPolicyForm
        availableRows={props.availableRows}
        currentPolicy={current}
        toggles={{
          bash: bypassState('bash'),
          toolEdit: bypassState('toolEdit'),
          goal: goalAutoApproveAll.get(),
        }}
        onSelect={formSelectionHandler<ApprovalFormValue>({
          runtime,
          action: (value) => {
            switch (value) {
              case 'goal':
                return Effect.sync(() => {
                  const enabled = !goalAutoApproveAll.get();
                  goalAutoApproveAll.set(enabled);
                  appendLocalAssistantTranscript(
                    `Goal mode approves all work: ${enabled ? 'on' : 'off'}`,
                  );
                });
              case 'bash':
              case 'toolEdit':
                return runId === undefined
                  ? Effect.void
                  : setCliRunBypass(
                      options.runtimeSession,
                      runId,
                      value,
                      !bypassState(value),
                    );
              case 'ask':
              case 'never':
              case 'yolo':
                return Effect.sync(() =>
                  options.onApprovalPolicySelect?.(value),
                );
              default:
                return value satisfies never;
            }
          },
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

  function configContribution(
    configStores: SettingsStores,
  ): SlashCommandContribution {
    const ConfigFormAdapter = (props: SlashFormProps): React.JSX.Element => {
      return (
        <CliConfigForm
          stores={configStores}
          secrets={secrets}
          runtime={runtime}
          workspaceRoot={options.runtimeSession.roots.workspace}
          availableRows={props.availableRows}
          // Same hook `/approval` drives, so the approval-policy row updates
          // the live session and the status bar from whichever surface set
          // it — including its "Approval mode: …" transcript line, which is
          // the confirmation that the change reached the running session and
          // not just the config file.
          onApprovalPolicyChanged={options.onApprovalPolicySelect}
          onClose={() => props.onDone(undefined)}
          onError={async (error) => {
            props.onPersist?.();
            await options.onError?.(error);
          }}
        />
      );
    };
    return {
      pluginId: 'config',
      commands: [
        {
          name: 'config',
          description: 'View and toggle settings',
          aliases: ['settings'],
          category: 'configuration',
          echo: 'never',
          formComponent: ConfigFormAdapter,
        },
      ],
    };
  }

  // The contributions' order is the palette's and `/help`'s order.
  installSlashCommands([
    {
      pluginId: 'chat-basics',
      commands: [
        {
          name: 'help',
          description: 'Show available slash commands',
          category: 'session',
          echo: 'never',
          handler: () => Effect.sync(showCliSlashCommandHelp),
        },
        {
          name: 'clear',
          description: 'Start a fresh chat session',
          category: 'session',
          echo: 'ifPersists',
          handler: (_remainder, context) =>
            Effect.sync(() => context.resetSession()),
        },
      ],
    },
    {
      pluginId: 'agent-model',
      commands: [
        {
          name: 'agent',
          description: 'List or choose the root agent',
          aliases: ['agents'],
          category: 'configuration',
          echo: 'ifPersists',
          handler: (remainder, context) =>
            applyInitialCliAgentSelection(remainder, context),
          formComponent: AgentListFormAdapter,
        },
        {
          name: 'model',
          description: 'Choose the model for this chat',
          category: 'configuration',
          echo: 'ifPersists',
          handler: applyCliModelSelection,
          formComponent: ModelListFormAdapter,
        },
        {
          name: 'models',
          description: 'Enable or disable models in pickers',
          category: 'configuration',
          echo: 'never',
          formComponent: EnabledModelsFormAdapter,
        },
      ],
    },
    {
      pluginId: 'model-access',
      commands: [
        {
          name: 'key',
          description: 'Add a provider API key with masked input',
          aliases: ['keys'],
          category: 'account',
          echo: 'never',
          // A remainder never reaches the form: it could be the key itself,
          // so it is refused and dropped rather than pre-filled.
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
          redactInput: true,
        },
        {
          name: 'login',
          description: 'Sign in or out, and choose subscriptions or API keys',
          category: 'account',
          // One form owns sign-in, sign-out, and subscription preferences, so
          // the typed command is not an accurate transcript row; outcomes are
          // written by the form's handlers.
          echo: 'never',
          handler: (remainder, context) =>
            remainder.trim().toLowerCase() === 'status'
              ? showCliAccountStatus(stores, secrets)
              : loginFromChat(remainder, stores, runtime, context.cliContext),
          formComponent: AccountAccessFormAdapter,
        },
      ],
    },
    {
      pluginId: 'approval',
      commands: [
        {
          name: 'approval',
          description: 'Set the approval policy and auto-approvals',
          category: 'configuration',
          echo: 'ifPersists',
          handler: (remainder, context) =>
            Effect.sync(() =>
              applyCliApprovalPolicySelection(remainder, context),
            ),
          formRemainders: ['status'],
          formComponent: ApprovalPolicyFormAdapter,
        },
      ],
    },
    {
      pluginId: 'session-info',
      commands: [
        {
          name: 'status',
          description: 'Show session details',
          category: 'session',
          echo: 'ifPersists',
          handler: (_remainder, context) => showCliSessionStatus(context),
        },
        {
          name: 'plan',
          description: 'Read the focused session work plan',
          category: 'session',
          echo: 'never',
          handler: () =>
            Effect.sync(() => showCliWorkPlan(options.runtimeSession)),
        },
        {
          name: 'resume',
          description: 'Resume a previous session',
          category: 'session',
          echo: 'ifPersists',
          handler: (remainder, context) =>
            Effect.gen(function* () {
              const id = parseCliHistoryId(remainder);
              if (!id)
                return yield* Effect.fail(
                  new Error(`Invalid run id: ${remainder}`),
                );
              yield* context.resumeRun(id);
            }),
          formComponent: ResumeListFormAdapter,
        },
      ],
    },
    {
      pluginId: 'workspace',
      commands: [
        {
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
        },
        {
          name: 'skills',
          description: 'List skills or activate one',
          aliases: ['skill'],
          category: 'configuration',
          echo: 'never',
          formComponent: SkillsListFormAdapter,
        },
      ],
    },
    // Only offer /config when the host wired the stores it reads/writes — a
    // command that can't reach a store would render an inert panel.
    ...(options.configStores ? [configContribution(options.configStores)] : []),
    {
      pluginId: 'session-lifecycle',
      commands: [
        {
          name: 'compact',
          description: 'Request context compaction',
          category: 'session',
          echo: 'ifPersists',
          handler: () => requestCliSessionCompaction(options.runtimeSession),
        },
        {
          name: 'exit',
          description: 'Exit the CLI session',
          aliases: ['quit'],
          category: 'session',
          echo: 'never',
          handler: (_remainder, context) =>
            Effect.sync(() => {
              // Deliberately does NOT interrupt: the graceful teardown owns
              // that policy and skips the interrupt for a resumable-idle root,
              // so `/exit` agrees with Ctrl-C by construction instead of
              // pre-empting it.
              //
              // `stopRequested` stays and is the sole writer on this path. The
              // teardown awaits the follow-up queue's `idle` BEFORE setting the
              // flag itself, and the queued task polls this flag — dropping it
              // would hang `/exit` forever with a follow-up queued and no
              // stream id yet.
              context.session.stopRequested = true;
              context.requestInputExit();
            }),
        },
      ],
    },
  ]);
}
