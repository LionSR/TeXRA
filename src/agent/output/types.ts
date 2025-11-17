// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { DiffStatsSchema, type DiffStats } from '@agent/types/DiffTypes';

// Local imports - files
import type { FileLocation } from '@utils/files/taskRunStorage';

export interface OutputXmlSummary {
  tagContents: Record<string, string | string[]>;
  documents: string[];
  singleOutputFile: string | null;
  sourceLocation: FileLocation | null;
}

export interface NamedOutputFile {
  source: string;
  path: string;
  relativePath: string;
  workspacePath?: string;
  location: FileLocation;
}

export interface OutputFileInfo extends DiffStats {
  path: string;
  relativePath: string;
  displayLabel: string;
  displayDir: string;
  workspacePath?: string | null;
  base?: string | null;
  prev?: string | null;
  original?: string | null;
  location: FileLocation;
  baseLocation?: FileLocation | null;
  prevLocation?: FileLocation | null;
  originalLocation?: FileLocation | null;
  source?: string | null;
  rawOutputPath?: string | null;
  rawLocation?: FileLocation | null;
  xmlSummary?: OutputXmlSummary | null;
}

export interface RoundFileMapping {
  baseToOutput: Map<string, string>;
  prevToOutput: Map<string, string>;
  originByOutput: Map<string, string | undefined>;
  locationByOutput: Map<string, FileLocation>;
}

export interface RoundOutputArtifacts {
  round: number;
  rawOutput: FileLocation | null;
  rawOutputPath: string | null;
  outputFiles: NamedOutputFile[];
  processedFiles: NamedOutputFile[];
  fileInfos: OutputFileInfo[];
  xmlSummary: OutputXmlSummary;
}

const FileLocationScopeSchema = z.union([
  z.literal('workspace'),
  z.literal('runStorage'),
  z.literal('external'),
]);

const FileRelativeScopeSchema = z.union([
  z.literal('workspace'),
  z.literal('runStorage'),
  z.literal('absolute'),
]);

const WorkspaceLocationSchema = z
  .object({
    absolutePath: z.string(),
    relativePath: z.string(),
  })
  .strict();

const RunStorageLocationSchema = z
  .object({
    absolutePath: z.string(),
    relativePath: z.string(),
    storageRelativePath: z.string(),
  })
  .strict();

const FileLocationSchema = z
  .object({
    absolutePath: z.string(),
    scope: FileLocationScopeSchema,
    relativePath: z.string(),
    relativeScope: FileRelativeScopeSchema,
    workspace: WorkspaceLocationSchema.nullish().optional(),
    runStorage: RunStorageLocationSchema.nullish().optional(),
  })
  .strict();

const RawOutputXmlSummarySchema = z
  .object({
    tagContents: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .optional(),
    documents: z.array(z.string()).optional(),
    singleOutputFile: z.string().nullable().optional(),
    sourceLocation: FileLocationSchema.nullable().optional(),
  })
  .strict();

export const OutputXmlSummarySchema: z.ZodType<OutputXmlSummary> =
  RawOutputXmlSummarySchema.transform(
    (value): OutputXmlSummary => ({
      tagContents: value.tagContents ?? {},
      documents: value.documents ?? [],
      singleOutputFile: value.singleOutputFile ?? null,
      sourceLocation: value.sourceLocation ?? null,
    }),
  );

const NullableString = () => z.string().nullable().optional();
const NullableLocation = () => FileLocationSchema.nullable().optional();
const NullableSummary = () => OutputXmlSummarySchema.nullable().optional();

const OutputFileInfoBaseSchema = DiffStatsSchema.extend({
  path: z.string(),
  relativePath: z.string(),
  displayLabel: z.string(),
  displayDir: z.string(),
  workspacePath: NullableString(),
  base: NullableString(),
  prev: NullableString(),
  original: NullableString(),
  location: FileLocationSchema,
  baseLocation: NullableLocation(),
  prevLocation: NullableLocation(),
  originalLocation: NullableLocation(),
  source: NullableString(),
  rawOutputPath: NullableString(),
  rawLocation: NullableLocation(),
  xmlSummary: NullableSummary(),
}).strict();

export const OutputFileInfoSchema: z.ZodType<OutputFileInfo> =
  OutputFileInfoBaseSchema.transform((value) => value as OutputFileInfo);

export const OutputFileInfoListSchema = OutputFileInfoSchema.array();
