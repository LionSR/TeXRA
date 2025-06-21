// Third-party imports
import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

// Local imports - utils
import { SecretManager } from '@frontend/secretManager';
import { getOrPromptForCustomAgentsDirectory } from '@frontend/agents/pathUtils';
import { promptToAddAgentToConfig } from '@frontend/agents/register';
import * as logger from '@logger/logUtils';
import { ANTHROPIC_MODELS } from '@model/providers/anthropicModels';

const CHANNEL = 'AgentCreator';
logger.initialize(CHANNEL);

export const agentCreatorCommands = {
  createAgentWithAI: 'texra.createAgentWithAI',
};

const SINGLE_TEMPLATE = `# --- Agent Inheritance (Optional) ---
# inherits: base

# --- Agent Settings ---
settings:
  agentType: CoT
  temperature: 0.1
  isRewrite: true
  documentTag: latex_document
  endTag: </latex_document>
  outputExt: tex
  prefills:
    - "<scratchpad>"
    - "<scratchpad>"

# --- Agent Prompts ---
prompts:
  systemPrompt: |
    [DESCRIPTION]

    You are operating inside **TeXRA**, a VS Code extension that orchestrates
    AI agents using YAML files. TeXRA loads selected documents and exposes them
    as variables, so prompts can reference data like {{ INPUT_CONTENT }} or
    {{ ALL_INPUTS }}. Agents follow a chain-of-thought workflow with
    <scratchpad> planning and a final output wrapped in the documentTag.

    Variable Retrieval (VR) exposes runtime data as variables in these prompts:
      - {{ INPUT_FILE }} / {{ INPUT_CONTENT }}: main file path and text
      - {{ ALL_INPUTS }}: XML list of all input files
      - {{ REFERENCE_CONTENT }} / {{ AUXILIARY_CONTENT }}: extra context
    Use them as needed.

    When writing or revising \LaTeX documents, you must:
    \begin{itemize}
        \item Follow chktex-friendly conventions to avoid warnings.
        \item Use appropriate notation and terminology consistently.
        \item Preserve comments that start with "%" in the document.
        \item Use \`\` or '' rather than straight quotes.
        \item Avoid markdown-style enumerations like 1., 2., 3. in the final output.
        \item \textbf{IMPORTANT:} Provide a complete output with sections in the original order.
        \item \textbf{IMPORTANT:} Use math commands defined in commands.tex or preamble.tex.
    \end{itemize}

  userPrefix: |
    Project context:
    <documents>
    {{ ALL_AUXILIARYS }}
    {{ ALL_REFERENCES }}
    {{ ADDITIONAL_INPUTS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </documents>

    {% if INSTRUCTION %}
    Instruction to follow:
    <instruction>
    {{ INSTRUCTION }}
    </instruction>
    {% endif %}

  userRequest: |
    Brainstorm your plan in <scratchpad> with bullet points.
    Then output the revised \LaTeX wrapped in <latex_document> tags.
`;

const MULTI_TEMPLATE = `# --- Agent Inheritance (Optional) ---
# inherits: base

# --- Agent Settings ---
settings:
  agentType: CoT
  temperature: 0.1
  isRewrite: true
  documentTag: latex_documents
  endTag: </latex_documents>
  defaultOutputFiles:
[OUTPUT_FILES]
  outputExt: tex
  prefills:
    - "<scratchpad>"
    - "<scratchpad>"

# --- Agent Prompts ---
prompts:
  systemPrompt: |
    [DESCRIPTION]

    You are operating inside **TeXRA**, a VS Code extension that orchestrates
    AI agents defined in YAML. TeXRA loads selected files and exposes them as
    variables, allowing prompts to reference {{ INPUT_CONTENT }},
    {{ ALL_INPUTS }}, or {{ OUTPUT_FILES_ORDER }}. Agents think in
    <scratchpad> before writing the final output inside the documentTag.

    Variable Retrieval (VR) exposes runtime data as variables in these prompts:
      - {{ INPUT_FILE }} / {{ INPUT_CONTENT }}: main file path and text
      - {{ ALL_INPUTS }}: XML list of all input files
      - {{ OUTPUT_FILES_ORDER }}: expected output files
      - {{ REFERENCE_CONTENT }} / {{ AUXILIARY_CONTENT }}: extra context
    Use them as needed.

    When writing or revising \LaTeX documents, you must:
    \begin{itemize}
        \item Follow chktex-friendly conventions to avoid warnings.
        \item Use appropriate notation and terminology consistently.
        \item Preserve comments that start with "%" in the document.
        \item Use \`\` or '' rather than straight quotes.
        \item Avoid markdown-style enumerations like 1., 2., 3. in the final output.
        \item \textbf{IMPORTANT:} Provide a complete output with sections in the original order.
        \item \textbf{IMPORTANT:} Use math commands defined in commands.tex or preamble.tex.
        \item Ensure the structure and formatting of each document is preserved.
    \end{itemize}

  userPrefix: |
    Project context:
    <documents>
    {{ ALL_AUXILIARYS }}
    {{ ALL_REFERENCES }}
    {{ ADDITIONAL_INPUTS }}
    <document name="{{ INPUT_FILE }}">
    {{ INPUT_CONTENT }}
    </document>
    </documents>

    {% if INSTRUCTION %}
    Instruction to follow:
    <instruction>
    {{ INSTRUCTION }}
    </instruction>
    {% endif %}

  userRequest: |
    Brainstorm your plan in <scratchpad> with bullet points.
    Then wrap each output in <latex_documents> with <document name="..."> blocks
    following the order in OUTPUT_FILES_ORDER.
`;

export function registerAgentCreatorCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      agentCreatorCommands.createAgentWithAI,
      () => handleCreateAgentWithAI(context),
    ),
  );
  return agentCreatorCommands;
}

async function handleCreateAgentWithAI(context: vscode.ExtensionContext) {
  try {
    const agentName = await vscode.window.showInputBox({
      prompt: 'Enter a name for the new agent (without .yaml)',
      validateInput: (value) =>
        !value || /[^a-zA-Z0-9_-]/.test(value)
          ? 'Use letters, numbers, underscore or dash'
          : null,
    });
    if (!agentName) {
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Briefly describe what this agent should do',
    });
    if (!description) {
      return;
    }

    const outputChoice = await vscode.window.showQuickPick(
      ['Single output file', 'Multiple output files'],
      { placeHolder: 'Choose the agent output style' },
    );
    if (!outputChoice) {
      return;
    }

    let outputFilesYaml = '';
    if (outputChoice === 'Multiple output files') {
      const filesInput = await vscode.window.showInputBox({
        prompt: 'Enter default output filenames (comma separated)',
      });
      if (!filesInput) {
        return;
      }
      const files = filesInput
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      outputFilesYaml = files.map((f) => `    - ${f}`).join('\n');
    }

    const targetDir = await getOrPromptForCustomAgentsDirectory();
    if (!targetDir) {
      return;
    }

    const filePath = vscode.Uri.file(`${targetDir}/${agentName}.yaml`);

    let yamlContent: string | undefined;
    try {
      const apiKey = await SecretManager.getApiKey('anthropic');
      const anthropic = new Anthropic({ apiKey });
      const prompt =
        `You are an expert on the TeXRA codebase, a VS Code extension that ` +
        `runs YAML-defined AI agents for academic writing.\n` +
        `Generate a complete YAML definition for an agent named "${agentName}" ` +
        `using the chain-of-thought style. Include prompts similar to the ` +
        `polish agent with explicit rules. Mention variables from buildUserVars ` +
        `(INPUT_CONTENT, ALL_INPUTS, OUTPUT_FILES_ORDER, REFERENCE_CONTENT, ` +
        `AUXILIARY_CONTENT, ADDITIONAL_INPUTS).\n` +
        `The user only provides a short description and the output filenames.\n` +
        `Goal: ${description}. Wrap the YAML in <yaml> tags and return nothing else.`;
      const params: MessageCreateParams = {
        model: ANTHROPIC_MODELS.opus4.fullName,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
      };
      const response = await anthropic.messages.create(params);
      if (
        response.content &&
        Array.isArray(response.content) &&
        response.content.length > 0 &&
        response.content[0] &&
        response.content[0].type === 'text'
      ) {
        const text = response.content[0].text.trim();
        const match = text.match(/<yaml>([\s\S]*?)<\/yaml>/i);
        yamlContent = match ? match[1].trim() : text;
      }
    } catch (err) {
      logger.error(
        CHANNEL,
        `AI generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!yamlContent) {
      const template =
        outputChoice === 'Multiple output files'
          ? MULTI_TEMPLATE.replace('[OUTPUT_FILES]', outputFilesYaml)
          : SINGLE_TEMPLATE;
      yamlContent = template.replace('[DESCRIPTION]', description);
    }

    await vscode.workspace.fs.writeFile(
      filePath,
      Buffer.from(yamlContent, 'utf-8'),
    );
    vscode.window.showInformationMessage(`Created agent at ${filePath.fsPath}`);
    await promptToAddAgentToConfig(agentName);
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error creating agent: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(
      `Failed to create agent: ${err instanceof Error ? err.message : 'Unknown error'}`,
    );
  }
}
