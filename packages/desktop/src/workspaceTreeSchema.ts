import { z } from 'zod';

import type { WorkspaceTreeNode } from '@common/files/workspaceFileListing';

export const WorkspaceTreeNodeSchema: z.ZodType<WorkspaceTreeNode> = z.lazy(
  () =>
    z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(['directory', 'file']),
      children: z.array(WorkspaceTreeNodeSchema).optional(),
      categories: z.array(z.string()).optional(),
    }),
);
