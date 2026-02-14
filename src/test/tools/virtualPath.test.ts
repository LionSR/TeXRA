// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { ToolError } from '@tools/result';
import { StorageFS } from '@utils/files';
import {
  tryResolveVirtualPath,
  translateOutputLine,
  type VirtualNamespace,
} from '@tools/virtualPath';

// Stub StorageFS.fullPath to return a predictable absolute path
// without requiring VS Code extension context initialization.
const FAKE_STORAGE_BASE = '/fake/storage';
const originalFullPath = StorageFS.fullPath;

beforeEach(() => {
  (StorageFS as unknown as Record<string, unknown>).fullPath = (target: string) =>
    `${FAKE_STORAGE_BASE}/${target}`;
});

afterEach(() => {
  (StorageFS as unknown as Record<string, unknown>).fullPath = originalFullPath;
});

// ============================================================================
// tryResolveVirtualPath
// ============================================================================

describe('tryResolveVirtualPath', () => {
  // --- Namespace matching ---

  it('returns null for non-virtual paths', () => {
    assert.equal(tryResolveVirtualPath('src/main.ts'), null);
    assert.equal(tryResolveVirtualPath('/usr/local/bin'), null);
    assert.equal(tryResolveVirtualPath('.'), null);
    assert.equal(tryResolveVirtualPath(''), null);
  });

  it('resolves /memories root', () => {
    const result = tryResolveVirtualPath('/memories');
    assert.ok(result);
    assert.equal(result.absolutePath, `${FAKE_STORAGE_BASE}/memories`);
    assert.equal(result.namespace.display, '/memories');
    assert.equal(result.namespace.storage, 'memories');
  });

  it('resolves /memories with subpath', () => {
    const result = tryResolveVirtualPath('/memories/notes.md');
    assert.ok(result);
    assert.equal(result.absolutePath, `${FAKE_STORAGE_BASE}/memories/notes.md`);
    assert.equal(result.namespace.display, '/memories');
  });

  it('resolves /executions root', () => {
    const result = tryResolveVirtualPath('/executions');
    assert.ok(result);
    assert.equal(result.absolutePath, `${FAKE_STORAGE_BASE}/executions`);
    assert.equal(result.namespace.display, '/executions');
    assert.equal(result.namespace.storage, 'executions');
  });

  it('resolves /executions with subpath', () => {
    const result = tryResolveVirtualPath('/executions/abc123/config.json');
    assert.ok(result);
    assert.equal(
      result.absolutePath,
      `${FAKE_STORAGE_BASE}/executions/abc123/config.json`,
    );
    assert.equal(result.namespace.display, '/executions');
  });

  // --- Does not match similar-but-wrong prefixes ---

  it('does not match partial prefix like /memoriesextra', () => {
    assert.equal(tryResolveVirtualPath('/memoriesextra'), null);
  });

  it('does not match partial prefix like /executionsfoo', () => {
    assert.equal(tryResolveVirtualPath('/executionsfoo'), null);
  });

  // --- Path traversal rejection ---

  it('rejects ../ traversal in /memories', () => {
    assert.throws(
      () => tryResolveVirtualPath('/memories/../../../etc/passwd'),
      ToolError,
    );
  });

  it('rejects ../ traversal in /executions', () => {
    assert.throws(
      () => tryResolveVirtualPath('/executions/../secret'),
      ToolError,
    );
  });

  it('rejects traversal via ./../../esc', () => {
    assert.throws(
      () => tryResolveVirtualPath('/memories/./../../foo'),
      ToolError,
    );
  });

  it('allows safe relative segments like /memories/a/b', () => {
    const result = tryResolveVirtualPath('/memories/a/b');
    assert.ok(result);
    assert.equal(result.absolutePath, `${FAKE_STORAGE_BASE}/memories/a/b`);
  });
});

// ============================================================================
// translateOutputLine
// ============================================================================

describe('translateOutputLine', () => {
  const ns: VirtualNamespace = {
    display: '/memories',
    storage: 'memories',
  };
  const absoluteBase = '/fake/storage/memories';

  it('replaces leading absolute path with virtual prefix', () => {
    const line = `${absoluteBase}/notes.md:10:some content`;
    assert.equal(
      translateOutputLine(line, absoluteBase, ns),
      '/memories/notes.md:10:some content',
    );
  });

  it('handles files_with_matches mode (path only, no colon)', () => {
    const line = `${absoluteBase}/notes.md`;
    assert.equal(
      translateOutputLine(line, absoluteBase, ns),
      '/memories/notes.md',
    );
  });

  it('handles count mode output (path:count)', () => {
    const line = `${absoluteBase}/notes.md:42`;
    assert.equal(
      translateOutputLine(line, absoluteBase, ns),
      '/memories/notes.md:42',
    );
  });

  it('handles context lines with - delimiter', () => {
    const line = `${absoluteBase}/notes.md-11-context line`;
    assert.equal(
      translateOutputLine(line, absoluteBase, ns),
      '/memories/notes.md-11-context line',
    );
  });

  it('passes through lines that do not start with base path', () => {
    assert.equal(translateOutputLine('--', absoluteBase, ns), '--');
    assert.equal(
      translateOutputLine('some random line', absoluteBase, ns),
      'some random line',
    );
    assert.equal(translateOutputLine('', absoluteBase, ns), '');
  });

  it('translates root path exactly', () => {
    assert.equal(translateOutputLine(absoluteBase, absoluteBase, ns), ns.display);
  });
});
