import { z } from 'zod';

import { WorkspaceTreeNodeSchema } from './workspaceTreeSchema.js';

export const DESKTOP_WORKSPACE_EXPLORER_COMMANDS = {
  REQUEST_TREE: 'desktop:requestWorkspaceTree',
  SET_TREE: 'desktop:setWorkspaceTree',
  OPEN_FILE: 'desktop:openWorkspaceFile',
  SELECT_FILE: 'desktop:selectWorkspaceFile',
} as const;

export const DesktopWorkspaceFileCategorySchema = z.enum([
  'input',
  'reference',
  'auxiliary',
  'media',
]);
export type DesktopWorkspaceFileCategory = z.infer<
  typeof DesktopWorkspaceFileCategorySchema
>;

export const DesktopWorkspaceTreeMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.SET_TREE),
  workspaceName: z.string().nullish(),
  files: z.array(z.string()),
  tree: z.array(WorkspaceTreeNodeSchema),
});

export const DesktopWorkspaceOpenFileMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.OPEN_FILE),
  filePath: z.string().min(1),
});

export const DesktopWorkspaceSelectFileMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_EXPLORER_COMMANDS.SELECT_FILE),
  filePath: z.string().min(1),
  fileType: DesktopWorkspaceFileCategorySchema,
});

export type DesktopWorkspaceTreeMessage = z.infer<
  typeof DesktopWorkspaceTreeMessageSchema
>;
export type DesktopWorkspaceOpenFileMessage = z.infer<
  typeof DesktopWorkspaceOpenFileMessageSchema
>;
export type DesktopWorkspaceSelectFileMessage = z.infer<
  typeof DesktopWorkspaceSelectFileMessageSchema
>;
