import * as vscode from 'vscode';
import { loadYaml, loadAgentSettingsAndPrompts } from '../../agent/agentLoad';
import * as path from 'path';
import * as logger from '../../logger/logUtils';
import { getConfig } from '../../frontend-utils/commonUtils';

const CHANNEL = 'AgentLoadingTests';
logger.initializeLogging(CHANNEL);

export async function handleTestAgentLoading(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    logger.info(CHANNEL, 'Testing YAML loading:');

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
    logger.info(CHANNEL, '\nTesting base agent loading:');
    const baseYaml = await loadYaml(baseYamlPath);
    logger.info(
      CHANNEL,
      `Base YAML loaded: ${JSON.stringify(baseYaml, null, 2)}`,
    );

    const [baseSettings, basePrompts] = await loadAgentSettingsAndPrompts(
      testDir,
      'base',
      context,
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

    const [childSettings, childPrompts] = await loadAgentSettingsAndPrompts(
      testDir,
      'child',
      context,
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
    logger.error(CHANNEL, `Agent loading test failed: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      logger.debug(CHANNEL, `Stack trace: ${err.stack}`);
    }
    vscode.window.showErrorMessage(
      `Agent loading test failed: ${errorMessage}`,
    );
  }
}

export async function handleTestLoadSpecificAgent(
  context: vscode.ExtensionContext,
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

    // Get the configured root path
    const rootPath = getConfig<string>('explorer.rootPath', 'agents');
    const agentPath = path.join(context.globalStorageUri.fsPath, rootPath);

    // Load and display the agent configuration
    logger.info(CHANNEL, `Loading from path: ${agentPath}`);

    const [settings, prompts] = await loadAgentSettingsAndPrompts(
      agentPath,
      agentName,
      context,
    );

    // Display the results
    logger.info(CHANNEL, '\nAgent settings loaded:');
    logger.info(CHANNEL, JSON.stringify(settings, null, 2));
    logger.info(CHANNEL, '\nAgent prompts loaded:');
    logger.info(CHANNEL, JSON.stringify(prompts, null, 2));

    // If the agent inherits from another, show the inheritance chain
    const agentFile = path.join(agentPath, `${agentName}.yaml`);
    const config = (await loadYaml(agentFile, context)) as any;
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
