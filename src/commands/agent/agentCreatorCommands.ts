// Third-party imports
import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';

// Local imports - agent runtime
import { getBaseName, getMultipleName } from '@agent/index';
import { validateAgentYamlContent } from '@agent/runtime/agentLoad';
import { toErrorMessage } from '@common/errors';
import { SecretManager } from '@frontend/secretManager';
import { agentDirectories } from '@frontend/agents';
import { promptToAddAgentToConfig } from '@frontend/agents';
import * as logger from '@logger/logUtils';
import { ANTHROPIC_MODELS } from '@model/ModelRegistry';
import { AbsoluteFS } from '@utils/files';

// Type imports
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';

const CHANNEL = 'AgentCreator';
logger.initialize(CHANNEL);

export const agentCreatorCommands = {
  createAgentWithAI: 'texra.createAgentWithAI',
};

const SINGLE_TEMPLATE = `# --- Agent Inheritance (Optional) ---
# inherits: base
name: \${agentName}

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

  userRequest:
    - |
        Brainstorm your plan in <scratchpad> with bullet points.
        Then output the revised \LaTeX wrapped in <latex_document> tags.
    - |
        Reflect on your previous revision and describe the most impactful follow-up edits in <scratchpad> before producing the updated <latex_document> output.
`;

const MULTI_TEMPLATE = `# --- Agent Inheritance (Optional) ---
# inherits: base
name: \${agentName}

# --- Agent Settings ---
settings:
  agentType: CoT
  isMultipleOutput: true
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

  userRequest:
    - |
        Brainstorm your plan in <scratchpad> with bullet points.
        Then wrap each output in <latex_documents> with <document name="..."> blocks
        following the order in OUTPUT_FILES_ORDER.
    - |
        Review the draft outputs and note targeted refinements for each document in <scratchpad>. Apply the improvements and emit the updated <latex_documents> content in the same order.
`;

function validateAgentYamlString(content: string): string | null {
  try {
    validateAgentYamlContent(content);
    return null;
  } catch (err) {
    return toErrorMessage(err);
  }
}

export function registerAgentCreatorCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      agentCreatorCommands.createAgentWithAI,
      () => handleCreateAgentWithAI(context),
    ),
  );
  return agentCreatorCommands;
}

async function handleCreateAgentWithAI(_context: vscode.ExtensionContext) {
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

    const targetDir = await agentDirectories.custom();

    const filePath = vscode.Uri.file(`${targetDir}/${agentName}.yaml`);

    let yamlContent: string | undefined;
    try {
      const apiKey = await SecretManager.getApiKey('anthropic');
      const anthropic = new Anthropic({ apiKey });

      const basePrompt =
        `You are an expert on the TeXRA codebase, a VS Code extension that runs YAML-defined AI agents.\n` +
        `Generate a YAML definition for an agent named "${agentName}". The YAML must follow this layout:` +
        `\nname: ${agentName}\n# inherits: base\nsettings:\n  ...\nprompts:\n  systemPrompt: |\n    ...\n  userPrefix: |\n    ...\n  userRequest:\n    - |\n      ...\n    - |\n      [Optional reflection prompt]\n` +
        `For reference, built-in agents start like:\nname: polish\nsettings:\n  documentTag: latex_document\n  endTag: </latex_document>\n  outputExt: tex\n` +
        `Mention variables INPUT_CONTENT, ALL_INPUTS, OUTPUT_FILES_ORDER, REFERENCE_CONTENT, AUXILIARY_CONTENT and ADDITIONAL_INPUTS when relevant.\n` +
        `Goal: ${description}. Respond only with the YAML wrapped in <yaml> tags.`;

      let prompt = basePrompt;
      for (let attempt = 0; attempt < 2; attempt++) {
        const params: MessageCreateParams = {
          model: ANTHROPIC_MODELS.opus41.fullName,
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
          const candidate = match ? match[1].trim() : text;
          const validationErr = validateAgentYamlString(candidate);
          if (!validationErr) {
            yamlContent = candidate;
            break;
          }

          const options =
            attempt === 0
              ? (['Try Again', 'Use Template'] as const)
              : (['Use Template'] as const);
          const choice = await vscode.window.showWarningMessage(
            `Generated YAML was invalid: ${validationErr}`,
            ...options,
          );
          if (choice === 'Try Again' && attempt === 0) {
            prompt =
              basePrompt +
              `\nThe previous attempt failed validation: ${validationErr}. Please fix and return only the YAML.`;
            continue;
          }
          break;
        }
      }
    } catch (err) {
      logger.error(CHANNEL, `AI generation failed: ${toErrorMessage(err)}`);
    }

    if (!yamlContent) {
      const template =
        outputChoice === 'Multiple output files'
          ? MULTI_TEMPLATE.replace('[OUTPUT_FILES]', outputFilesYaml)
          : SINGLE_TEMPLATE;
      yamlContent = template
        .replace('[DESCRIPTION]', description)
        .replace('${agentName}', agentName);
    }

    await AbsoluteFS.write(filePath.fsPath, yamlContent);
    vscode.window.showInformationMessage(`Created agent at ${filePath.fsPath}`);
    const isMultipleOutput = outputChoice === 'Multiple output files';
    await promptToAddAgentToConfig(agentName, false, {
      isMultipleOutput,
      baseAgentName: isMultipleOutput ? getBaseName(agentName) : undefined,
      multipleAgentName: isMultipleOutput
        ? agentName
        : getMultipleName(agentName),
    });
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    logger.error(CHANNEL, `Error creating agent: ${toErrorMessage(err)}`);
    vscode.window.showErrorMessage(
      `Failed to create agent: ${toErrorMessage(err)}`,
    );
  }
}
