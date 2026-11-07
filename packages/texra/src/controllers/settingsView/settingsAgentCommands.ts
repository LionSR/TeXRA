/**
 * The Agents page of the settings body both GUI hosts answer through: the
 * agent toggles, the agent-file actions, the custom agent directory and the
 * team presets, with the refresh every mutation ends in. The host binds only
 * what it shows its own way (a document, a folder picker, the AI creator).
 */
import * as path from 'node:path';

import { Effect, FileSystem, absurd } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/harness';
import {
  AgentCatalog,
  AgentDirectories,
  isStrictlyWithin,
  readCustomAgentDir,
  registerCustomAgentRoot,
  CUSTOM_AGENT_DIR_KEY,
} from '@texra-ai/harness/host';
import { entryTypeIn, readNormalizedFile } from '@texra-ai/harness/node';
import {
  agentKey,
  isPackagedAgentSource,
  toErrorMessage,
  formatResultCount,
} from '@texra-ai/harness/schemas';
import { workspaceTeams } from '@texra/shared/agentTeams';
import { formatUnknownTeamMessage } from '@texra/shared/teamLaunch';
import { applyTeam } from '@texra/shared/teamPlan';
import {
  AGENT_TEMPLATE_FILES,
  agentFileFromTemplate,
} from '@texra/agent/templates/agentTemplates';
import { SettingsAgentCatalogController } from '@texra/controllers/settingsView/SettingsAgentCatalogController';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import type { ProcessServices } from '@texra-ai/harness/host';

import {
  hostStatePage,
  type SettingsHostBindings,
  type SettingsPresentation,
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
 * Write a template agent into its file, refusing to overwrite an existing
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
        AGENT_TEMPLATE_FILES[input.task ? 'documentTask' : 'chat'],
      ),
    );
    yield* fs.writeFileString(
      filePath,
      agentFileFromTemplate(raw, { name: baseName, description }),
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

/** What the person is told when customizing kept their own copies of files
 *  the agent binds: the copy now reads as current, so nothing else says the
 *  bundled ones differ. */
function keptDifferingNotice(files: readonly string[]): string {
  return files.length === 1
    ? `Kept your existing ${files[0]}; it differs from the built-in one.`
    : `Kept your existing ${files.join(', ')}; they differ from the built-in ones.`;
}

/** The Agents page: its arms, its pages, and what an agent change runs. */
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

  const pages = [
    hostStatePage(
      'agents',
      ['agents'],
      Effect.gen(function* () {
        const { agents, catalog } = yield* page;
        return {
          agents: yield* catalog.buildSelectionItems(),
          customAgentIssues: [...agents.scanIssues()],
        };
      }),
    ),
    hostStatePage(
      'customAgentDir',
      ['agents'],
      Effect.gen(function* () {
        const configuredPath = yield* readCustomAgentDir(globalState);
        return {
          path: yield* customDirectory,
          isDefault: configuredPath === '',
        };
      }),
    ),
    // The presets follow the agents because enabling one agent rewrites the
    // selection as `custom`, which retires whatever team was applied.
    hostStatePage(
      'teams',
      ['agents'],
      Effect.gen(function* () {
        const { catalog, workspaceAgents } = yield* page;
        return {
          // The setup starter is a selectable agent list, not a team card.
          presets: (yield* workspaceTeams(ports.roots.repoState)).filter(
            (preset) => !preset.setupOnly,
          ),
          orchestratorAgents: catalog.getOrchestratorAgentNames(),
          activePresetId: yield* workspaceAgents.getActiveTeamId(),
        };
      }),
    ),
  ];

  /** The agents changed: the pages follow, and every launcher's catalogs
   *  reload, selecting the tool-use root a team just applied named. */
  const agentsChanged = (selectedToolUseAgent?: string): HostEffect =>
    Effect.andThen(
      present.changed('agents'),
      bindings.refreshCatalogs(selectedToolUseAgent),
    );
  /** A mutation moved agent files: the registry is read again first, so
   *  nothing that follows paints the catalog it replaced. */
  const agentFilesChanged = Effect.andThen(
    AgentCatalog.use((agents) => agents.refresh),
    agentsChanged(),
  );

  // The file tools admit the new directory before the change reports done,
  // so a `creator` run launched right after can write there.
  const afterCustomDirChange = Effect.andThen(
    registerCustomAgentRoot,
    agentFilesChanged,
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
        ).pipe(Effect.andThen(agentsChanged())),
      ),
    setAllAgentsEnabled: (message) =>
      present.reported(
        'Failed to update agent visibility',
        Effect.flatMap(page, ({ catalog }) =>
          catalog.setAllAgentsEnabled(message),
        ).pipe(Effect.andThen(agentsChanged())),
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
          const copy = yield* catalog.customize(entry, 'copy').pipe(
            Effect.catchTag('AgentCustomizeRefused', (refused) =>
              refused.reason === 'exists' && refused.path !== undefined
                ? Effect.flatMap(
                    bindings.dialogs.confirm({
                      message: `A custom copy already exists: ${path.basename(refused.path)}`,
                      action: 'Overwrite',
                    }),
                    (overwrite) =>
                      overwrite
                        ? catalog.customize(entry, 'overwrite')
                        : Effect.succeed(undefined),
                  )
                : Effect.as(present.alert(refused.message), undefined),
            ),
          );
          if (copy === undefined) return;

          yield* agentFilesChanged;
          yield* bindings.openPath(copy.path);
          yield* present.notice(
            `Created custom copy: ${path.basename(copy.path)}`,
          );
          if (copy.keptDiffering.length > 0)
            yield* present.notice(keptDifferingNotice(copy.keptDiffering));
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

            const confirmed = yield* bindings.dialogs.confirm({
              message: `Delete "${message.agentName}"? This cannot be undone.`,
              action: 'Delete',
            });
            if (!confirmed) return;

            const fs = yield* FileSystem.FileSystem;
            // `force` is the facade's delete: a path already gone is the
            // post-condition, not a failure.
            yield* fs.remove(entryPath, { force: true });
            // The removal is real only here: the agent list forgets its choice.
            const { workspaceAgents } = yield* page;
            yield* workspaceAgents.forgetDeletedAgent(message.agentName);
            yield* present.notice(`Deleted custom agent: ${message.agentName}`);
            yield* agentFilesChanged;
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
          yield* agentFilesChanged;
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
          const name = yield* bindings.dialogs.input({
            prompt: `Enter a name for the new ${message.task ? 'document task' : 'chat'} agent (without .yaml extension)`,
            placeholder: 'my_agent',
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
          yield* agentFilesChanged;
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
          yield* globalState.update(CUSTOM_AGENT_DIR_KEY.key, selected);
          yield* afterCustomDirChange;
        }),
      ),
    resetCustomAgentDir: () =>
      present.reported(
        'Failed to reset custom agent directory',
        globalState
          .update(CUSTOM_AGENT_DIR_KEY.key, undefined)
          .pipe(Effect.andThen(afterCustomDirChange)),
      ),
    applyAgentModePreset: (message) =>
      present.reported(
        'Failed to apply agent team',
        Effect.gen(function* () {
          const { agents, workspaceAgents } = yield* page;
          const result = yield* applyTeam(message.presetId, {
            workspaceAgents,
            repoState: ports.roots.repoState,
            resolveAgent: agents.get,
          });
          switch (result.status) {
            case 'unknown':
              return yield* present.alert(
                formatUnknownTeamMessage(message.presetId),
              );
            case 'applied': {
              const { preset, rootAgent, missingAgents } = result.plan;
              // The team is committed before this repaint, so a failed
              // repaint says the apply itself went through.
              yield* agentsChanged(rootAgent?.name).pipe(
                Effect.mapError(
                  (cause) =>
                    new Error(
                      `The team was applied, but the settings view could not be refreshed: ${toErrorMessage(cause)}`,
                      { cause },
                    ),
                ),
              );
              const unresolvedCount = missingAgents.length;
              return yield* present.notice(
                unresolvedCount === 0
                  ? `Applied "${preset.name}" team`
                  : `Applied "${preset.name}" with ${formatResultCount(unresolvedCount, 'member')} still unavailable`,
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
          const name = yield* bindings.dialogs.input({
            prompt: 'Name for the new team',
            placeholder: 'e.g. My Research Team',
          });
          if (!name?.trim()) return;
          const { catalog } = yield* page;
          const preset = yield* catalog.saveCurrentPreset(name);
          yield* agentsChanged();
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
          const confirmed = yield* bindings.dialogs.confirm({
            message: `Delete team "${target.name}"?`,
            action: 'Delete',
          });
          if (!confirmed) return;
          yield* catalog.deleteCustomPreset(message.presetId);
          yield* agentsChanged();
        }),
      ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return { handlers, pages, agentsChanged };
}
