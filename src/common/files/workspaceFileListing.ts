import { join } from 'node:path';

import { isDirectory, isFile } from '@common/files/fsEntryType';
import { normalizeFilePath } from '@shared/utils/path';

import {
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
  type FileListConfig,
} from './fileListingRules';

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: WorkspaceTreeNode[];
  categories?: string[];
}

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
    entries.sort(([left], [right]) => left.localeCompare(right));

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
  return results.sort((left, right) => left.localeCompare(right));
}

export function buildWorkspaceTree(
  files: readonly string[],
  categoriesByFile: ReadonlyMap<string, readonly string[]> = new Map(),
): WorkspaceTreeNode[] {
  const roots: WorkspaceTreeNode[] = [];

  function getOrCreateDirectory(
    siblings: WorkspaceTreeNode[],
    name: string,
    path: string,
  ): WorkspaceTreeNode {
    const existing = siblings.find(
      (node) => node.type === 'directory' && node.name === name,
    );
    if (existing) return existing;

    const created: WorkspaceTreeNode = {
      name,
      path,
      type: 'directory',
      children: [],
    };
    siblings.push(created);
    return created;
  }

  for (const file of [...new Set(files)].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const parts = normalizeFilePath(file).split('/').filter(Boolean);
    let siblings = roots;
    let currentPath = '';

    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLeaf = index === parts.length - 1;
      if (isLeaf) {
        siblings.push({
          name: part,
          path: currentPath,
          type: 'file',
          categories: [...(categoriesByFile.get(file) ?? [])],
        });
        return;
      }

      const directory = getOrCreateDirectory(siblings, part, currentPath);
      siblings = directory.children ?? [];
    });
  }

  sortWorkspaceTree(roots);
  return roots;
}

function sortWorkspaceTree(nodes: WorkspaceTreeNode[]): void {
  nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const node of nodes) {
    if (node.children) sortWorkspaceTree(node.children);
  }
}
