// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import * as yaml from 'yaml';

// Local imports - utilities
import { loadYaml, loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import * as logger from '@logger/logUtils';
import { getAgentPath } from '@agent/runtime/executeAgent';
import { AgentType } from '@agent/core/AgentDataclass';
import { showInstructionWithSuppress } from '@frontend/ui/instruction';
import { GlobalStorageFS, StorageFS } from '@utils/files';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@utils/editor/activeFileGuards';

const CHANNEL = 'TestCommands';
logger.initialize(CHANNEL);

export const yamlCommands = {
  testAgentLoading: 'texra.testAgentLoading',
  loadSpecificAgent: 'texra.loadSpecificAgent',
  parseYaml: 'texra.parseYaml',
  testYamlBrackets: 'texra.testYamlBrackets',
};

export async function handleTestAgentLoading(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Initialize StorageFS with the context
    StorageFS.initialize(context);

    logger.info(CHANNEL, 'Testing YAML loading:');

    // Test basic YAML loading
    const testYaml = {
      settings: {
        agentType: AgentType.Direct,
        documentTag: 'test_doc',
        temperature: 0.7,
        prefills: ['test prefill'],
        outputExt: 'tex',
        endTag: '</test_doc>',
        requiredFiles: {},
        requiredFilesInternal: {},
        defaultOutputFiles: [],
        filePatternsContain: [],
      },
      prompts: {
        systemPrompt: 'Test system prompt',
        userPrefix: 'Test prefix',
        userRequest: ['Test request', 'Test reflect'],
      },
    };

    // Create a temporary test YAML file
    await GlobalStorageFS.createDir('test_agents');
    const testDir = GlobalStorageFS.fullPath('test_agents');

    // Create base agent
    const baseYamlPath = path.join(testDir, 'base.yaml');
    await GlobalStorageFS.writeJson('test_agents/base.yaml', testYaml);

    // Create child agent that inherits from base
    const childYaml = {
      inherits: 'base',
      settings: {
        documentTag: 'child_doc',
        temperature: 0.5,
      },
      prompts: {
        systemPrompt: 'Child system prompt',
      },
    };

    const childYamlPath = path.join(testDir, 'child.yaml');
    await GlobalStorageFS.writeJson('test_agents/child.yaml', childYaml);

    // Test loading base agent
    logger.info(CHANNEL, '\nTesting base agent loading:');
    const baseYaml = await loadYaml(baseYamlPath);
    logger.info(
      CHANNEL,
      `Base YAML loaded: ${JSON.stringify(baseYaml, null, 2)}`,
    );

    const testAgentPath = {
      directory: testDir,
      source: AgentDirectorySource.Custom,
    } as const;

    const [baseSettings, basePrompts] = await loadAgentSettingAndPrompts(
      testAgentPath,
      'base',
    );
    logger.info(CHANNEL, 'Base agent settings loaded:');
    logger.info(CHANNEL, JSON.stringify(baseSettings, null, 2));
    logger.info(CHANNEL, 'Base agent prompts loaded:');
    logger.info(CHANNEL, JSON.stringify(basePrompts, null, 2));

    // Test loading child agent with inheritance
    logger.info(CHANNEL, '\nTesting child agent loading with inheritance:');
    const childYamlContent = await loadYaml(childYamlPath);
    logger.info(
      CHANNEL,
      `Child YAML loaded: ${JSON.stringify(childYamlContent, null, 2)}`,
    );

    const [childSettings, childPrompts] = await loadAgentSettingAndPrompts(
      testAgentPath,
      'child',
    );
    logger.info(
      CHANNEL,
      'Child agent settings loaded (should inherit from base):',
    );
    logger.info(CHANNEL, JSON.stringify(childSettings, null, 2));
    logger.info(
      CHANNEL,
      'Child agent prompts loaded (should inherit from base):',
    );
    logger.info(CHANNEL, JSON.stringify(childPrompts, null, 2));

    // Cleanup test files
    await GlobalStorageFS.delete('test_agents/base.yaml');
    await GlobalStorageFS.delete('test_agents/child.yaml');
    await GlobalStorageFS.delete('test_agents', {
      recursive: true,
    });

    vscode.window.showInformationMessage(
      'Agent loading tests completed. Check Debug Console for results.',
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
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

    // Use getAgentPath to find the agent's directory
    const agentPath = await getAgentPath(agentName);
    logger.info(CHANNEL, `Loading from path: ${agentPath.directory}`);

    // Load and display the agent configuration
    const [settings, prompts] = await loadAgentSettingAndPrompts(
      agentPath,
      agentName,
    );

    // Display the results
    logger.info(CHANNEL, '\nAgent settings loaded:');
    logger.info(CHANNEL, JSON.stringify(settings, null, 2));
    logger.info(CHANNEL, '\nAgent prompts loaded:');
    logger.info(CHANNEL, JSON.stringify(prompts, null, 2));

    // If the agent inherits from another, show the inheritance chain
    const agentFile = path.join(agentPath.directory, `${agentName}.yaml`);
    const config = (await loadYaml(agentFile)) as { inherits?: string };
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
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(CHANNEL, `Failed to load agent: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      logger.debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`Failed to load agent: ${errorMessage}`);
  }
}

export async function handleParseYaml(
  context: vscode.ExtensionContext,
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
      logger.error(
        CHANNEL,
        `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage('Failed to parse YAML content');
      await showInstructionWithSuppress(
        'yamlParseFail',
        'The YAML file contains syntax errors. Please correct them and run the command again.',
        undefined,
        false,
      );
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in parseYaml command: ${err instanceof Error ? err.message : String(err)}`,
    );
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
    const errorMessage = err instanceof Error ? err.message : String(err);
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
