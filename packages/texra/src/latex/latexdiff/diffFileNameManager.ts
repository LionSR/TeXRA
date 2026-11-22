// Standard library imports
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';
import { entryTypeIn, workspaceRelativePath } from '@texra-ai/worldline/node';

type GeneratedLatexdiffArtifactKind =
  | 'workspaceDiff'
  | 'versionControlDiff'
  | 'betweenRoundDiff';

interface GeneratedLatexdiffArtifact {
  kind: GeneratedLatexdiffArtifactKind;
  sourcePath: string;
}

/*
 * The latexdiff output filename grammar, built and parsed here only:
 *   - `<stem>_diff`: a workspace diff TeXRA names (`main_diff.tex`);
 *   - `<stem>_diffr{newer}r{older}`: a diff between two rounds;
 *   - `<stem>-diff<commit>`: latexdiff-vc's own naming, which TeXRA reads
 *     back and packs but does not choose.
 */

/** The suffix a workspace diff carries after the edited file's stem. */
export const WORKSPACE_DIFF_SUFFIX = '_diff';

/** The stem suffix of a revision's compiled latexdiff PDF: against the
 *  starting document, or against an earlier round. */
export const REVISION_DIFF_PDF_SUFFIX = Object.freeze({
  fromStart: '-diff',
  betweenRounds: '-round-diff',
} as const);

/** What latexdiff-vc inserts between the stem and the commit hash. */
const VERSION_CONTROL_DIFF_INFIX = '-diff';

/** The `_diffr{newer}r{older}` suffix of a between-round diff artifact. */
export function buildBetweenRoundDiffSuffix(
  newerRound: number | string,
  olderRound: number | string,
): string {
  return `${WORKSPACE_DIFF_SUFFIX}r${newerRound}r${olderRound}`;
}

/** The stem latexdiff-vc gives its output for `stem` against `commit`. */
export function versionControlDiffStem(stem: string, commit: string): string {
  return `${stem}${VERSION_CONTROL_DIFF_INFIX}${commit}`;
}

/**
 * The diff filename for an edited file: its stem plus `suffix`. Between-round
 * diffs pass their rounds in through `suffix` (see
 * {@link buildBetweenRoundDiffSuffix}); no round is parsed out of a filename.
 */
export function generateDiffFileName(
  editedFile: string,
  suffix: string,
): string {
  return `${path.parse(editedFile).name}${suffix}.tex`;
}

/** An abbreviated or full git commit hash: git accepts one as short as 4
 *  characters (shorter prefixes risk ambiguity) up to a full 40-character
 *  SHA-1. */
const COMMIT_HASH_HEX_RANGE = '[0-9a-fA-F]{4,40}';

const VERSION_CONTROL_DIFF_PATTERN = new RegExp(
  `^(.+)${VERSION_CONTROL_DIFF_INFIX}(${COMMIT_HASH_HEX_RANGE})$`,
  'i',
);

/** The three generated-artifact shapes; their patterns are mutually
 *  exclusive, so the order only names which kind a path is tried as first. */
const GENERATED_LATEXDIFF_ARTIFACT_PATTERNS: {
  kind: GeneratedLatexdiffArtifactKind;
  regex: RegExp;
}[] = [
  { kind: 'versionControlDiff', regex: VERSION_CONTROL_DIFF_PATTERN },
  {
    kind: 'betweenRoundDiff',
    regex: new RegExp(`^(.+)${WORKSPACE_DIFF_SUFFIX}r\\d+r\\d+$`, 'i'),
  },
  {
    kind: 'workspaceDiff',
    regex: new RegExp(`^(.+)${WORKSPACE_DIFF_SUFFIX}$`, 'i'),
  },
];

/**
 * Recognize filenames TeXRA/latexdiff generates so source-editing commands can
 * avoid treating diff artifacts as editable paper sources. Scoped to `.tex`
 * — that's the only extension these commands ever consider editing.
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
    };
  }

  return null;
}

interface VersionControlDiffFilename {
  sourcePath: string;
  commitHash: string;
}

/**
 * Parse a latexdiff-vc filename regardless of extension — the compiled
 * preview (`paper-diffHASH.pdf`) shares the same naming as the `.tex` source
 * it was built from. Unlike `detectGeneratedLatexdiffArtifact` (deliberately
 * `.tex`-only, for "should an editing tool treat this as a source file"),
 * this answers "does this open file reference a version-control diff, and
 * which commit" for any file type — e.g. selecting a base file or looking up
 * a commit from whichever tab the user currently has open.
 */
export function parseVersionControlDiffFilename(
  filePath: string,
): VersionControlDiffFilename | null {
  const parsed = path.parse(filePath);
  const match = VERSION_CONTROL_DIFF_PATTERN.exec(parsed.name);
  const sourceStem = match?.[1];
  const commitHash = match?.[2];
  if (!sourceStem || !commitHash) return null;

  return {
    sourcePath: path.join(parsed.dir, `${sourceStem}${parsed.ext}`),
    commitHash,
  };
}

/** The source a generated latexdiff artifact was built from, and whether
 *  it is on disk. */
export interface LatexdiffArtifactSource {
  readonly sourcePath: string;
  readonly sourceExists: boolean;
}

/**
 * The source of the generated latexdiff artifact at `filePath`, or `null`
 * when the file is not one. A user may legitimately keep a source file named
 * `chapter_diff.tex`, so a plain `_diff` suffix counts as generated only when
 * its inferred source exists. A relative `filePath` is probed under `root`,
 * and the answered `sourcePath` is relative the same way.
 */
export const latexdiffArtifactSource = Effect.fn(
  'latexdiff.latexdiffArtifactSource',
)(function* (filePath: string, root: string) {
  const artifact = detectGeneratedLatexdiffArtifact(filePath);
  if (!artifact) return null;
  const fs = yield* FileSystem.FileSystem;
  const sourceExists =
    (yield* entryTypeIn(fs, path.resolve(root, artifact.sourcePath))) !==
    undefined;
  if (artifact.kind === 'workspaceDiff' && !sourceExists) return null;
  return { sourcePath: artifact.sourcePath, sourceExists };
});

/**
 * What a fixer is told about a latexdiff artifact. Generated artifacts are
 * valid fixer targets (latexdiff itself often emits non-compiling markup that
 * regenerating the diff would only reproduce), but the fixer should repair
 * the markup in place, and carry a source-rooted fix to the source, when it
 * is there, so it survives regeneration. `subject` names the artifact and
 * `source.sourcePath` is shown as given.
 */
export function latexdiffArtifactNote(
  subject: string,
  { sourcePath, sourceExists }: LatexdiffArtifactSource,
): string {
  const origin = sourceExists
    ? ` generated from ${sourcePath}`
    : `; its inferred source ${sourcePath} is not present in the workspace`;
  return [
    `${subject} is a latexdiff artifact${origin}.`,
    'If an error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or the DIF preamble blocks), repair the markup in place and keep the diff annotations intact.',
    ...(sourceExists
      ? [
          `If an error originates in the original source document, fix ${sourcePath} too so a regenerated diff stays fixed.`,
        ]
      : []),
  ].join(' ');
}

/**
 * `base` with the latexdiff note appended when `activeFilePath` (absolute) is
 * a generated latexdiff artifact. `workspaceRoot` is the root the source is
 * shown relative to; `undefined` (no folder open) shows it absolute.
 */
export const buildLatexdiffAwareFixInstruction = Effect.fn(
  'latexdiff.buildLatexdiffAwareFixInstruction',
)(function* (
  base: string,
  activeFilePath: string,
  workspaceRoot: string | undefined,
) {
  const source = yield* latexdiffArtifactSource(
    activeFilePath,
    path.dirname(activeFilePath),
  );
  if (!source) return base;
  const note = latexdiffArtifactNote('This file', {
    ...source,
    sourcePath: workspaceRelativePath(workspaceRoot, source.sourcePath),
  });
  return `${base} ${note}`;
});
