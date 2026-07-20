// Node imports
import { readFile, unlink } from 'node:fs/promises';

// Third-party imports
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

// Common imports
import { isFileNotFoundError } from '@common/errors';

const LEGACY_STREAMS_KEY = 'restoredStreams';

/**
 * The global desktop file used one version number across two status
 * vocabularies. Status is validated here only to distinguish a genuine legacy
 * row from corrupt data; it never crosses the importer boundary.
 */
const LegacyStreamStatusSchema = z.enum([
  'running',
  'error',
  'stopped',
  'ready',
  'waiting',
  'resuming',
  'initializing',
  'completed',
  'cancelled',
  'failed',
]);

const LegacyStreamRowSchema = z.looseObject({
  streamId: z.string().min(1),
  label: z.string(),
  agent: z.string().optional(),
  agentCategory: z.enum(['workflow', 'toolUse']),
  inputFile: z.string().optional(),
  instruction: z.string().optional(),
  lastKnownStatus: LegacyStreamStatusSchema,
  description: z.string().optional(),
  executionId: z
    .string()
    .min(6)
    .regex(/^[0-9a-f][-0-9a-f]*$/i)
    .optional(),
  parentStreamId: z.string().min(1).optional(),
  creationTimestamp: z.number(),
  lastTimestamp: z.number().optional(),
  persistedAt: z.number(),
});

const LegacyStreamsDocumentSchema = z.looseObject({
  [LEGACY_STREAMS_KEY]: z.looseObject({
    version: z.literal(1),
    streams: z.array(LegacyStreamRowSchema),
  }),
});

type LegacyStreamsDocument = z.infer<typeof LegacyStreamsDocumentSchema>;

interface DesktopLegacyStreamEvidence {
  /** Stream IDs for which the current workspace has a transcript. */
  transcriptStreamIds?: Iterable<string>;
  /** Stream IDs for which the current workspace has persisted sidecars. */
  sidecarStreamIds?: Iterable<string>;
}

/**
 * A prepared migration of the retired global desktop stream file.
 *
 * Claims contain identities only. The caller reconstructs canonical state
 * from current-workspace evidence, then confirms the identities that were
 * durably migrated through {@link commit}.
 */
interface DesktopLegacyStreamImport {
  readonly claims: readonly string[];
  commit(migratedStreamIds: Iterable<string>): Promise<void>;
}

/**
 * Read the retired global `streams.json` without changing it and claim only
 * rows corroborated by canonical evidence from the current workspace.
 */
export async function prepareDesktopLegacyStreamImport(
  filePath: string,
  evidence: DesktopLegacyStreamEvidence,
): Promise<DesktopLegacyStreamImport> {
  const document = await readLegacyStreamsDocument(filePath);
  const evidenceIds = new Set([
    ...(evidence.transcriptStreamIds ?? []),
    ...(evidence.sidecarStreamIds ?? []),
  ]);
  const claims = Object.freeze(
    document == null
      ? []
      : [
          ...new Set(
            document[LEGACY_STREAMS_KEY].streams
              .map((row) => row.streamId)
              .filter((streamId) => evidenceIds.has(streamId)),
          ),
        ],
  );
  const claimSet = new Set(claims);

  return {
    claims,
    async commit(migratedStreamIds) {
      const confirmedIds = new Set(
        [...migratedStreamIds].filter((streamId) => claimSet.has(streamId)),
      );
      if (confirmedIds.size === 0) return;

      // Re-read at commit time so an unmatched row added after preparation is
      // not overwritten by a stale migration plan.
      const current = await readLegacyStreamsDocument(filePath);
      if (current == null) return;

      const currentRows = current[LEGACY_STREAMS_KEY].streams;
      const remainingRows = currentRows.filter(
        (row) => !confirmedIds.has(row.streamId),
      );
      if (remainingRows.length === currentRows.length) return;

      if (remainingRows.length === 0) {
        try {
          await unlink(filePath);
        } catch (error) {
          if (!isFileNotFoundError(error)) throw error;
        }
        return;
      }

      const remainingDocument: LegacyStreamsDocument = {
        ...current,
        [LEGACY_STREAMS_KEY]: {
          ...current[LEGACY_STREAMS_KEY],
          streams: remainingRows,
        },
      };
      await writeFileAtomic(
        filePath,
        `${JSON.stringify(remainingDocument, null, 2)}\n`,
      );
    },
  };
}

async function readLegacyStreamsDocument(
  filePath: string,
): Promise<LegacyStreamsDocument | undefined> {
  try {
    const content = await readFile(filePath, 'utf8');
    return LegacyStreamsDocumentSchema.parse(JSON.parse(content));
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}
