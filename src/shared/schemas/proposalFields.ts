// Third-party imports
import { z } from 'zod';

/**
 * Base proposal fields shared by both workflow and tool-use agent proposals.
 * Contains only the common fields that all proposal types need.
 */
export const BaseProposalFieldsSchema = z.object({
  agent: z.string().describe('Name of the agent to execute'),
  model: z.string().describe('Model to use for agent execution'),
  instruction: z.string().describe('Instruction for the agent'),
});

/**
 * File path fields for workflow agents only.
 * Tool-use agents access files through their own tools instead.
 */
const FileFieldsSchema = z.object({
  inputFile: z.string().describe('Path to the primary input file'),
  inputFiles: z.array(z.string()).describe('Additional input file paths'),
  referenceFile: z
    .string()
    .nullable()
    .describe('Reference file path for additional context'),
  referenceFiles: z
    .array(z.string())
    .describe('Additional reference file paths'),
  auxiliaryFile: z
    .string()
    .nullable()
    .describe('Auxiliary file path for supplementary content'),
  auxiliaryFiles: z
    .array(z.string())
    .describe('Additional auxiliary file paths'),
  mediaFile: z
    .string()
    .nullable()
    .describe('Media file path for images/figures'),
  mediaFiles: z.array(z.string()).describe('Additional media file paths'),
  outputFiles: z.array(z.string()).describe('Desired output file paths'),
});

/**
 * Workflow-specific fields: file fields + multiple outputs flag.
 * Only workflow agents (document processing) use these fields.
 */
export const WorkflowSpecificFieldsSchema = FileFieldsSchema.extend({
  useMultipleOutputs: z
    .boolean()
    .describe('Enable multiple outputs mode for agents that support it'),
});
