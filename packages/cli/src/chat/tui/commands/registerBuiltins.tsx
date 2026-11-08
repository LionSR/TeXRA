// The built-in slash commands, built once per chat from what the chat's
// surface does with each choice.

import { Effect, Result, type Scope } from 'effect';

import { type RunId, runBypasses } from '@texra-ai/harness/schemas';
import { type WorkspaceRoots } from '@texra-ai/harness';
import { InstalledPlugins } from '@texra-ai/harness/host';
import type { GetModelSwitchDisabledReason } from '@cli/runtime/models/modelAccess';
import { parseCliHistoryId } from '@cli/runtime/history';
import type { CliModelAccessSelection } from '@cli/runtime/models/modelAccessRoute';
import type { LoginFormValue } from '@cli/runtime/models/loginOptions';
import type { ServiceConnection } from '@texra/controllers/server/client';
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
import { TasksForm } from '../forms/TasksForm';
import { SkillsListForm, type SkillActivation } from '../forms/SkillsListForm';
import { selectedRunId, sessionMeta } from '../state/cliState';
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
  slashCommands,
  type SlashCommand,
  type SlashCommands,
  type SlashFormProps,
} from './slashRegistry';
import { openRegisteredCliSlashForm } from './slashForms';
import {
  type FormActionHandler,
  modelAccessContribution,
} from './modelAccessContribution';
import type { Session } from '@texra-ai/harness';
import type {
  GlobalValues,
  ProcessRuntime,
  ProcessServices,
} from '@texra-ai/harness/host';
import type { SettingsStores } from '@texra-ai/harness/plugins';
import type { ApprovalPolicy } from '@texra-ai/harness/schemas';

type SelectHandler<T> = (value: T) => SlashCommandEffect;

/** The built-in slash commands, with the two forms the chat opens itself:
 *  `/login` (the "Connect a model" panel) and `/agent` (a first run's
 *  pick). */
export interface BuiltinSlashCommands extends SlashCommands {
  readonly login: SlashCommand;
  readonly agent: SlashCommand;
}

/** Build the built-in slash commands over what the chat's surface does with
 *  each choice. */
export function builtinSlashCommands(options: {
  /**
   * The setting stores the built-in forms and handlers read: they run
   * outside Effect, so the stores arrive from the surface that registers the
   * commands.
   */
  stores: SettingsStores;
  /** The process runtime the account commands and the `/resume` listing run
   *  their programs on, from the same surface. */
  runtime: ProcessRuntime;
  /** The project's stored runs `/resume` lists, where they are held. */
  /** Where the commands' run requests and resumes land: the chat's session,
   *  here or in the service. */
  runSession: Session;
  onAgentSelect: SelectHandler<string>;
  /** `/agent` → a team preset, by id. */
  onTeamSelect: SelectHandler<string>;
  /** After a sign-in, sign-out, preference, or key save finishes: the chat
   *  re-checks whether a model can answer now. */
  onAccountChanged: () => Effect.Effect<void, never, ProcessServices>;
  canSelectAgent: () => boolean;
  getApprovalPolicy: () => ApprovalPolicy;
  /** `/approval`'s choice: the chat's own launch policy, finished once the
   *  chat's run has recorded it. */
  onApprovalPolicySelect: (policy: ApprovalPolicy) => Effect.Effect<void>;
  /** The project's policy `/config` wrote. Stays a plain callback: the
   *  shared write path takes it as a void-returning port. */
  onProjectApprovalPolicyChanged: (policy: ApprovalPolicy) => void;
  onModelSelect: SelectHandler<string>;
  canSelectModel: () => boolean;
  getModelSwitchDisabledReason: GetModelSwitchDisabledReason;
  onModelAccessSelect: FormActionHandler<CliModelAccessSelection>;
  onLoginSelect: FormActionHandler<LoginFormValue>;
  onMemorySelect: SelectHandler<string>;
  onResumeSelect: SelectHandler<RunId>;
  onSkillSelect: SelectHandler<SkillActivation>;
  /** The TeXRA service's client (`/tasks`), through the chat's link; absent
   *  where the chat holds none, and `/tasks` with it. */
  connectService?: () => Effect.Effect<
    Pick<ServiceConnection, 'client'>,
    Error,
    Scope.Scope | GlobalValues
  >;
  /** The project roots `/config` reads and writes. */
  configRoots: WorkspaceRoots;
  onError: ErrorHandler;
}): BuiltinSlashCommands {
  const {
    stores,
    runtime,
    runSession,
    onAgentSelect,
    onModelSelect,
    onTeamSelect,
    canSelectAgent,
    canSelectModel,
  } = options;
  const modelStores = { ...stores, runtime };

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
                  openRegisteredCliSlashForm(model);
                }
              : props.onDone,
        })}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = options.getApprovalPolicy();
    // The grants of the run the status bar describes, offered for revoking
    // only while that run's `actions` takes a grant (the gate `policy.set`
    // is refused by).
    const run = runViewOf(currentView(), selectedRunId.get());
    const runId = run?.actions.includes('grant') === true ? run.id : undefined;
    const bypasses =
      runId === undefined ? undefined : runBypasses(currentView(), runId);
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
                  : revokeCliRunGrant(runSession, runId, value);
              case 'ask':
              case 'never':
              case 'yolo':
                return options.onApprovalPolicySelect(value);
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
        roots={options.runSession.roots}
        {...formProps}
      />
    ),
    options.onMemorySelect,
  );
  // `/resume` lists the project's stored runs; bind the session here so the
  // command still uses the one plain-picker adapter.
  const ResumeListFormAdapter = makeSelectFormAdapter<RunId>(
    (formProps) => (
      <ResumeListForm
        runtime={runtime}
        session={options.runSession}
        {...formProps}
      />
    ),
    options.onResumeSelect,
  );
  const connectService = options.connectService;
  const TasksFormAdapter = connectService
    ? (props: SlashFormProps): React.JSX.Element => (
        <TasksForm
          runtime={runtime}
          connect={connectService}
          availableRows={props.availableRows}
          onClose={() => props.onDone(undefined)}
        />
      )
    : undefined;
  const SkillsListFormAdapter = makeSelectFormAdapter(
    (formProps) => (
      <SkillsListForm
        runtime={runtime}
        roots={options.runSession.roots}
        {...formProps}
      />
    ),
    options.onSkillSelect,
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
      roots={options.runSession.roots}
      runtime={runtime}
      availableRows={props.availableRows}
      onClose={() => props.onDone(undefined)}
    />
  );

  /** `/plugins add <source>`: the install `texra plugin install` runs; the
   *  plugin stays off until it is switched on and trusted in `/plugins`. */
  const addPlugin: (
    remainder: string,
    context: SlashCommandContext,
  ) => SlashCommandEffect = Effect.fn('addPlugin')(function* (
    remainder: string,
    context: SlashCommandContext,
  ) {
    // The source is the rest of the line, so a folder may hold spaces; a
    // trailing `--plugin <name>` picks one plugin of a marketplace.
    const [, verb, rest] = /^(\S+)\s+(.+)$/.exec(remainder.trim()) ?? [];
    const [, source, pick] =
      /^(.+?)(?:\s+--plugin\s+(\S+))?$/.exec(rest ?? '') ?? [];
    if (verb?.toLowerCase() !== 'add' || !source)
      return yield* Effect.fail(new Error(PLUGINS_TUI.addUsage));
    const { roots } = options.runSession;
    const origin = InstalledPlugins.origin(
      source,
      roots.workspace ?? context.cliContext.cwd,
      undefined,
    );
    if (Result.isFailure(origin)) return yield* Effect.fail(origin.failure);
    const added = yield* InstalledPlugins.install(
      origin.success,
      pick === undefined ? [] : [pick],
      roots,
    );
    appendLocalNotice(PLUGINS_TUI.added(added.map(({ name }) => name)));
  });

  const ConfigFormAdapter = (props: SlashFormProps): React.JSX.Element => (
    <CliConfigForm
      roots={options.configRoots}
      runtime={runtime}
      availableRows={props.availableRows}
      // The project's policy, written: the status bar follows it, and
      // the chat's own `/approval` choice stays as it was.
      onApprovalPolicyChanged={options.onProjectApprovalPolicyChanged}
      onClose={() => props.onDone(undefined)}
      onError={async (error) => {
        props.onPersist?.();
        await options.onError(error);
      }}
    />
  );

  const agent: SlashCommand = {
    name: 'agent',
    description: 'Choose an agent, or a team it leads',
    aliases: ['agents'],
    category: 'configuration',
    echo: 'ifPersists',
    handler: applyInitialCliAgentSelection,
    formComponent: AgentListFormAdapter,
  };
  const model: SlashCommand = {
    name: 'model',
    description: 'Choose the model for this chat',
    category: 'configuration',
    echo: 'ifPersists',
    handler: applyCliModelSelection,
    formComponent: ModelListFormAdapter,
  };
  const modelAccess = modelAccessContribution({
    stores,
    runtime,
    bindSelection,
    onModelAccessSelect: options.onModelAccessSelect,
    onLoginSelect: options.onLoginSelect,
    onAccountChanged: options.onAccountChanged,
    onError: options.onError,
  });

  // The contributions' order is the palette's and `/help`'s order.
  const commands = slashCommands([
    {
      pluginId: 'chat-basics',
      commands: [
        {
          name: 'help',
          description: 'Show available slash commands',
          category: 'session',
          echo: 'ifPersists',
          handler: (_remainder, context) =>
            Effect.sync(() => showCliSlashCommandHelp(context.commands)),
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
        agent,
        model,
        {
          name: 'models',
          description: 'Enable or disable models in pickers',
          category: 'configuration',
          echo: 'never',
          formComponent: EnabledModelsFormAdapter,
        },
      ],
    },
    modelAccess,
    {
      pluginId: 'approval',
      commands: [
        {
          name: 'approval',
          description: 'Set the approval policy',
          category: 'configuration',
          echo: 'ifPersists',
          handler: applyCliApprovalPolicySelection,
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
          handler: () => Effect.sync(() => showCliWorkPlan()),
        },
        {
          name: 'resume',
          description:
            'Resume a previous task; /resume all continues every interrupted one',
          category: 'session',
          echo: 'ifPersists',
          handler: Effect.fn('handler')(function* (remainder, context) {
            if (remainder.trim() === 'all')
              return yield* resumeInterruptedTasks(context.resumeTask);
            const id = parseCliHistoryId(remainder);
            if (!id)
              return yield* Effect.fail(
                new Error(`Invalid task id: ${remainder}`),
              );
            yield* context.resumeRun(id);
          }),
          formComponent: ResumeListFormAdapter,
        },
        ...(TasksFormAdapter
          ? [
              {
                name: 'tasks',
                description:
                  "Every project's tasks in the TeXRA service; attach to one live",
                category: 'session' as const,
                echo: 'never' as const,
                formComponent: TasksFormAdapter,
              },
            ]
          : []),
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
              const roots = options.runSession.roots;
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
    {
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
    },
    ...sessionContributions(runSession),
  ]);
  return { ...commands, login: modelAccess.login, agent };
}
