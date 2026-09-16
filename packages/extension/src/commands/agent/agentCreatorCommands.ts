import * as path from 'node:path';

import { Cause, Effect, FileSystem } from 'effect';
import * as vscode from 'vscode';

import { renderAgentTemplateString } from '@agent/templates';
import {
  AgentCreatorUiFailed,
  type AgentCreatorUI,
  type CreatorConfig,
  TOOL_GROUPS,
  buildCreatorConfig,
  runAgentCreator,
} from '@agent/implementations/agentCreator/agentCreatorFlow';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import { promptToAddAgentToConfig } from '@frontend/agents/register';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { StateStore } from '@platform/interfaces';
import type { AgentCategory } from '@shared/schemas';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'AgentCreator';

/** Cached after first load. Templates are bundled resources — stable for the session. */
let creatorConfig: CreatorConfig | null = null;

const loadCreatorConfig = Effect.fnUntraced(function* (
  context: vscode.ExtensionContext,
) {
  if (creatorConfig) return creatorConfig;
  const fs = yield* FileSystem.FileSystem;
  const templatesDir = path.join(
    context.extensionPath,
    'resources',
    'templates',
  );
  const readTemplate = (name: string) =>
    fs
      .readFileString(path.join(templatesDir, name))
      .pipe(Effect.map(normalizeLineEndings));
  const [workflowYaml, toolUseYaml, workflowSingle, toolUseTpl] =
    yield* Effect.all(
      [
        readTemplate('agentCreatorWorkflow.yaml'),
        readTemplate('agentCreatorToolUse.yaml'),
        readTemplate('agentTemplate-workflowSingle.yaml'),
        readTemplate('agentTemplate-toolUse.yaml'),
      ],
      { concurrency: 'unbounded' },
    );
  creatorConfig = buildCreatorConfig({
    workflowYaml,
    toolUseYaml,
    workflowSingle,
    toolUseTpl,
  });
  return creatorConfig;
});

/**
 * Ask for one line of text in an input box the wizard owns.
 *
 * The box is opened with this program's own cancellation token: cancelling it
 * is what closes a box the user never answered, and the token source is
 * disposed on every path — the answer, a host fault, and interruption.
 */
function askForInput(
  options: vscode.InputBoxOptions,
): Effect.Effect<string | undefined, AgentCreatorUiFailed> {
  return Effect.callback<string | undefined, AgentCreatorUiFailed>((resume) => {
    const tokens = new vscode.CancellationTokenSource();
    let settled = false;
    const dispose = () => {
      settled = true;
      tokens.dispose();
    };
    void Promise.resolve(
      vscode.window.showInputBox(options, tokens.token),
    ).then(
      (value) => {
        dispose();
        resume(Effect.succeed(value));
      },
      (cause: unknown) => {
        dispose();
        resume(
          Effect.fail(
            new AgentCreatorUiFailed({
              reason: 'prompt-failed',
              message: 'VS Code would not show the input box.',
              cause,
            }),
          ),
        );
      },
    );
    return Effect.sync(() => {
      if (settled) return;
      tokens.cancel();
      dispose();
    });
  });
}

/**
 * Multi-select tool-group picker with a persistent prompt hint and a native
 * "Select all / Clear" toggle button on top of the stateful multi-select.
 *
 * The picker is settled here rather than through `settleQuickInput` because
 * this program owns its disposal: an interrupted wizard closes the picker
 * instead of leaving it open over a run that has stopped.
 */
function pickToolGroups(
  agentName: string,
  items: vscode.QuickPickItem[],
): Effect.Effect<readonly vscode.QuickPickItem[] | undefined> {
  return Effect.callback<readonly vscode.QuickPickItem[] | undefined>(
    (resume) => {
      const qp = vscode.window.createQuickPick();
      qp.title = `Tool Use Agent: ${agentName}`;
      qp.placeholder = 'Select tool groups';
      qp.canSelectMany = true;
      qp.items = items;
      const initiallySelected = items.filter((item) => item.picked);
      qp.selectedItems = initiallySelected;
      qp.prompt =
        'Space / click to toggle. Pre-selected groups match your description.';

      let allSelected =
        initiallySelected.length > 0 &&
        initiallySelected.length === items.length;
      let activeSelectAllButton: vscode.QuickInputButton | undefined;
      const refreshSelectAllButton = () => {
        activeSelectAllButton = {
          iconPath: new vscode.ThemeIcon('check-all'),
          tooltip: 'Select all / clear',
          location: vscode.QuickInputButtonLocation?.Input,
          toggle: { checked: allSelected },
        };
        qp.buttons = [activeSelectAllButton];
      };
      refreshSelectAllButton();
      qp.onDidChangeSelection((selected) => {
        allSelected =
          selected.length > 0 && selected.length === qp.items.length;
        refreshSelectAllButton();
      });
      qp.onDidTriggerButton((button) => {
        if (button !== activeSelectAllButton) {
          return;
        }
        allSelected = qp.items.length > 0 && !allSelected;
        qp.selectedItems = allSelected ? [...qp.items] : [];
        refreshSelectAllButton();
      });

      let settled = false;
      const accept = (
        value: readonly vscode.QuickPickItem[] | undefined,
      ): void => {
        if (settled) return;
        settled = true;
        qp.dispose();
        resume(Effect.succeed(value));
      };
      qp.onDidAccept(() => accept(qp.selectedItems));
      qp.onDidHide(() => accept(undefined));
      qp.show();

      return Effect.sync(() => {
        if (settled) return;
        settled = true;
        qp.dispose();
      });
    },
  );
}

function buildVSCodeUI(runtime: ProcessRuntime): AgentCreatorUI {
  return {
    promptAgentName(categoryLabel) {
      return askForInput({
        title: `New ${categoryLabel} Agent`,
        prompt: 'Enter a name for the new agent (without .yaml)',
        validateInput: (value) =>
          !value || /[^a-zA-Z0-9_-]/.test(value)
            ? 'Use letters, numbers, underscore or dash'
            : null,
      });
    },

    promptDescription(title, prompt) {
      return askForInput({ title, prompt });
    },

    pickTools(agentName, suggestedGroups) {
      const suggested = new Set(suggestedGroups);
      const items: vscode.QuickPickItem[] = Object.entries(TOOL_GROUPS).map(
        ([label, group]) => ({
          label,
          description: group.description,
          detail: group.tools.join(', '),
          picked: suggested.has(label),
        }),
      );

      return pickToolGroups(agentName, items).pipe(
        Effect.map((selected) => {
          if (!selected?.length) return undefined;
          const tools: string[] = [];
          const groups: string[] = [];
          for (const item of selected) {
            const group = TOOL_GROUPS[item.label];
            if (group) {
              tools.push(...group.tools);
              groups.push(item.label);
            }
          }
          return { tools, groups };
        }),
      );
    },

    getCustomAgentDir() {
      return agentDirectories.custom().pipe(
        Effect.mapError(
          (cause) =>
            new AgentCreatorUiFailed({
              reason: 'directory-unavailable',
              message: 'The custom agents directory could not be resolved.',
              cause,
            }),
        ),
      );
    },

    showCreatedInfo(filePath) {
      void vscode.window.showInformationMessage(`Created agent at ${filePath}`);
    },

    promptAddToConfig(agentName, category) {
      return Effect.tryPromise({
        try: () =>
          promptToAddAgentToConfig(agentName, 'custom', category, runtime),
        catch: (cause) =>
          new AgentCreatorUiFailed({
            reason: 'config-update-failed',
            message: 'The new agent could not be added to the configuration.',
            cause,
          }),
      });
    },

    openCreatedFile(filePath) {
      return Effect.tryPromise({
        try: async () => {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(filePath),
          );
          await vscode.window.showTextDocument(doc);
        },
        catch: (cause) =>
          new AgentCreatorUiFailed({
            reason: 'open-failed',
            message: 'VS Code would not open the created agent file.',
            cause,
          }),
      });
    },

    renderTemplate: renderAgentTemplateString,
  };
}

/**
 * Runs the agent-creator wizard directly rather than via `executeAgent`.
 * `executeAgent` launches YAML-defined `AgentConfig` runs (`workflow` /
 * `toolUse`) and tracks them as sessions with resume/history semantics; this
 * flow authors a *new* agent YAML and never itself becomes a trackable
 * session, so there is no `AgentConfig` to hand it and no resume state to
 * keep coherent.
 */
export function handleCreateAgentWithAI(
  context: vscode.ExtensionContext,
  globalState: StateStore,
  category: AgentCategory,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
) {
  return Effect.gen(function* () {
    const config = yield* loadCreatorConfig(context);
    yield* runAgentCreator(
      config,
      category,
      buildVSCodeUI(runtime),
      {
        secrets,
        globalState,
      },
      roots,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.promise(async () => {
        await showLoggedErrorMessage(
          CHANNEL,
          'Failed to create agent',
          Cause.squash(cause),
        );
      }),
    ),
  );
}
