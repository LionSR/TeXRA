/**
 * Nunjucks templates for followup instruction generation.
 * These templates are rendered with context variables from the original workflow.
 */

/**
 * Template for chat mode instruction.
 * Includes full workflow context and user's question.
 */
export const CHAT_INSTRUCTION_TEMPLATE = `Previous Workflow Context:
- Agent: {{ agentInfo }}
{% if model %}- Model: {{ model }}{% endif %}
{% if instruction %}- Instruction: "{{ instruction }}"{% endif %}

Files:
{% if inputFiles %}- Input files: {{ inputFiles }}{% endif %}
{% if referenceFiles %}- Reference files: {{ referenceFiles }}{% endif %}
{% if auxiliaryFiles %}- Auxiliary files: {{ auxiliaryFiles }}{% endif %}
{% if mediaFiles %}- Media files: {{ mediaFiles }}{% endif %}
{% if outputFiles %}- Generated outputs: {{ outputFiles }}{% endif %}

Question:
{{ question }}`;

/**
 * Template for workflow mode context.
 * Similar to chat but without the question section.
 */
export const WORKFLOW_CONTEXT_TEMPLATE = `Previous Workflow Context:
- Agent: {{ agentInfo }}
{% if model %}- Model: {{ model }}{% endif %}

Files:
{% if inputFiles %}- Input files: {{ inputFiles }}{% endif %}
{% if referenceFiles %}- Reference files: {{ referenceFiles }}{% endif %}
{% if auxiliaryFiles %}- Auxiliary files: {{ auxiliaryFiles }}{% endif %}
{% if mediaFiles %}- Media files: {{ mediaFiles }}{% endif %}
{% if outputFiles %}- Generated outputs: {{ outputFiles }}{% endif %}`;

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
