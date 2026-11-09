// Standard library imports
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';
import { entryTypeIn, workspaceRelativePath } from '@texra-ai/harness/node';

import { COMMIT_HASH_HEX_RANGE } from '@texra/utils/git/commitHashPattern';

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

/** Hash group sourced from `@texra/utils/git/commitHashPattern` so it can't drift from the git-commit validator. */
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

/**
 * Augment a fix-agent instruction with latexdiff-artifact awareness.
 *
 * Generated latexdiff artifacts are valid fixer targets — latexdiff itself
 * often emits non-compiling markup that regenerating the diff would only
 * reproduce — but the fixer should know the file is a diff so it repairs the
 * markup in place, and should propagate source-rooted fixes to the source so
 * they survive regeneration.
 *
 * `workspaceRoot` is the root the source hint is made relative to — the
 * caller's own session root, held as data. `undefined` (no folder open)
 * leaves the hint on the path the caller already has.
 */
export const buildLatexdiffAwareFixInstruction = Effect.fn(
  'latexdiff.buildLatexdiffAwareFixInstruction',
)(function* (
  base: string,
  activeFilePath: string,
  workspaceRoot: string | undefined,
) {
  const artifact = detectGeneratedLatexdiffArtifact(activeFilePath);
  if (!artifact) return base;

  const fs = yield* FileSystem.FileSystem;
  const sourceExists =
    (yield* entryTypeIn(fs, artifact.sourcePath)) !== undefined;
  // A user may legitimately keep a source file named chapter_diff.tex. Treat
  // a plain `_diff` suffix as generated only when the inferred source exists.
  if (artifact.kind === 'workspaceDiff' && !sourceExists) {
    return base;
  }

  const sourceHint = sourceExists
    ? ` generated from ${workspaceRelativePath(workspaceRoot, artifact.sourcePath)}`
    : '';
  return [
    base,
    `This file is a latexdiff artifact${sourceHint}.`,
    'If an error comes from broken latexdiff markup (\\DIFadd/\\DIFdel or the DIF preamble blocks), repair the markup in place and keep the diff annotations intact.',
    'If an error originates in the original source document, fix the source too so a regenerated diff stays fixed.',
  ].join(' ');
});
