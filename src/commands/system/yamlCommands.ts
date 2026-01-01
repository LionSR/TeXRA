// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';

// Local imports - utilities
import { resolveAgent, getWorkflowAgents } from '@agent/index';
import { loadYaml, loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { getAgentPath } from '@agent/runtime/executeAgent';
import { toErrorMessage } from '@common/errors';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';
import { GlobalStorageFS, StorageFS } from '@utils/files';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export const yamlCommands = {
  testAgentLoading: 'texra.testAgentLoading',
  loadSpecificAgent: 'texra.loadSpecificAgent',
  parseYaml: 'texra.parseYaml',
  testYamlBrackets: 'texra.testYamlBrackets',
};

export async function handleTestAgentLoading(
  _context: vscode.ExtensionContext,
): Promise<void> {
  try {
    logger.info(CHANNEL, 'Testing agent loading from registry:');

    // Get first two workflow agents from registry to test loading
    const agents = getWorkflowAgents();
    if (agents.length === 0) {
      throw new Error('No workflow agents found in registry');
    }

    const testAgent = agents[0];
    logger.info(CHANNEL, `\nTesting agent: ${testAgent.name}`);

    // Resolve the agent
    const resolution = resolveAgent(testAgent.name);
    if (!resolution) {
      throw new Error(`Agent "${testAgent.name}" not found in registry`);
    }

    // Load the YAML directly
    logger.info(CHANNEL, `Loading from: ${resolution.definitionPath}`);
    const rawYaml = await loadYaml(resolution.definitionPath);
    logger.info(
      CHANNEL,
      `Raw YAML loaded: ${JSON.stringify(rawYaml, null, 2)}`,
    );

    // Load with settings and prompts processing
    const [settings, prompts] = await loadAgentSettingAndPrompts(resolution);
    logger.info(CHANNEL, '\nProcessed settings:');
    logger.info(CHANNEL, JSON.stringify(settings, null, 2));
    logger.info(CHANNEL, '\nProcessed prompts:');
    logger.info(CHANNEL, JSON.stringify(prompts, null, 2));

    // Check if this agent has inheritance
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
    const errorMessage = toErrorMessage(err);
    logger.error(CHANNEL, `Agent loading test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      logger.debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(
      `Agent loading test failed: ${errorMessage}`,
    );
  }
}

export async function handleLoadSpecificAgent(
  _context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Get agent name from user
    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter the agent name to load (e.g., "polish", "corect")',
      placeHolder: 'agentName',
    });

    if (!agentName) {
      logger.debug(CHANNEL, 'No agent name provided, cancelling test');
      return;
    }

    logger.info(CHANNEL, `Testing loading of agent: ${agentName}`);

    // Use getAgentPath to resolve the agent
    const agentPath = await getAgentPath(agentName);
    logger.info(
      CHANNEL,
      `Loading from path: ${path.dirname(agentPath.definitionPath)}`,
    );

    // Load and display the agent configuration
    const [settings, prompts] = await loadAgentSettingAndPrompts(agentPath);

    // Display the results
    logger.info(CHANNEL, '\nAgent settings loaded:');
    logger.info(CHANNEL, JSON.stringify(settings, null, 2));
    logger.info(CHANNEL, '\nAgent prompts loaded:');
    logger.info(CHANNEL, JSON.stringify(prompts, null, 2));

    // If the agent inherits from another, show the inheritance chain
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
    const errorMessage = toErrorMessage(err);
    logger.error(CHANNEL, `Failed to load agent: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      logger.debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`Failed to load agent: ${errorMessage}`);
  }
}

export async function handleParseYaml(
  _context: vscode.ExtensionContext,
): Promise<void> {
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
      logger.error(CHANNEL, `Failed to parse YAML: ${toErrorMessage(err)}`);
      vscode.window.showErrorMessage('Failed to parse YAML content');
      await showInstructionWithSuppress(
        'yamlParseFail',
        'The YAML file contains syntax errors. Please correct them and run the command again.',
        undefined,
        false,
      );
    }
  } catch (err) {
    logger.error(CHANNEL, `Error in parseYaml command: ${toErrorMessage(err)}`);
    vscode.window.showErrorMessage('Error parsing YAML');
  }
}

export async function handleTestYamlBrackets(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Initialize StorageFS with the context
    StorageFS.initialize(context);

    logger.info(CHANNEL, 'Testing YAML parsing with angle brackets:');

    // Create a temporary test YAML file
    await GlobalStorageFS.ensureDir('test_yaml');

    // Test YAML content with various angle bracket formats
    const testYaml = {
      test1: '<value>',
      test2: '</value>',
      test3: 'value',
      settings: {
        documentTag: 'latex_document',
        endTag: '</latex_document>',
      },
    };

    // Write test YAML
    const yamlString = yaml.stringify(testYaml);
    await GlobalStorageFS.write('test_yaml/test_brackets.yaml', yamlString);

    // Read and parse the YAML using GlobalStorageFS
    const content = await GlobalStorageFS.read('test_yaml/test_brackets.yaml');
    logger.info(CHANNEL, '\nRaw YAML content:');
    logger.info(CHANNEL, content);

    // Parse the content
    const parsed = yaml.parse(content);
    logger.info(CHANNEL, '\nParsed YAML structure:');
    logger.info(CHANNEL, JSON.stringify(parsed, null, 2));

    // Verify specific fields
    logger.info(CHANNEL, '\nVerifying specific fields:');
    logger.info(CHANNEL, `test1: "${parsed.test1}"`);
    logger.info(CHANNEL, `test2: "${parsed.test2}"`);
    logger.info(CHANNEL, `test3: "${parsed.test3}"`);
    logger.info(
      CHANNEL,
      `settings.documentTag: "${parsed.settings.documentTag}"`,
    );
    logger.info(CHANNEL, `settings.endTag: "${parsed.settings.endTag}"`);

    // Cleanup
    await GlobalStorageFS.delete('test_yaml/test_brackets.yaml');
    await GlobalStorageFS.delete('test_yaml', {
      recursive: true,
    });

    vscode.window.showInformationMessage(
      'YAML bracket test completed. Check Debug Console for results.',
    );
  } catch (err) {
    const errorMessage = toErrorMessage(err);
    logger.error(CHANNEL, `YAML bracket test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      logger.debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`YAML bracket test failed: ${errorMessage}`);
  }
}

export function registerYamlCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(yamlCommands.testAgentLoading, () =>
      handleTestAgentLoading(context),
    ),
    vscode.commands.registerCommand(yamlCommands.loadSpecificAgent, () =>
      handleLoadSpecificAgent(context),
    ),
    vscode.commands.registerCommand(yamlCommands.parseYaml, () =>
      handleParseYaml(context),
    ),
    vscode.commands.registerCommand(yamlCommands.testYamlBrackets, () =>
      handleTestYamlBrackets(context),
    ),
  );
  return yamlCommands;
}
