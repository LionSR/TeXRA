// Standard library imports
import * as path from 'node:path';

import {
  extractLastRoundMatch,
  extractLastRoundModelMatch,
} from '@agent/utils/mergeFileUtils';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';

type GeneratedLatexdiffArtifactKind =
  'workspaceDiff' | 'versionControlDiff' | 'betweenRoundDiff';

export interface GeneratedLatexdiffArtifact {
  kind: GeneratedLatexdiffArtifactKind;
  sourcePath: string;
  /** The commit hash embedded in the filename. Only set for `versionControlDiff`. */
  commitHash?: string;
}

/**
 * Build the `_diffr{newer}r{older}` suffix used to name a between-round diff
 * artifact. Sole owner of this grammar — other call sites that need this
 * suffix (rather than the full filename from `generateDiffFileName`) should
 * import this instead of re-encoding the template themselves.
 */
export function buildBetweenRoundDiffSuffix(
  newerRound: number | string,
  olderRound: number | string,
): string {
  return `_diffr${newerRound}r${olderRound}`;
}

/**
 * Generate a diff filename based on input and edited file names.
 * Uses round-based naming only for between-round diffs (same operation chain).
 * Falls back to suffix for round-vs-original diffs (edited builds on input).
 */
export function generateDiffFileName(
  inputFile: string,
  editedFile: string,
  suffix: string,
): string {
  const inputFileName = path.basename(inputFile);
  const editedFileName = path.basename(editedFile);
  const inputBaseName = path.parse(inputFileName).name;
  const editedBaseName = path.parse(editedFileName).name;

  const inputRoundMatch = extractLastRoundModelMatch(inputFileName);
  const editedRoundMatch = extractLastRoundModelMatch(editedFileName);

  // Only use round-based naming if:
  // 1. Both files have rounds AND rounds differ
  // 2. The edited file does NOT start with the input file's base name
  //    (if it does, the input's round is part of the base, not a round to diff against)
  // This distinguishes between-round diffs (r0->r1 in same chain) from
  // round-vs-original diffs (original_r0 -> original_r0_agent_r1).
  if (
    inputRoundMatch &&
    editedRoundMatch &&
    inputRoundMatch[1] !== editedRoundMatch[1] &&
    !editedBaseName.startsWith(inputBaseName)
  ) {
    // Generate round-based filename inline
    const firstRound = inputRoundMatch[1];
    const secondRound = editedRoundMatch[1];
    const sameModel = inputRoundMatch[2] === editedRoundMatch[2];

    // Extract base name from edited filename using round pattern
    const lastMatch = extractLastRoundMatch(editedBaseName);
    if (lastMatch?.index == null) {
      throw new Error(
        `Failed to extract base name from edited file: ${editedFileName}`,
      );
    }
    // Return everything up to (or including) the last _rN
    // The -1 excludes the trailing underscore from _rN_ when includeRound is true
    const endIndex =
      lastMatch.index + (sameModel ? lastMatch[0].length - 1 : 0);
    const baseName = editedBaseName.slice(0, endIndex);
    const modelSuffix = sameModel ? `_${editedRoundMatch[2]}` : '';

    return `${baseName}${modelSuffix}${buildBetweenRoundDiffSuffix(secondRound, firstRound)}.tex`;
  }

  return `${editedBaseName}${suffix}.tex`;
}

/**
 * Ordered from most specific to least so the VC/between-round hashes are
 * recognized before the bare `_diff` suffix that they also end with.
 *
 * The version-control hash range (4-40 hex chars) matches `COMMIT_HASH_PATTERN`
 * in `packages/extension/src/commands/git/gitCommands.ts` — the git-commit
 * validator that governs what hashes latexdiff-vc filenames can actually
 * embed. Keep these two in sync; a narrower range here would silently fail to
 * recognize a valid abbreviated-hash diff file as a generated artifact.
 */
const GENERATED_LATEXDIFF_ARTIFACT_PATTERNS: {
  kind: GeneratedLatexdiffArtifactKind;
  regex: RegExp;
}[] = [
  { kind: 'versionControlDiff', regex: /^(.+)-diff([0-9a-f]{4,40})$/i },
  { kind: 'betweenRoundDiff', regex: /^(.+)_diffr\d+r\d+$/i },
  { kind: 'workspaceDiff', regex: /^(.+)_diff$/i },
];

/**
 * Recognize filenames TeXRA/latexdiff generates so source-editing commands can
 * avoid treating diff artifacts as editable paper sources.
 */
export function detectGeneratedLatexdiffArtifact(
  filePath: string,
): GeneratedLatexdiffArtifact | null {
  const parsed = path.parse(filePath);
  if (parsed.ext.toLowerCase() !== '.tex') return null;

  for (const pattern of GENERATED_LATEXDIFF_ARTIFACT_PATTERNS) {
    const match = pattern.regex.exec(parsed.name);
    const sourceStem = match?.[1];
    if (!sourceStem) continue;
    return {
      kind: pattern.kind,
      sourcePath: path.join(parsed.dir, `${sourceStem}${parsed.ext}`),
      ...(pattern.kind === 'versionControlDiff' && match[2]
        ? { commitHash: match[2] }
        : {}),
    };
  }

  return null;
}

/**
 * Augment a fix-agent instruction with latexdiff-artifact awareness.
 *
 * Generated latexdiff artifacts are valid fixer targets — latexdiff itself
 * often emits non-compiling markup that regenerating the diff would only
 * reproduce — but the fixer should know the file is a diff so it repairs the
 * markup in place, and should propagate source-rooted fixes to the source so
 * they survive regeneration.
 */
export async function buildLatexdiffAwareFixInstruction(
  base: string,
  activeFilePath: string,
): Promise<string> {
  const artifact = detectGeneratedLatexdiffArtifact(activeFilePath);
  if (!artifact) return base;

  const sourceExists = await AbsoluteFS.exists(artifact.sourcePath);
  // A user may legitimately keep a source file named chapter_diff.tex. Treat
  // a plain `_diff` suffix as generated only when the inferred source exists.
  if (artifact.kind === 'workspaceDiff' && !sourceExists) {
    return base;
  }

  const sourceHint = sourceExists
    ? ` generated from ${WorkspaceFS.relativePath(artifact.sourcePath)}`
    : '';
  return [
    base,
    `This file is a latexdiff artifact${sourceHint}.`,
    'If an error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or the DIF preamble blocks), repair the markup in place and keep the diff annotations intact.',
    'If an error originates in the original source document, fix the source too so a regenerated diff stays fixed.',
  ].join(' ');
}
