/**
 * Nunjucks templates for followup instruction generation.
 * These templates are rendered with context variables from the original workflow.
 */

/**
 * Shared template for workflow context.
 * Chat mode includes instruction in context and adds question section.
 * Workflow mode excludes instruction (appended separately if needed).
 */
const WORKFLOW_CONTEXT_BASE = `Previous Workflow Context:
- Agent: {{ agentInfo }}
{% if model %}- Model: {{ model }}{% endif %}`;

const FILES_SECTION = `
Files:
{% if inputFiles %}- Input files: {{ inputFiles }}{% endif %}
{% if referenceFiles %}- Reference files: {{ referenceFiles }}{% endif %}
{% if auxiliaryFiles %}- Auxiliary files: {{ auxiliaryFiles }}{% endif %}
{% if mediaFiles %}- Media files: {{ mediaFiles }}{% endif %}
{% if outputFiles %}- Generated outputs: {{ outputFiles }}{% endif %}`;

/**
 * Template for chat mode instruction.
 * Includes instruction in context and user's question.
 */
export const CHAT_INSTRUCTION_TEMPLATE =
  WORKFLOW_CONTEXT_BASE +
  `
{% if instruction %}- Instruction: "{{ instruction }}"{% endif %}` +
  FILES_SECTION +
  `

Question:
{{ question }}`;

const PREAMBLE_NOTE = `

Note: LaTeX preamble (documentclass, packages, macros) is typically extracted separately and does not need to be included in output files.`;

/**
 * Template for workflow mode context.
 * Excludes instruction (may be appended separately).
 */
export const WORKFLOW_CONTEXT_TEMPLATE =
  WORKFLOW_CONTEXT_BASE + FILES_SECTION + PREAMBLE_NOTE;

/**
 * Variables for rendering followup instruction templates.
 */
export interface FollowupInstructionVars {
  [key: string]: string | undefined;
  agentInfo: string;
  model?: string;
  instruction?: string;
  inputFiles?: string;
  referenceFiles?: string;
  auxiliaryFiles?: string;
  mediaFiles?: string;
  outputFiles?: string;
  question?: string;
}
