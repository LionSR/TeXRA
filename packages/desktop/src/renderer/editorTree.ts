export interface EditorFileEntry {
  /** Workspace-relative path used as the editor's file-system key. */
  readonly path: string;
  readonly isDirectory: boolean;
}

interface EditorTreeFile {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
}

export interface EditorTreeDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly children: readonly EditorTreeNode[];
}

export type EditorTreeNode = EditorTreeDirectory | EditorTreeFile;

export interface EditorTree {
  readonly nodes: readonly EditorTreeNode[];
  readonly directoryPaths: ReadonlySet<string>;
}

interface MutableEditorTreeDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, MutableEditorTreeNode>;
}

interface MutableEditorTreeFile {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
}

type MutableEditorTreeNode = MutableEditorTreeDirectory | MutableEditorTreeFile;

function compareTreeNodes(
  left: MutableEditorTreeNode,
  right: MutableEditorTreeNode,
): number {
  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function freezeNodes(
  nodes: Iterable<MutableEditorTreeNode>,
): readonly EditorTreeNode[] {
  return [...nodes].toSorted(compareTreeNodes).map((node) => {
    if (node.kind === 'file') return node;
    return {
      kind: node.kind,
      name: node.name,
      path: node.path,
      children: freezeNodes(node.children.values()),
    };
  });
}

/**
 * Converts the workspace's flat file listing into the canonical editor tree.
 *
 * The listing normally contains files only, so parent folders are inferred
 * here once at the data boundary. Renderers receive named nodes and never need
 * to split or deduplicate paths.
 */
export function buildEditorTree(
  entries: readonly EditorFileEntry[],
): EditorTree {
  const root = new Map<string, MutableEditorTreeNode>();
  const directoryPaths = new Set<string>();

  for (const entry of entries) {
    const segments = entry.path
      .replaceAll('\\', '/')
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.');
    if (segments.length === 0) continue;

    let siblings = root;
    for (const [index, name] of segments.entries()) {
      const lastSegment = index === segments.length - 1;
      const isDirectory = !lastSegment || entry.isDirectory;
      const path = segments.slice(0, index + 1).join('/');
      const existing = siblings.get(name);

      if (isDirectory) {
        directoryPaths.add(path);
        if (existing?.kind === 'directory') {
          siblings = existing.children;
          continue;
        }

        const directory: MutableEditorTreeDirectory = {
          kind: 'directory',
          name,
          path,
          children: new Map(),
        };
        siblings.set(name, directory);
        siblings = directory.children;
        continue;
      }

      siblings.set(name, {
        kind: 'file',
        name,
        // Keep the original path as the IPC key. Only directory paths need a
        // canonical separator because they never cross the filesystem boundary.
        path: entry.path,
      });
    }
  }

  return {
    nodes: freezeNodes(root.values()),
    directoryPaths,
  };
}
