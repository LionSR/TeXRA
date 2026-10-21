/**
 * The Agents page of the settings body both GUI hosts answer through: the
 * agent toggles, the agent-file actions, the custom agent directory and the
 * team presets, with the refresh every mutation ends in. The host binds only
 * what it shows its own way (a document, a folder picker, the AI creator).
 */
import * as path from 'node:path';

import { Effect, FileSystem, absurd } from 'effect';

import {
  AgentCatalog,
  AgentDirectories,
  isStrictlyWithin,
  readCustomAgentDir,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { entryTypeIn, readNormalizedFile } from '@texra-ai/harness/node';
import { GlobalStateKey, toErrorMessage } from '@texra-ai/harness/schemas';
import { formatResultCount } from '@texra-ai/harness/transcript';
import { formatUnknownTeamMessage } from '@common/teams/TeamPlan';
import { agentKey, isPackagedAgentSource } from '@shared/schemas';
import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@texra/agent/templates/agentTemplateRenderer';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { SettingsAgentCatalogController } from '@texra/controllers/settingsView/SettingsAgentCatalogController';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import { allSettledVoid } from '@texra/utils/core/allSettledVoid';
import { registerCustomAgentRoot } from '@tools/agentCatalogFollower';
import type { ProcessServices } from '@texra-ai/harness';

import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

type HostEffect = Effect.Effect<void, Error, ProcessServices>;

/** Rejection reason for a proposed custom-agent file name, or null. */
function validateTemplateAgentName(value: string): string | null {
  if (!value) return 'Name cannot be empty';
  if (value.includes('/') || value.includes('\\')) {
    return 'Name cannot contain path separators';
  }
  if (value.includes(' ')) return 'Use underscores instead of spaces';
  if (/[:#[\]{}|>&*!%@`]/.test(value)) {
    return 'Name cannot contain YAML-special characters';
  }
  return null;
}

/**
 * Render a template agent into its file, refusing to overwrite an existing
 * file. `resourcesRoot` is the packaged `…/resources` directory that holds
 * `templates/<kind>.yaml`.
 */
const writeTemplateAgentFile = Effect.fn('settings.writeTemplateAgentFile')(
  function* (
    input: { task: boolean; name: string; customDir: string },
    resourcesRoot: string,
  ) {
    const fileName = input.name.endsWith('.yaml')
      ? input.name
      : `${input.name}.yaml`;
    const filePath = path.join(input.customDir, fileName);
    const baseName = input.name.replace(/\.yaml$/, '');
    const description = input.task
      ? `${baseName} — document task`
      : `${baseName} — chat agent`;
    const fs = yield* FileSystem.FileSystem;
    if ((yield* entryTypeIn(fs, filePath)) !== undefined) {
      return {
        ok: false,
        message: `A file named "${fileName}" already exists in the custom agents folder.`,
      } as const;
    }
    const raw = yield* readNormalizedFile(
      fs,
      path.join(
        resourcesRoot,
        'templates',
        AGENT_TEMPLATE_FILES[input.task ? 'workflowSingle' : 'toolUse'],
      ),
    );
    yield* fs.writeFileString(
      filePath,
      renderAgentTemplateString(raw, {
        AGENT_NAME: baseName,
        DESCRIPTION: description,
        TOOLS_YAML: DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
      }),
    );
    return { ok: true, filePath } as const;
  },
);

interface SettingsAgentCommandsPorts {
  readonly roots: Pick<WorkspaceRoots, 'repoState' | 'globalState'>;
  /** The packaged resources root; the agent templates live under it. */
  readonly resourcesPath: string;
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
}

/** The Agents page: its arms, its opening data, and its mutation refresh. */
export function settingsAgentCommands(ports: SettingsAgentCommandsPorts) {
  const { bindings, present } = ports;
  const { globalState } = ports.roots;
  /** The page's views over the process's agent catalog. */
  const page = Effect.map(AgentCatalog, (agents) => {
    const workspaceAgents = agents.workspaceAgents(ports.roots);
    return {
      agents,
      workspaceAgents,
      catalog: new SettingsAgentCatalogController({
        repoState: ports.roots.repoState,
        workspaceAgents,
        getAgents: () => [...agents.list()],
        newerBuiltInOf: (entry) => agents.newerBuiltIn(entry)?.source,
      }),
    };
  });
  const customDirectory = AgentDirectories.use((directories) =>
    directories.custom(),
  );

  const postSelection = present.post(
    Effect.gen(function* () {
      const { agents, catalog } = yield* page;
      return {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
        agents: yield* catalog.buildSelectionItems(),
        customAgentIssues: [...agents.scanIssues()],
      };
    }),
  );
  const postCustomDir = present.post(
    Effect.gen(function* () {
      const configuredPath = yield* readCustomAgentDir(globalState);
      return {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
        path: yield* customDirectory,
        isDefault: configuredPath === '',
      };
    }),
  );
  const postPresets = present.post(
    Effect.gen(function* () {
      const { catalog, workspaceAgents } = yield* page;
      return {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
        customPresets: yield* catalog.getCustomPresets(),
        orchestratorAgents: catalog.getOrchestratorAgentNames(),
        activePresetId: yield* workspaceAgents.getActiveTeamId(),
      };
    }),
  );

  /**
   * Repaint the agent list and the team presets, and reload every launcher's
   * catalogs. A mutation that moved agent files re-reads the registry first,
   * so nothing below it paints the catalog it replaced. The presets ride
   * along because enabling one agent rewrites the selection as `custom`,
   * which retires whatever team was applied.
   */
  const refreshAfterAgentMutation = (
    selectedToolUseAgent?: string,
    agentCatalogAlreadyFresh = false,
  ): HostEffect =>
    Effect.gen(function* () {
      if (!agentCatalogAlreadyFresh)
        yield* AgentCatalog.use((agents) => agents.refresh);
      yield* allSettledVoid<Error, ProcessServices>([
        postPresets,
        postSelection,
        bindings.refreshCatalogs(selectedToolUseAgent),
      ]);
    });

  // The file tools admit the new directory before the change reports done,
  // so a `creator` run launched right after can write there.
  const afterCustomDirChange = Effect.andThen(
    registerCustomAgentRoot,
    allSettledVoid<Error, ProcessServices>([
      postCustomDir,
      refreshAfterAgentMutation(),
    ]),
  );

  // A delete already in flight for this agent swallows a second click (#9487):
  // the second request would otherwise open another confirmation and then
  // report the agent the first one removed as not found.
  const activeDeletions = new Set<string>();

  const handlers = {
    setAgentEnabled: (message) =>
      present.reported(
        'Failed to update agent visibility',
        Effect.flatMap(page, ({ workspaceAgents }) =>
          workspaceAgents.setAgentEnabled({
            source: message.agentSource,
            name: message.agentName,
            enabled: message.enabled,
          }),
        ).pipe(Effect.andThen(refreshAfterAgentMutation(undefined, true))),
      ),
    setAllAgentsEnabled: (message) =>
      present.reported(
        'Failed to update agent visibility',
        Effect.flatMap(page, ({ catalog }) =>
          catalog.setAllAgentsEnabled(message),
        ).pipe(Effect.andThen(refreshAfterAgentMutation(undefined, true))),
      ),
    openAgentYaml: (message) =>
      present.reported(
        'Failed to open agent YAML file',
        Effect.gen(function* () {
          const entry = (yield* AgentCatalog).get(
            agentKey(message.agentSource, message.agentName),
          );
          if (!entry?.path) {
            return yield* present.alert(
              entry
                ? `No configuration file found for agent "${message.agentName}". The agent definition may be incomplete — try re-creating it from the Agents tab.`
                : `Agent "${message.agentName}" could not be found. It may have been removed or renamed. Check the Agents tab in Settings to see available agents.`,
            );
          }
          // A packaged definition lives inside the installed host bundle, so
          // opening the file itself would let a save mutate the built-in agent
          // every later scan and launch reads — and silently bypass the
          // adjacent Customize action that makes the editable copy. The host
          // shows it without a buffer that saves over the original.
          const entryPath = entry.path;
          yield* isPackagedAgentSource(message.agentSource)
            ? Effect.flatMap(
                FileSystem.FileSystem.use((fs) => fs.readFileString(entryPath)),
                (text) => bindings.showReadOnlyYaml(entryPath, text),
              )
            : bindings.openPath(entryPath);
        }),
      ),
    customizeAgent: (message) =>
      present.reported(
        'Failed to create custom agent copy',
        Effect.gen(function* () {
          if (message.agentSource === 'plugin') {
            return yield* present.alert(
              `${message.agentName} comes from an installed plugin and has no editable copy; edit the plugin's own agent file instead.`,
            );
          }
          const catalog = yield* AgentCatalog;
          const entry = catalog.get(
            agentKey(message.agentSource, message.agentName),
          );
          if (!entry?.path || entry.digest == null) {
            return yield* present.alert(
              `Agent not found or has no file: ${message.agentName}`,
            );
          }

          // A copy already there is replaced only on the user's say-so.
          const targetPath = yield* catalog
            .customize(entry, 'copy')
            .pipe(
              Effect.catchTag('AgentCustomizeRefused', (refused) =>
                refused.reason === 'exists' && refused.path !== undefined
                  ? Effect.flatMap(
                      bindings.prompt.confirm(
                        `A custom copy already exists: ${path.basename(refused.path)}`,
                        { modal: true, confirmLabel: 'Overwrite' },
                      ),
                      (overwrite) =>
                        overwrite
                          ? catalog.customize(entry, 'overwrite')
                          : Effect.succeed(undefined),
                    )
                  : Effect.as(present.alert(refused.message), undefined),
              ),
            );
          if (targetPath === undefined) return;

          yield* refreshAfterAgentMutation();
          yield* bindings.openPath(targetPath);
          yield* present.notice(
            `Created custom copy: ${path.basename(targetPath)}`,
          );
        }),
      ),
    deleteCustomAgent: (message) =>
      present.reported(
        'Failed to delete custom agent',
        Effect.suspend((): HostEffect => {
          if (activeDeletions.has(message.agentName)) return Effect.void;
          activeDeletions.add(message.agentName);
          return Effect.gen(function* () {
            const entryPath = (yield* AgentCatalog).get(
              agentKey('custom', message.agentName),
            )?.path;
            if (!entryPath) {
              return yield* present.alert(
                `Custom agent not found: ${message.agentName}`,
              );
            }

            const customDir = yield* customDirectory;
            if (!isStrictlyWithin(customDir, entryPath)) {
              return yield* present.alert(
                'Refusing to delete: file is not inside the custom agents directory.',
              );
            }

            const confirmed = yield* bindings.prompt.confirm(
              `Delete "${message.agentName}"? This cannot be undone.`,
              { modal: true, confirmLabel: 'Delete' },
            );
            if (!confirmed) return;

            const fs = yield* FileSystem.FileSystem;
            // `force` is the facade's delete: a path already gone is the
            // post-condition, not a failure.
            yield* fs.remove(entryPath, { force: true });
            // The removal is real only here: the agent list forgets its choice.
            const { workspaceAgents } = yield* page;
            yield* workspaceAgents.forgetDeletedAgent(message.agentName);
            yield* present.notice(`Deleted custom agent: ${message.agentName}`);
            yield* refreshAfterAgentMutation();
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => activeDeletions.delete(message.agentName)),
            ),
          );
        }),
      ),
    keepCustomAgent: (message) =>
      present.reported(
        'Failed to keep the custom agent',
        Effect.gen(function* () {
          const agents = yield* AgentCatalog;
          const custom = agents.get(agentKey('custom', message.agentName));
          const kept =
            custom &&
            (yield* agents
              .customize(custom, 'keep')
              .pipe(
                Effect.catchTag('AgentCustomizeRefused', () =>
                  Effect.succeed(undefined),
                ),
              ));
          if (kept === undefined) {
            return yield* present.alert(
              `${message.agentName} has no newer built-in version to dismiss.`,
            );
          }
          yield* refreshAfterAgentMutation();
        }),
      ),
    revealAgentFile: (message) =>
      present.reported(
        'Failed to reveal agent file',
        Effect.gen(function* () {
          const entry = (yield* AgentCatalog).get(
            agentKey(message.agentSource, message.agentName),
          );
          if (!entry?.path) {
            return yield* present.alert(
              `Agent not found or has no file: ${message.agentName}`,
            );
          }
          yield* bindings.revealPath(entry.path);
        }),
      ),
    openAgentFolder: () =>
      present.reported(
        'Failed to open agent folder',
        Effect.flatMap(customDirectory, bindings.revealPath),
      ),
    createAgent: (message) =>
      present.reported(
        'Failed to create agent',
        Effect.gen(function* () {
          const name = yield* bindings.prompt.input({
            prompt: `Enter a name for the new ${message.task ? 'document task' : 'chat'} agent (without .yaml extension)`,
            placeHolder: 'my_agent',
          });
          if (!name) return;
          const invalid = validateTemplateAgentName(name);
          if (invalid) return yield* present.alert(invalid);
          // The custom agent directory is the user's choice, outside every root,
          // so it is created through the process filesystem.
          const customDir = yield* customDirectory;
          yield* FileSystem.FileSystem.use((fs) =>
            fs.makeDirectory(customDir, { recursive: true }),
          );
          const written = yield* writeTemplateAgentFile(
            { task: message.task, name, customDir },
            ports.resourcesPath,
          );
          if (!written.ok) return yield* present.alert(written.message);
          yield* refreshAfterAgentMutation();
          yield* bindings.openPath(written.filePath);
        }),
      ),
    setCustomAgentDir: () =>
      present.reported(
        'Failed to set custom agent directory',
        Effect.gen(function* () {
          const selected = yield* bindings.pickFolder(
            'Select Custom Agents Folder',
          );
          if (!selected) return;
          // A folder already there is the post-condition; a real fault (the
          // path is a file) fails instead of writing the setting anyway.
          yield* FileSystem.FileSystem.use((fs) =>
            fs.makeDirectory(selected, { recursive: true }),
          );
          yield* globalState.update(GlobalStateKey.CUSTOM_AGENT_DIR, selected);
          yield* afterCustomDirChange;
        }),
      ),
    resetCustomAgentDir: () =>
      present.reported(
        'Failed to reset custom agent directory',
        globalState
          .update(GlobalStateKey.CUSTOM_AGENT_DIR, undefined)
          .pipe(Effect.andThen(afterCustomDirChange)),
      ),
    applyAgentModePreset: (message) =>
      present.reported(
        'Failed to apply agent team',
        Effect.gen(function* () {
          const { workspaceAgents, catalog } = yield* page;
          const result = yield* workspaceAgents.applyTeam(message.presetId);
          switch (result.status) {
            case 'unknown':
              return yield* present.alert(
                formatUnknownTeamMessage(message.presetId),
              );
            case 'applied': {
              const selectedToolUseAgent = yield* catalog.getPresetRoot(
                [...result.preset.agents],
                result.preset.id,
              );
              // The team is committed before this repaint, so a failed
              // repaint says the apply itself went through.
              yield* refreshAfterAgentMutation(selectedToolUseAgent, true).pipe(
                Effect.mapError(
                  (cause) =>
                    new Error(
                      `The team was applied, but the settings view could not be refreshed: ${toErrorMessage(cause)}`,
                      { cause },
                    ),
                ),
              );
              const unresolvedCount = result.resolution.missingAgents.length;
              return yield* present.notice(
                unresolvedCount === 0
                  ? `Applied "${result.preset.name}" team`
                  : `Applied "${result.preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
              );
            }
            default:
              return absurd(result);
          }
        }),
      ),
    saveAgentModePreset: () =>
      present.reported(
        'Failed to save agent team',
        Effect.gen(function* () {
          const name = yield* bindings.prompt.input({
            prompt: 'Name for the new team',
            placeHolder: 'e.g. My Research Team',
          });
          if (!name?.trim()) return;
          const { catalog } = yield* page;
          const preset = yield* catalog.saveCurrentPreset(name);
          yield* refreshAfterAgentMutation(undefined, true);
          yield* present.notice(`Saved team "${preset.name}"`);
        }),
      ),
    deleteAgentModePreset: (message) =>
      present.reported(
        'Failed to delete agent team',
        Effect.gen(function* () {
          const { catalog } = yield* page;
          const target = yield* catalog.getCustomPreset(message.presetId);
          if (!target) {
            return yield* present.alert(
              `Unknown custom team: ${message.presetId}`,
            );
          }
          const confirmed = yield* bindings.prompt.confirm(
            `Delete team "${target.name}"?`,
            { modal: true, confirmLabel: 'Delete' },
          );
          if (!confirmed) return;
          yield* catalog.deleteCustomPreset(message.presetId);
          yield* refreshAfterAgentMutation(undefined, true);
        }),
      ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return {
    handlers,
    /** The Agents page's opening data. */
    postStartup: allSettledVoid<Error, ProcessServices>([
      postPresets,
      postSelection,
      postCustomDir,
    ]),
    refreshAfterAgentMutation,
  };
}
