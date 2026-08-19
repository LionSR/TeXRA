/**
 * Single source of truth for the virtual resource paths the executions tool
 * serves. Both the tool `description` and its "Unknown path" error render from
 * this list, so the two cannot drift.
 */

const EXECUTION_PATH_CATALOG: ReadonlyArray<{ path: string; summary: string }> =
  [
    {
      path: '/executions',
      summary: 'List executions (paginated; use offset/limit for pages)',
    },
    {
      path: '/executions/{id}',
      summary:
        'Execution summary (agent, model, timestamp, status, children, todos)',
    },
    { path: '/executions/{id}/config', summary: 'Agent configuration JSON' },
    {
      path: '/executions/{id}/conversation',
      summary: 'Full message history (subagents)',
    },
    {
      path: '/executions/{id}/todos',
      summary: 'Task list (tool-use subagents)',
    },
    {
      path: '/executions/{id}/report',
      summary: 'Result report (persists after context compaction)',
    },
    {
      path: '/executions/{id}/result',
      summary:
        'Final result envelope (JSON) for chaining; process result for background commands',
    },
    {
      path: '/executions/{id}/output',
      summary:
        'stdout/stderr of a background command, readable WHILE IT RUNS (report/result only exist once it finishes)',
    },
    { path: '/executions/{id}/children', summary: 'Child executions' },
    {
      path: '/executions/{id}/files',
      summary: 'Generated files (workflows only)',
    },
    {
      path: '/executions/{id}/files/{path}',
      summary: 'Read specific generated file (workflows only)',
    },
    {
      path: '/executions/{id}/workspace-files',
      summary: 'Workspace files edited by tool-use runs',
    },
    {
      path: '/executions/{id}/workspace-files/{path}',
      summary: 'Read a workspace file edited by a tool-use run',
    },
  ];

/** The catalog as a bulleted `- <path> - <summary>` list. */
export const EXECUTION_PATH_LIST = EXECUTION_PATH_CATALOG.map(
  ({ path: resourcePath, summary }) => `- ${resourcePath} - ${summary}`,
).join('\n');
