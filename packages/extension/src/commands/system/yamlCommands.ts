// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';

// Local imports - utilities
import { getAgentsByCategory, resolveAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { loadYaml, loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@frontend/editor/activeFileGuards';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import * as logger from '@logger/logUtils';

const CHANNEL = 'TestCommands';

export async function handleTestAgentLoading(): Promise<void> {
  try {
    logger.info(CHANNEL, 'Testing agent loading from registry:');

    const agents = getAgentsByCategory(AgentCategory.Workflow);
    if (agents.length === 0) {
      throw new Error('No workflow agents found in registry');
    }

    const testAgent = agents[0];
    logger.info(CHANNEL, `\nTesting agent: ${testAgent.name}`);

    const resolution = resolveAgent(testAgent.name);
    if (!resolution) {
      throw new Error(`Agent "${testAgent.name}" not found in registry`);
    }

    logger.info(CHANNEL, `Loading from: ${resolution.definitionPath}`);
    const rawYaml = await loadYaml(resolution.definitionPath);
    logger.info(
      CHANNEL,
      `Raw YAML loaded: ${JSON.stringify(rawYaml, null, 2)}`,
    );

    const [settings, prompts] = await loadAgentSettingAndPrompts(resolution);
    logger.info(CHANNEL, '\nProcessed settings:');
    logger.info(CHANNEL, JSON.stringify(settings, null, 2));
    logger.info(CHANNEL, '\nProcessed prompts:');
    logger.info(CHANNEL, JSON.stringify(prompts, null, 2));

    const config = rawYaml as { inherits?: string };
    if (config?.inherits) {
      logger.info(
        CHANNEL,
        `\nInheritance chain: ${testAgent.name} -> ${config.inherits}`,
      );
    }

    vscode.window.showInformationMessage(
      'Agent loading tests completed. Check Debug Console for results.',
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Agent loading test failed', err);
  }
}

export async function handleLoadSpecificAgent(): Promise<void> {
  try {
    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter the agent name to load (e.g., "polish", "corect")',
      placeHolder: 'agentName',
    });

    if (!agentName) {
      logger.debug(CHANNEL, 'No agent name provided, cancelling test');
      return;
    }

    logger.info(CHANNEL, `Testing loading of agent: ${agentName}`);

    // Diagnostic loader: resolve the free-form name to its definition. Unlike a
    // launch, there's no category context here, so use the plain name resolver.
    const agentPath = resolveAgent(agentName);
    if (!agentPath) {
      void showLoggedErrorMessage(CHANNEL, 'Could not find agent', agentName);
      return;
    }
    logger.info(
      CHANNEL,
      `Loading from path: ${path.dirname(agentPath.definitionPath)}`,
    );

    const [settings, prompts] = await loadAgentSettingAndPrompts(agentPath);

    logger.info(CHANNEL, '\nAgent settings loaded:');
    logger.info(CHANNEL, JSON.stringify(settings, null, 2));
    logger.info(CHANNEL, '\nAgent prompts loaded:');
    logger.info(CHANNEL, JSON.stringify(prompts, null, 2));

    const config = (await loadYaml(agentPath.definitionPath)) as {
      inherits?: string;
    };
    if (config?.inherits) {
      logger.info(
        CHANNEL,
        `\nInheritance chain: ${agentName} -> ${config.inherits}`,
      );
    }

    vscode.window.showInformationMessage(
      `Successfully loaded agent "${agentName}". Check Debug Console for details.`,
    );
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to load agent', err);
  }
}

export async function handleParseYaml(): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.yaml', '.yml'],
      resourceName: 'YAML',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(CHANNEL, 'parse YAML', guardResult.status, 'YAML');
      return;
    }

    const { editor } = guardResult;
    const content = editor.document.getText();
    logger.debug(
      CHANNEL,
      `Parsing YAML content from: ${editor.document.fileName}`,
    );

    try {
      const parsedYaml = yaml.parse(content, {});
      logger.info(CHANNEL, 'Successfully parsed YAML structure');
      logger.debug(
        CHANNEL,
        `Parsed structure: ${JSON.stringify(parsedYaml, null, 2)}`,
      );
    } catch (err) {
      await showLoggedErrorMessage(CHANNEL, 'Failed to parse YAML', err);
      await showInstructionWithSuppress(
        'yamlParseFail',
        'The YAML file contains syntax errors. Please correct them and run the command again.',
        undefined,
        false,
      );
    }
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error parsing YAML', err);
  }
}
