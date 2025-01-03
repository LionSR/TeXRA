import * as vscode from 'vscode';
import {
  bestConnectionMethod,
  bestConnectionMethodAnthropic,
} from '../latex/textConnection';
import { info, debug, error, initializeLogging } from '../logger/logUtils';
import { loadYaml, loadAgentSettingsAndPrompts } from '../agent/agentLoad';
import * as path from 'path';
import { getConfig } from '../frontend-utils/commonUtils';

const CHANNEL = 'TestCommands';
initializeLogging(CHANNEL);

export function registerTestCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.testConnection',
      handleTestConnection,
    ),
    vscode.commands.registerCommand('coauthor.testAgentLoading', () =>
      handleTestAgentLoading(context),
    ),
    vscode.commands.registerCommand('coauthor.testLoadSpecificAgent', () =>
      handleTestLoadSpecificAgent(context),
    ),
  );
  debug(CHANNEL, 'Test commands registered');
}

async function handleTestConnection(): Promise<void> {
  try {
    // Test cases
    const testCases = [
      { str1: 'Hello', str2: 'world' },
      { str1: 'The cat', str2: 'sat on the mat' },
      { str1: 'Therefore,', str2: 'we conclude' },
      { str1: '\\section{Introduction}', str2: 'This paper presents' },
    ];

    info(CHANNEL, 'Testing OpenAI implementation:');
    for (const { str1, str2 } of testCases) {
      debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethod(str1, str2);
      info(CHANNEL, `Result: ${JSON.stringify(result)}`);
      info(CHANNEL, `Connected text: "${str1}${result.connector}${str2}"`);
    }

    info(CHANNEL, '\n-------------------\n');

    info(CHANNEL, 'Testing Anthropic implementation:');
    for (const { str1, str2 } of testCases) {
      debug(CHANNEL, `\nTesting: "${str1}" + "${str2}"`);
      const result = await bestConnectionMethodAnthropic(str1, str2);
      info(CHANNEL, `Result: ${JSON.stringify(result)}`);
      info(CHANNEL, `Connected text: "${str1}${result.connector}${str2}"`);
    }

    vscode.window.showInformationMessage(
      'Check Debug Console for test results',
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(CHANNEL, `Test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`Test failed: ${errorMessage}`);
  }
}

async function handleTestAgentLoading(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    info(CHANNEL, 'Testing YAML loading:');

    // Test basic YAML loading
    const testYaml = {
      settings: {
        agentType: 'direct',
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
        userRequest: 'Test request',
        userReflect: 'Test reflect',
      },
    };

    // Create a temporary test YAML file
    const testDir = path.join(context.globalStorageUri.fsPath, 'test_agents');
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(testDir));

    // Create base agent
    const baseYamlPath = path.join(testDir, 'base.yaml');
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(baseYamlPath),
      Buffer.from(JSON.stringify(testYaml)),
    );

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
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(childYamlPath),
      Buffer.from(JSON.stringify(childYaml)),
    );

    // Test loading base agent
    info(CHANNEL, '\nTesting base agent loading:');
    const baseYaml = await loadYaml(baseYamlPath);
    info(CHANNEL, `Base YAML loaded: ${JSON.stringify(baseYaml, null, 2)}`);

    const [baseSettings, basePrompts] = await loadAgentSettingsAndPrompts(
      testDir,
      'base',
      context,
    );
    info(CHANNEL, 'Base agent settings loaded:');
    info(CHANNEL, JSON.stringify(baseSettings, null, 2));
    info(CHANNEL, 'Base agent prompts loaded:');
    info(CHANNEL, JSON.stringify(basePrompts, null, 2));

    // Test loading child agent with inheritance
    info(CHANNEL, '\nTesting child agent loading with inheritance:');
    const childYamlContent = await loadYaml(childYamlPath);
    info(
      CHANNEL,
      `Child YAML loaded: ${JSON.stringify(childYamlContent, null, 2)}`,
    );

    const [childSettings, childPrompts] = await loadAgentSettingsAndPrompts(
      testDir,
      'child',
      context,
    );
    info(CHANNEL, 'Child agent settings loaded (should inherit from base):');
    info(CHANNEL, JSON.stringify(childSettings, null, 2));
    info(CHANNEL, 'Child agent prompts loaded (should inherit from base):');
    info(CHANNEL, JSON.stringify(childPrompts, null, 2));

    // Cleanup test files
    await vscode.workspace.fs.delete(vscode.Uri.file(baseYamlPath));
    await vscode.workspace.fs.delete(vscode.Uri.file(childYamlPath));
    await vscode.workspace.fs.delete(vscode.Uri.file(testDir), {
      recursive: true,
    });

    vscode.window.showInformationMessage(
      'Agent loading tests completed. Check Debug Console for results.',
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(CHANNEL, `Agent loading test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(
      `Agent loading test failed: ${errorMessage}`,
    );
  }
}

async function handleTestLoadSpecificAgent(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Get agent name from user
    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter the agent name to load (e.g., "polish", "corect")',
      placeHolder: 'agent_name',
    });

    if (!agentName) {
      debug(CHANNEL, 'No agent name provided, cancelling test');
      return;
    }

    info(CHANNEL, `Testing loading of agent: ${agentName}`);

    // Get the configured root path
    const rootPath = getConfig<string>('explorer.rootPath', 'agents');
    const agentPath = path.join(context.globalStorageUri.fsPath, rootPath);

    // Load and display the agent configuration
    info(CHANNEL, `Loading from path: ${agentPath}`);

    const [settings, prompts] = await loadAgentSettingsAndPrompts(
      agentPath,
      agentName,
      context,
    );

    // Display the results
    info(CHANNEL, '\nAgent settings loaded:');
    info(CHANNEL, JSON.stringify(settings, null, 2));
    info(CHANNEL, '\nAgent prompts loaded:');
    info(CHANNEL, JSON.stringify(prompts, null, 2));

    // If the agent inherits from another, show the inheritance chain
    const agentFile = path.join(agentPath, `${agentName}.yaml`);
    const config = (await loadYaml(agentFile, context)) as any;
    if (config?.inherits) {
      info(CHANNEL, `\nInheritance chain: ${agentName} -> ${config.inherits}`);
    }

    vscode.window.showInformationMessage(
      `Successfully loaded agent "${agentName}". Check Debug Console for details.`,
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(CHANNEL, `Failed to load agent: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(`Failed to load agent: ${errorMessage}`);
  }
}

export const testCommands = {
  handleTestConnection,
  handleTestAgentLoading,
  handleTestLoadSpecificAgent,
};
