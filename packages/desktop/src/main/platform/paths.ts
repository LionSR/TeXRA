import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { app } from 'electron';

export function resolveWorkspacePath(): string | undefined {
  const configured = process.env.TEXRA_WORKSPACE_PATH?.trim();
  return configured ? resolve(configured) : undefined;
}

export function resolveResourcesPath(mainDirname: string): string {
  const configured = process.env.TEXRA_RESOURCES_PATH?.trim();
  const candidates = [
    configured,
    join(app.getAppPath(), 'resources'),
    join(process.resourcesPath, 'resources'),
    join(mainDirname, '../../../../resources'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Unable to locate TeXRA resources. Checked: ${candidates.join(', ')}`,
    );
  }
  return found;
}
