import { join } from 'node:path';

import { byString, byStringProp, normalizeFilePath } from '@utils/core';
import { isDirectory, isFile } from '@utils/files/fsEntryType';

import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
  type FileListConfig,
} from './fileListingRules';

export interface WorkspaceFileListingOptions {
  root: string;
  config: FileListConfig;
  readDirectory(path: string): Promise<[string, number][]>;
}

export async function listWorkspaceFiles(
  options: WorkspaceFileListingOptions,
): Promise<string[]> {
  const filters = prepareFileFilters(options.config);
  const results: string[] = [];

  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await options.readDirectory(directory);
    entries.sort(byStringProp(([name]) => name));

    for (const [name, type] of entries) {
      const relativePath = normalizeFilePath(
        relativeDirectory ? `${relativeDirectory}/${name}` : name,
      );
      const absolutePath = join(directory, name);

      if (isDirectory(type)) {
        if (shouldVisitDirectory(relativePath, filters)) {
          await visit(absolutePath, relativePath);
        }
        continue;
      }

      if (isFile(type) && passesFileFilters(relativePath, filters)) {
        results.push(relativePath);
      }
    }
  }

  await visit(options.root, '');
  return results.sort(byString);
}
