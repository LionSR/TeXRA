// Standard library imports
import * as assert from 'assert';
import * as path from 'path';

// Local imports - schemas
import { ExternalInquiryThreadIdSchema } from '@shared/schemas';

// Local imports - inquiry storage
import {
  looksLikeUtf8Text,
  persistExternalInquiryTurn,
  readExternalInquiryThread,
} from '@tools/inquiry/externalInquiryStorage';

// Local imports - filesystem
import { GlobalStorageFS, StorageFS } from '@utils/files';

const FILE_TYPE = 1;
const DIRECTORY_TYPE = 2;
const EXECUTION_ONE = 'a1b2c3d4e5f6' as const;
const EXECUTION_TWO = '0f1e2d3c4b5a' as const;

interface FakeFSState {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

function normalizeTarget(target: string): string {
  return target
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replaceAll(/\/+/g, '/');
}

function ensureDirAncestors(state: FakeFSState, target: string): void {
  let current = normalizeTarget(target);
  while (current && current !== '.') {
    state.dirs.add(current);
    const parent = path.posix.dirname(current);
    if (parent === current || parent === '.') break;
    current = parent;
  }
}

function writeFile(
  state: FakeFSState,
  target: string,
  content: string | Uint8Array,
): void {
  const normalized = normalizeTarget(target);
  ensureDirAncestors(state, path.posix.dirname(normalized));
  state.files.set(
    normalized,
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content),
  );
}

function readFile(state: FakeFSState, target: string): Buffer {
  const normalized = normalizeTarget(target);
  const file = state.files.get(normalized);
  if (!file) throw new Error(`Missing file: ${normalized}`);
  return file;
}

function deleteRecursive(state: FakeFSState, target: string): void {
  const normalized = normalizeTarget(target);
  const prefix = normalized ? `${normalized}/` : '';

  state.files.delete(normalized);
  state.dirs.delete(normalized);

  for (const filePath of [...state.files.keys()]) {
    if (filePath.startsWith(prefix)) state.files.delete(filePath);
  }

  for (const dirPath of [...state.dirs]) {
    if (dirPath === normalized || dirPath.startsWith(prefix)) {
      state.dirs.delete(dirPath);
    }
  }
}

function readDirectory(
  state: FakeFSState,
  target: string,
): Array<[string, number]> {
  const normalized = normalizeTarget(target);
  if (normalized && !state.dirs.has(normalized)) {
    throw new Error(`Missing directory: ${normalized}`);
  }

  const prefix = normalized ? `${normalized}/` : '';
  const entries = new Map<string, number>();

  for (const dirPath of state.dirs) {
    if (!dirPath.startsWith(prefix) || dirPath === normalized) continue;
    const rest = dirPath.slice(prefix.length);
    if (rest && !rest.includes('/')) {
      entries.set(rest, DIRECTORY_TYPE);
    }
  }

  for (const filePath of state.files.keys()) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (rest && !rest.includes('/')) {
      entries.set(rest, FILE_TYPE);
    }
  }

  return [...entries.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

describe('externalInquiryStorage', () => {
  let originalGlobalEnsureDir: typeof GlobalStorageFS.ensureDir;
  let originalGlobalWrite: typeof GlobalStorageFS.write;
  let originalGlobalWriteJson: typeof GlobalStorageFS.writeJson;
  let originalGlobalReadJson: typeof GlobalStorageFS.readJson;
  let originalGlobalReadDir: typeof GlobalStorageFS.readDir;
  let originalGlobalReadBytes: typeof GlobalStorageFS.readBytes;

  let originalStorageEnsureDir: typeof StorageFS.ensureDir;
  let originalStorageWrite: typeof StorageFS.write;
  let originalStorageExists: typeof StorageFS.exists;
  let originalStorageDelete: typeof StorageFS.delete;

  let globalState: FakeFSState;
  let executionState: FakeFSState;

  beforeEach(() => {
    originalGlobalEnsureDir = GlobalStorageFS.ensureDir;
    originalGlobalWrite = GlobalStorageFS.write;
    originalGlobalWriteJson = GlobalStorageFS.writeJson;
    originalGlobalReadJson = GlobalStorageFS.readJson;
    originalGlobalReadDir = GlobalStorageFS.readDir;
    originalGlobalReadBytes = GlobalStorageFS.readBytes;

    originalStorageEnsureDir = StorageFS.ensureDir;
    originalStorageWrite = StorageFS.write;
    originalStorageExists = StorageFS.exists;
    originalStorageDelete = StorageFS.delete;

    globalState = {
      files: new Map(),
      dirs: new Set([EXTERNAL_ROOT]),
    };
    executionState = {
      files: new Map(),
      dirs: new Set(['executions']),
    };

    GlobalStorageFS.ensureDir = async (target: string) => {
      ensureDirAncestors(globalState, target);
      globalState.dirs.add(normalizeTarget(target));
    };
    GlobalStorageFS.write = async (
      target: string,
      content: string | Uint8Array,
    ) => {
      writeFile(globalState, target, content);
    };
    GlobalStorageFS.writeJson = async <T>(target: string, value: T) => {
      writeFile(globalState, target, JSON.stringify(value, null, 2));
    };
    GlobalStorageFS.readJson = async <T>(target: string) =>
      JSON.parse(readFile(globalState, target).toString('utf8')) as T;
    GlobalStorageFS.readDir = async (target: string) =>
      readDirectory(globalState, target);
    GlobalStorageFS.readBytes = async (target: string) =>
      readFile(globalState, target);

    StorageFS.ensureDir = async (target: string) => {
      ensureDirAncestors(executionState, target);
      executionState.dirs.add(normalizeTarget(target));
    };
    StorageFS.write = async (target: string, content: string | Uint8Array) => {
      writeFile(executionState, target, content);
    };
    StorageFS.exists = async (target: string) => {
      const normalized = normalizeTarget(target);
      return (
        executionState.files.has(normalized) ||
        executionState.dirs.has(normalized)
      );
    };
    StorageFS.delete = async (
      target: string,
      _options?: { recursive?: boolean; useTrash?: boolean },
    ) => {
      deleteRecursive(executionState, target);
    };
  });

  afterEach(() => {
    GlobalStorageFS.ensureDir = originalGlobalEnsureDir;
    GlobalStorageFS.write = originalGlobalWrite;
    GlobalStorageFS.writeJson = originalGlobalWriteJson;
    GlobalStorageFS.readJson = originalGlobalReadJson;
    GlobalStorageFS.readDir = originalGlobalReadDir;
    GlobalStorageFS.readBytes = originalGlobalReadBytes;

    StorageFS.ensureDir = originalStorageEnsureDir;
    StorageFS.write = originalStorageWrite;
    StorageFS.exists = originalStorageExists;
    StorageFS.delete = originalStorageDelete;
  });

  it('creates canonical thread storage and mirrors it into the execution', async () => {
    const uploadContent = '# external note\n';
    const result = await persistExternalInquiryTurn({
      mode: 'new',
      question: 'What changed?',
      answer: 'Here is the external answer.',
      uploadedFiles: [
        {
          fileName: 'note.md',
          mediaType: 'text/markdown',
          sizeBytes: Buffer.byteLength(uploadContent),
          base64: Buffer.from(uploadContent, 'utf8').toString('base64'),
        },
      ],
      executionId: EXECUTION_ONE,
    });

    assert.match(result.threadId, /^ei_[0-9a-f]{12}$/);
    assert.strictEqual(result.turn.turnIndex, 1);
    assert.ok(
      globalState.files.has(
        `external_inquiry_threads/${result.threadId}/manifest.json`,
      ),
    );
    assert.strictEqual(
      readFile(
        globalState,
        `external_inquiry_threads/${result.threadId}/turns/turn-0001/answer.txt`,
      ).toString('utf8'),
      'Here is the external answer.',
    );
    assert.strictEqual(
      readFile(
        executionState,
        `executions/${EXECUTION_ONE}/external_inquiry/${result.threadId}/turns/turn-0001/uploads/note.md`,
      ).toString('utf8'),
      uploadContent,
    );
    assert.deepStrictEqual(result.executionMirrorPaths?.uploadPaths, [
      `/executions/${EXECUTION_ONE}/files/external_inquiry/${result.threadId}/turns/turn-0001/uploads/note.md`,
    ]);
  });

  it('reuses a durable thread across runs and mirrors prior turns into the new execution', async () => {
    const firstTurn = await persistExternalInquiryTurn({
      mode: 'new',
      question: 'Question one',
      answer: 'Answer one',
      executionId: EXECUTION_ONE,
    });

    const secondTurn = await persistExternalInquiryTurn({
      mode: 'followup',
      threadId: firstTurn.threadId,
      question: 'Question two',
      answer: 'Answer two',
      executionId: EXECUTION_TWO,
    });

    assert.strictEqual(secondTurn.turn.turnIndex, 2);

    const manifest = await readExternalInquiryThread(firstTurn.threadId);
    assert.strictEqual(manifest?.turns.length, 2);
    assert.strictEqual(manifest?.turns[0]?.question, 'Question one');
    assert.strictEqual(manifest?.turns[1]?.question, 'Question two');

    assert.ok(
      executionState.files.has(
        `executions/${EXECUTION_TWO}/external_inquiry/${firstTurn.threadId}/turns/turn-0001/answer.txt`,
      ),
    );
    assert.ok(
      executionState.files.has(
        `executions/${EXECUTION_TWO}/external_inquiry/${firstTurn.threadId}/turns/turn-0002/answer.txt`,
      ),
    );
  });

  it('normalizes uppercase thread IDs for follow-up turns and thread reads', async () => {
    const firstTurn = await persistExternalInquiryTurn({
      mode: 'new',
      question: 'Question one',
      answer: 'Answer one',
      executionId: EXECUTION_ONE,
    });

    const uppercaseThreadId = firstTurn.threadId.toUpperCase();

    const secondTurn = await persistExternalInquiryTurn({
      mode: 'followup',
      threadId: ExternalInquiryThreadIdSchema.parse(uppercaseThreadId),
      question: 'Question two',
      answer: 'Answer two',
      executionId: EXECUTION_TWO,
    });

    assert.strictEqual(secondTurn.threadId, firstTurn.threadId);

    const manifest = await readExternalInquiryThread(uppercaseThreadId);
    assert.strictEqual(manifest?.threadId, firstTurn.threadId);
    assert.strictEqual(manifest?.turns.length, 2);
  });

  it('rejects uploaded files that are binary despite text-like metadata', async () => {
    await assert.rejects(
      () =>
        persistExternalInquiryTurn({
          mode: 'new',
          question: 'Inspect this file',
          answer: 'Binary upload attempt',
          uploadedFiles: [
            {
              fileName: 'payload.txt',
              mediaType: 'text/plain',
              sizeBytes: 4,
              base64: Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64'),
            },
          ],
        }),
      /appears to be binary/,
    );
  });

  it('rejects uploaded files with disallowed extensions even if they are text', async () => {
    await assert.rejects(
      () =>
        persistExternalInquiryTurn({
          mode: 'new',
          question: 'Inspect this file',
          answer: 'Unexpected extension',
          uploadedFiles: [
            {
              fileName: 'config.ini',
              mediaType: '',
              sizeBytes: 9,
              base64: Buffer.from('a=1\nb=2\n', 'utf8').toString('base64'),
            },
          ],
        }),
      /not an allowed text\/code file/,
    );
  });

  it('detects UTF-8 text bytes conservatively', () => {
    assert.strictEqual(
      looksLikeUtf8Text(Buffer.from('plain text', 'utf8')),
      true,
    );
    assert.strictEqual(
      looksLikeUtf8Text(Buffer.from([0x00, 0x01, 0x02])),
      false,
    );
  });
});

const EXTERNAL_ROOT = 'external_inquiry_threads';
