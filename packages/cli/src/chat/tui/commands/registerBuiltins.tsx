// The built-in slash command contributions, built from the surface's runtime
// options and installed once at startup.

import { Effect, Result } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { GetModelSwitchDisabledReason } from '@cli/runtime/modelAccess';
import { parseCliHistoryId } from '@cli/runtime/history';
import type { CliModelAccessSelection } from '@cli/runtime/modelAccessRoute';
import type {
  CliLogoutTarget,
  LoginFormValue,
} from '@cli/runtime/loginOptions';
import {
  installPlugins,
  parsePluginOrigin,
} from '@common/plugins/installedPlugins';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { RUN_GRANT_ORDER } from '@ui/copy/delegationApproval';
import { PLUGINS_TUI } from '@ui/copy/plugins';

import { AgentListForm, type AgentPickerValue } from '../forms/AgentListForm';
import {
  ApprovalPolicyForm,
  type ApprovalFormValue,
} from '../forms/ApprovalPolicyForm';
import { CliConfigForm } from '../forms/CliConfigForm';
import { MemoryListForm } from '../forms/MemoryListForm';
import { EnabledModelsForm } from '../forms/EnabledModelsForm';
import { ModelListForm } from '../forms/ModelListForm';
import { PluginsListForm } from '../forms/PluginsListForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { SkillsListForm, type SkillActivation } from '../forms/SkillsListForm';
import {
  patchSessionMeta,
  selectedRunId,
  sessionMeta,
  setTransientNotice,
  setCliSessionModelOverride,
} from '../state/cliState';
import { currentView, runViewOf } from '../state/sessionView';
import { appendLocalNotice } from '../state/transcript';
import {
  applyCliModelSelection,
  applyInitialCliAgentSelection,
} from './handlers/agentModelCommands';
import {
  applyCliApprovalPolicySelection,
  revokeCliRunGrant,
} from './handlers/approvalCommand';
import {
  type SlashCommandContext,
  type SlashCommandEffect,
  type SlashCommandOutput,
} from './handlers/slashContext';
import {
  showCliMemoryList,
  showCliMemoryPreview,
} from './handlers/memoryCommands';
import {
  resumeInterruptedTasks,
  sessionContributions,
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
import {
  type ApiKeySaveHandler,
  type FormActionHandler,
  modelAccessContribution,
} from './modelAccessContribution';

type SelectHandler<T> = (value: T) => SlashCommandEffect;

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
  /** `/agent` → a team preset, by id. */
  onTeamSelect?: SelectHandler<string>;
  /** After a sign-in, sign-out, preference, or key save settles: the chat
   *  re-checks whether a model can answer now. */
  onAccountChanged?: () => Effect.Effect<void, never, ProcessServices>;
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
  const onTeamSelect: SelectHandler<string> =
    options.onTeamSelect ??
    (() =>
      Effect.sync(() =>
        setTransientNotice('Teams can only be chosen in `texra chat`.'),
      ));
  const canSelectAgent = options.canSelectAgent ?? (() => true);
  const canSelectModel = options.canSelectModel ?? (() => true);

  // Every picker's selection runs on this surface's runtime and error hook and
  // completes through its slash form's done and persistence props; a picker
  // passes only its action and what it overrides.
  function bindSelection<T>(
    props: SlashFormProps,
    action: (value: T, output: SlashCommandOutput) => SlashCommandEffect,
    overrides?: Partial<
      Pick<
        Parameters<typeof formSelectionHandler<T>>[0],
        'onDone' | 'completion' | 'busyTitle'
      >
    >,
  ): (value: T) => void {
    return formSelectionHandler<T>({
      runtime,
      action,
      onDone: props.onDone,
      onError: options.onError,
      onPersist: props.onPersist,
      echoOnPersist: props.echoOnPersist,
      ...overrides,
    });
  }

  function AgentListFormAdapter(props: SlashFormProps): React.JSX.Element {
    const meta = sessionMeta.get();
    const selectable = canSelectAgent();
    const onPick: SelectHandler<AgentPickerValue> = (value) =>
      value.kind === 'agent'
        ? onAgentSelect(value.agent)
        : onTeamSelect(value.teamId);
    return (
      <AgentListForm
        runtime={runtime}
        stores={stores}
        currentAgent={meta.agent}
        {...(meta.cliTeamId !== undefined
          ? { currentTeamId: meta.cliTeamId }
          : {})}
        availableRows={props.availableRows}
        selectable={selectable}
        onSelect={bindSelection(props, onPick, {
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
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = options.getApprovalPolicy?.() ?? 'ask';
    // The grants of the run the status bar describes, offered for revoking
    // only while that run's `actions` takes a grant (the gate `policy.set`
    // is refused by).
    const run = runViewOf(currentView(), selectedRunId.get());
    const runId = run?.actions.includes('grant') === true ? run.id : undefined;
    const bypasses =
      runId === undefined
        ? undefined
        : currentView().policy.get(runId)?.bypasses;
    const grants = RUN_GRANT_ORDER.filter((kind) => bypasses?.[kind] === true);
    return (
      <ApprovalPolicyForm
        availableRows={props.availableRows}
        currentPolicy={current}
        grants={grants}
        onSelect={bindSelection<ApprovalFormValue>(
          props,
          (value) => {
            switch (value) {
              case 'bash':
              case 'toolEdit':
              case 'superYolo':
                return runId === undefined
                  ? Effect.void
                  : revokeCliRunGrant(options.runtimeSession, runId, value);
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
          { completion: 'beforeAction' },
        )}
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
        onSelect={bindSelection(props, onModelSelect)}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  // The plain list pickers differ only by their form and their selection
  // action.
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
        onSelect={bindSelection(props, action, {
          completion: 'beforeAction',
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

  const PluginsListFormAdapter = (props: SlashFormProps): React.JSX.Element => (
    <PluginsListForm
      roots={options.runtimeSession.roots}
      runtime={runtime}
      availableRows={props.availableRows}
      onClose={() => props.onDone(undefined)}
    />
  );

  /** `/plugins add <source>`: the install `texra plugin install` runs; the
   *  plugin stays off until it is switched on and trusted in `/plugins`. */
  const addPlugin = (
    remainder: string,
    context: SlashCommandContext,
  ): SlashCommandEffect =>
    Effect.gen(function* () {
      // The source is the rest of the line, so a folder may hold spaces; a
      // trailing `--plugin <name>` picks one plugin of a marketplace.
      const [, verb, rest] = /^(\S+)\s+(.+)$/.exec(remainder.trim()) ?? [];
      const [, source, pick] =
        /^(.+?)(?:\s+--plugin\s+(\S+))?$/.exec(rest ?? '') ?? [];
      if (verb?.toLowerCase() !== 'add' || !source)
        return yield* Effect.fail(new Error(PLUGINS_TUI.addUsage));
      const { roots } = options.runtimeSession;
      const origin = parsePluginOrigin(
        source,
        roots.workspace ?? context.cliContext.cwd,
        undefined,
      );
      if (Result.isFailure(origin)) return yield* Effect.fail(origin.failure);
      const added = yield* installPlugins(
        origin.success,
        pick === undefined ? [] : [pick],
        roots,
      );
      appendLocalNotice(PLUGINS_TUI.added(added.map(({ name }) => name)));
    });

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
          echo: 'ifPersists',
          handler: () => Effect.sync(showCliSlashCommandHelp),
        },
        {
          name: 'clear',
          description: 'Start a new task',
          category: 'session',
          echo: 'ifPersists',
          handler: (_remainder, context) =>
            Effect.sync(() => {
              context.resetSession();
            }),
        },
      ],
    },
    {
      pluginId: 'agent-model',
      commands: [
        {
          name: 'agent',
          description: 'Choose an agent, or a team it leads',
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
    modelAccessContribution({
      secrets,
      stores,
      runtime,
      bindSelection,
      onModelAccessSelect: options.onModelAccessSelect,
      onApiKeySave: options.onApiKeySave,
      onLoginSelect: options.onLoginSelect,
      onLogoutSelect: options.onLogoutSelect,
      onAccountChanged: options.onAccountChanged,
    }),
    {
      pluginId: 'approval',
      commands: [
        {
          name: 'approval',
          description: 'Set the approval policy',
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
          description: 'Show task details and cost',
          category: 'session',
          echo: 'ifPersists',
          handler: (_remainder, context) => showCliSessionStatus(context),
        },
        {
          name: 'plan',
          description: "Read the focused agent's work plan",
          category: 'session',
          echo: 'never',
          handler: () =>
            Effect.sync(() => showCliWorkPlan(options.runtimeSession)),
        },
        {
          name: 'resume',
          description:
            'Resume a previous task; /resume all continues every interrupted one',
          category: 'session',
          echo: 'ifPersists',
          handler: (remainder, context) =>
            Effect.gen(function* () {
              if (remainder.trim() === 'all')
                return yield* resumeInterruptedTasks(context.runtimeSession);
              const id = parseCliHistoryId(remainder);
              if (!id)
                return yield* Effect.fail(
                  new Error(`Invalid task id: ${remainder}`),
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
          echo: 'ifPersists',
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
          name: 'plugins',
          description: 'Switch plugins on or off, or add one',
          aliases: ['plugin'],
          category: 'configuration',
          echo: 'ifPersists',
          handler: addPlugin,
          formComponent: PluginsListFormAdapter,
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
    ...sessionContributions(options.runtimeSession),
  ]);
}
