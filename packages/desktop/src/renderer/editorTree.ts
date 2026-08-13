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

interface MutableEditorTreeDirectory {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, MutableEditorTreeNode>;
}

// File nodes are never mutated between the mutable build-tree and the frozen
// result, so the frozen EditorTreeFile serves both roles.
type MutableEditorTreeNode = MutableEditorTreeDirectory | EditorTreeFile;
type NamedTreeNode = Pick<EditorTreeNode, 'kind' | 'name'>;

/**
 * Split a workspace-relative path into its directory/file segments, normalizing
 * separators and dropping empty and `.` segments, so `./a/b`, `a//b`, `a/b/`,
 * and `a\b` all parse to `['a', 'b']`. The single path-normalization rule both
 * tree builders use.
 */
function workspacePathSegments(path: string): string[] {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
}

function compareTreeNodes(left: NamedTreeNode, right: NamedTreeNode): number {
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
 * Converts a flat recursive listing into a nested tree.
 *
 * Review surfaces receive an already-complete changed-file list, so they keep
 * this full-tree representation. The workspace explorer uses
 * {@link buildEditorDirectoryEntries} instead and never calls this recursively.
 */
export function buildEditorTree(
  entries: readonly EditorFileEntry[],
): readonly EditorTreeNode[] {
  const root = new Map<string, MutableEditorTreeNode>();

  for (const entry of entries) {
    const segments = workspacePathSegments(entry.path);
    if (segments.length === 0) continue;

    let siblings = root;
    for (const [index, name] of segments.entries()) {
      const lastSegment = index === segments.length - 1;
      const isDirectoryEntry = !lastSegment || entry.isDirectory;
      const path = segments.slice(0, index + 1).join('/');
      const existing = siblings.get(name);

      if (isDirectoryEntry) {
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
        path: entry.path,
      });
    }
  }

  return freezeNodes(root.values());
}

/**
 * Converts one direct directory listing into sorted tree rows.
 *
 * The main process returns direct children only. Keeping this boundary flat is
 * what lets the renderer request each directory lazily instead of crawling the
 * entire workspace before showing the first row.
 */
export function buildEditorDirectoryEntries(
  entries: readonly EditorFileEntry[],
): readonly EditorTreeNode[] {
  const nodes: EditorTreeNode[] = [];

  for (const entry of entries) {
    // The stored path is the normalized segments re-joined, so a node keys
    // identically however its entry arrived ('./dir/name', 'dir//name',
    // 'dir\name'). buildEditorTree's file nodes store the raw entry path
    // instead, because reviewPane keys them by the un-normalized displayPath.
    const segments = workspacePathSegments(entry.path);
    const name = segments.at(-1);
    if (!name) continue;
    const normalizedPath = segments.join('/');
    if (entry.isDirectory) {
      nodes.push({
        kind: 'directory',
        name,
        path: normalizedPath,
        children: [],
      });
    } else {
      nodes.push({ kind: 'file', name, path: normalizedPath });
    }
  }

  return nodes.toSorted(compareTreeNodes);
}
