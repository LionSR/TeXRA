// The built-in slash commands, built once per chat. A command's form and its
// handler both act over the chat's slash context.

import { Effect, Result } from 'effect';

import { type RunId, runBypasses } from '@texra-ai/worldline/schemas';
import { InstalledPlugins } from '@texra-ai/worldline/host';
import { parseCliHistoryId } from '@cli/runtime/history';
import { CliUsageError } from '@cli/runtime/platform/cliContext';
import type { ConnectService } from '../state/attachedTask';
import { RUN_GRANT_ORDER } from '@ui/copy/delegationApproval';

import { PLUGINS_TUI } from './pluginsCopy';
import {
  ApprovalPolicyForm,
  type ApprovalFormValue,
} from '../forms/ApprovalPolicyForm';
import { CliConfigForm } from '../forms/CliConfigForm';
import { EnabledModelsForm } from '../forms/EnabledModelsForm';
import { ModelListForm } from '../forms/ModelListForm';
import { PluginsListForm } from '../forms/PluginsListForm';
import { ResumeListForm } from '../forms/ResumeListForm';
import { TasksForm } from '../forms/TasksForm';
import { SkillsListForm } from '../forms/SkillsListForm';
import { selectedRunId, sessionMeta } from '../state/cliState';
import { currentView, runViewOf } from '../state/sessionView';
import { appendLocalNotice } from '../state/transcript';
import { applyCliModelSelection } from './handlers/modelCommands';
import {
  applyCliApprovalPolicySelection,
  revokeCliRunGrant,
} from './handlers/approvalCommand';
import {
  type SlashCommandContext,
  type SlashCommandEffect,
} from './handlers/slashContext';
import {
  resumeInterruptedTasks,
  sessionContributions,
  showCliSessionStatus,
  showCliSlashCommandHelp,
  showCliWorkPlan,
} from './handlers/sessionCommands';
import {
  bindSelection,
  reportFormError,
  type FormAction,
} from './formSelection';
import {
  slashCommands,
  useSlashContext,
  type SlashCommand,
  type SlashCommands,
  type SlashFormProps,
} from './slashRegistry';
import { modelAccessContribution } from './modelAccessContribution';

/** The built-in slash commands, with the form the chat opens itself:
 *  `/login` (the "Connect a model" panel). */
export interface BuiltinSlashCommands extends SlashCommands {
  readonly login: SlashCommand;
}

/** Build the built-in slash commands. Each form reads the chat's slash
 *  context, as each handler is given it. */
export function builtinSlashCommands(options: {
  /** The TeXRA service's client (`/tasks`), through the chat's link; absent
   *  where the chat holds none, and `/tasks` with it. */
  readonly connectService?: ConnectService;
}): BuiltinSlashCommands {
  function ApprovalPolicyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const context = useSlashContext();
    const current = context.getApprovalPolicy();
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
          context,
          props,
          (value) => {
            switch (value) {
              case 'bash':
              case 'toolEdit':
              case 'superYolo':
                return runId === undefined
                  ? Effect.void
                  : revokeCliRunGrant(context.runSession, runId, value);
              case 'ask':
              case 'never':
              case 'yolo':
                return applyCliApprovalPolicySelection(value, context);
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
    const context = useSlashContext();
    return (
      <ModelListForm
        currentModel={sessionMeta.get().model}
        availableRows={props.availableRows}
        selectable={context.session.canSelectModel()}
        getModelSwitchDisabledReason={context.getModelSwitchDisabledReason}
        onSelect={bindSelection(context, props, applyCliModelSelection)}
        onClose={() => props.onDone(undefined)}
      />
    );
  }

  // The plain list pickers differ only by their form and their selection
  // action.
  function makeSelectFormAdapter<T>(
    Form: React.ComponentType<{
      readonly context: SlashCommandContext;
      readonly availableRows?: number;
      readonly onSelect: (value: T) => void;
      readonly onClose: () => void;
    }>,
    action: FormAction<T>,
  ): React.ComponentType<SlashFormProps> {
    return (props) => {
      const context = useSlashContext();
      return (
        <Form
          context={context}
          availableRows={props.availableRows}
          onSelect={bindSelection(context, props, action, {
            completion: 'beforeAction',
          })}
          onClose={() => props.onDone(undefined)}
        />
      );
    };
  }

  const ResumeListFormAdapter = makeSelectFormAdapter<RunId>(
    ({ context, ...formProps }) => (
      <ResumeListForm session={context.runSession} {...formProps} />
    ),
    (id, context) => context.resumeRun(id),
  );
  const connectService = options.connectService;
  const TasksFormAdapter = connectService
    ? (props: SlashFormProps): React.JSX.Element => (
        <TasksForm
          connect={connectService}
          availableRows={props.availableRows}
          onClose={() => props.onDone(undefined)}
        />
      )
    : undefined;
  const SkillsListFormAdapter = makeSelectFormAdapter<string>(
    ({ context, ...formProps }) => <SkillsListForm {...formProps} />,
    (selection, context) => Effect.sync(() => context.activateSkill(selection)),
  );

  const EnabledModelsFormAdapter = (
    props: SlashFormProps,
  ): React.JSX.Element => (
    <EnabledModelsForm
      availableRows={props.availableRows}
      onClose={() => props.onDone(undefined)}
    />
  );

  const PluginsListFormAdapter = (props: SlashFormProps): React.JSX.Element => (
    <PluginsListForm
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
      return yield* new CliUsageError({ message: PLUGINS_TUI.addUsage });
    const { roots } = context.runSession;
    const origin = InstalledPlugins.origin(
      source,
      roots.workspace ?? context.cliContext.cwd,
      undefined,
    );
    if (Result.isFailure(origin)) return yield* origin.failure;
    const added = yield* InstalledPlugins.install(
      origin.success,
      pick === undefined ? [] : [pick],
      roots,
    );
    appendLocalNotice(PLUGINS_TUI.added(added.map(({ name }) => name)));
  });

  const ConfigFormAdapter = (props: SlashFormProps): React.JSX.Element => (
    <CliConfigForm
      availableRows={props.availableRows}
      onClose={() => props.onDone(undefined)}
      onError={(error) => {
        props.onPersist?.();
        reportFormError(error);
      }}
    />
  );

  const model: SlashCommand = {
    name: 'model',
    description: 'Choose the model for this chat',
    category: 'configuration',
    echo: 'ifPersists',
    handler: applyCliModelSelection,
    formComponent: ModelListFormAdapter,
  };
  const modelAccess = modelAccessContribution();

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
              return yield* new CliUsageError({
                message: `Invalid task id: ${remainder}`,
              });
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
    ...sessionContributions(),
  ]);
  return { ...commands, login: modelAccess.login };
}
