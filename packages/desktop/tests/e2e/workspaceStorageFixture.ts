import { realpathSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Remove a temporary E2E directory without hiding the primary assertion. */
export function cleanupDirectory(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not hide the assertion that failed.
  }
}

function tryReadWorkspaceSidecar(path: string): string | undefined {
  try {
    const sidecar = JSON.parse(readFileSync(path, 'utf8')) as {
      path?: unknown;
    };
    return typeof sidecar.path === 'string' ? resolve(sidecar.path) : undefined;
  } catch {
    return undefined;
  }
}

/** Locate the internal storage bucket assigned to a canonical workspace path. */
export function findWorkspaceStoragePath(input: {
  userDataPath: string;
  workspacePath: string;
}): string {
  const targetWorkspacePath = realpathSync(input.workspacePath);

  for (const storageRoot of readdirSync(input.userDataPath, {
    withFileTypes: true,
  })) {
    if (!storageRoot.isDirectory()) continue;

    const storageRootPath = join(input.userDataPath, storageRoot.name);
    for (const candidate of readdirSync(storageRootPath, {
      withFileTypes: true,
    })) {
      if (!candidate.isDirectory()) continue;

      const candidatePath = join(storageRootPath, candidate.name);
      if (
        tryReadWorkspaceSidecar(join(candidatePath, '_workspace.json')) ===
        targetWorkspacePath
      ) {
        return candidatePath;
      }
    }
  }

  throw new Error(
    `No TeXRA workspace storage directory found for ${targetWorkspacePath}`,
  );
}
