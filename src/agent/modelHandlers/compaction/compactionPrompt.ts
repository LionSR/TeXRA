/**
 * Compaction prompt for client-side context summarization.
 * Based on the Anthropic SDK's DEFAULT_SUMMARY_PROMPT from _beta_compaction_control.py.
 *
 * This prompt is designed to create actionable summaries that allow the model
 * (or another instance) to resume work efficiently in a new context window.
 */

/**
 * Default summary prompt used when context compaction is triggered.
 * The model generates a structured summary wrapped in <summary></summary> tags.
 */
export const DEFAULT_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it.
Write a continuation summary that will allow you (or another instance of yourself)
to resume work efficiently in a future context window where the conversation
history will be replaced with this summary. Your summary should be structured,
concise, and actionable. Include:

1. Task Overview
   The user's core request and success criteria
   Any clarifications or constraints they specified

2. Current State
   What has been completed so far
   Files created, modified, or analyzed (with paths if relevant)
   Key outputs or artifacts produced

3. Important Discoveries
   Technical constraints or requirements uncovered
   Decisions made and their rationale
   Errors encountered and how they were resolved
   What approaches were tried that didn't work (and why)

4. Next Steps
   Specific actions needed to complete the task
   Any blockers or open questions to resolve
   Priority order if multiple steps remain

5. Context to Preserve
   User preferences or style requirements
   Domain-specific details that aren't obvious
   Any promises made to the user

Be concise but complete—err on the side of including information that would
prevent duplicate work or repeated mistakes. Write in a way that enables
immediate resumption of the task.

Wrap your summary in <summary></summary> tags.`;

/**
 * XML tag used to wrap the compaction summary in the model's response.
 */
export const SUMMARY_TAG = 'summary';

/**
 * XML tag used to wrap the summary when inserted as a user message.
 * This makes it clear to the model that this is a conversation context summary.
 */
export const CONVERSATION_SUMMARY_TAG = 'conversation-summary';
