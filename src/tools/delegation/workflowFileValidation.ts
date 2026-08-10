import { WorkspaceFS } from '@utils/files/workspaceFS';
import { isNonEmptyString } from '@utils/text/stringUtils';

export interface WorkflowFileGroup {
  readonly label: string;
  readonly files: readonly string[];
}

/** Validate workspace-backed workflow inputs before launching a child run. */
export async function assertWorkflowFilesExist(
  groups: readonly WorkflowFileGroup[],
): Promise<void> {
  const entries = groups.flatMap(({ label, files }) =>
    files.filter(isNonEmptyString).map((path) => ({ label, path })),
  );
  const inspected = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      exists: await WorkspaceFS.exists(entry.path),
    })),
  );
  const missing = inspected.find((entry) => !entry.exists);
  if (missing) {
    throw new Error(`${missing.label} not found: ${missing.path}`);
  }
}
