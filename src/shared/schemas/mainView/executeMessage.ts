import { z } from 'zod';

import { AgentCategorySchema } from '../agent';
import { ToolConfigInputFieldsSchema } from '../toolConfig';
import { LaunchTargetSchema } from './state';

const MainViewExecuteFilesSchema = z.object({
  inputFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string().nullable()).optional(),
});

/**
 * Payload from the main view for agent execution. The IPC dispatcher adds the
 * command discriminant separately; keeping the payload schema command-free
 * matches the browser-side builder and the execution controller.
 */
const MainViewExecuteMessageSchema = z.object({
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
      cli: z
        .object({
          outputFile: z.string().nullish(),
          multiAgentPresetId: z.string().nullish(),
        })
        .nullish(),
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
