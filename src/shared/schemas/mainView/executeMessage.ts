import { z } from 'zod';

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

import { AgentCategorySchema } from '../agent';
import { ToolConfigInputFieldsSchema } from '../toolConfig';
import { LaunchTargetSchema } from './state';

export const MainViewExecuteFilesSchema = z.object({
  inputFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string().nullable()).optional(),
  outputFiles: z.array(z.string()).optional(),
  editedFile: z.string().optional(),
  editedFiles: z.array(z.string()).optional(),
  baseFile: z.string().optional(),
});

/**
 * Payload from the main view for agent execution. The IPC dispatcher adds the
 * command discriminant separately; keeping the payload schema command-free
 * matches the browser-side builder and the execution controller.
 */
export const MainViewExecuteMessageSchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  displayInstruction: z.string().nullish(),
  agentCategory: AgentCategorySchema.optional(),
  memories: z.array(z.string()).optional(),
  files: MainViewExecuteFilesSchema.optional(),
  session: z
    .object({
      workingDirectory: z.string().nullish(),
      cliOutputFile: z.string().nullish(),
      cliMultiAgentPresetId: z.string().nullish(),
      // Team runs send team identity only; hosts resolve the roster at the
      // execution boundary where catalog/auth state is authoritative.
      launchTarget: LaunchTargetSchema.nullish(),
      teamId: z.string().nullish(),
    })
    .optional(),
  toolConfig: ToolConfigInputFieldsSchema.partial().optional(),
});
export type MainViewExecuteMessage = z.infer<
  typeof MainViewExecuteMessageSchema
>;

export const MainViewExecuteInboundMessageSchema =
  MainViewExecuteMessageSchema.extend({
    command: z.literal(MAIN_VIEW_COMMANDS.EXECUTE),
  });
