// Standard library imports
import * as path from 'path';

/**
 * Pattern to match latex diff filenames: `basename-diffCOMMITHASH.ext`
 * Groups: [1] = original basename, [2] = commit hash (4-40 hex chars)
 */
const LATEX_DIFF_BASENAME_PATTERN = /^(.+?)-diff([0-9a-fA-F]{4,40})$/;

/**
 * Metadata extracted from a latex diff filename.
 */
export interface LatexDiffMetadata {
  /** Directory containing the file */
  dir: string;
  /** Original base filename (without -diffXXX suffix) */
  baseName: string;
  /** File extension (including dot) */
  ext: string;
  /** Git commit hash from the diff filename */
  commitHash: string;
}

/**
 * Parse latex diff metadata from a file path.
 *
 * Latex diff files follow the naming convention: `basename-diffCOMMITHASH.ext`
 * where COMMITHASH is a 4-40 character hex string (abbreviated or full git hash).
 *
 * @param filePath - Path to potentially parse
 * @returns Parsed metadata or null if not a latex diff file
 */
export function parseLatexDiffMetadata(
  filePath: string,
): LatexDiffMetadata | null {
  const { dir, name, ext } = path.parse(filePath);
  const match = name.match(LATEX_DIFF_BASENAME_PATTERN);
  if (!match) return null;

  // Regex guarantees both groups are non-empty when match succeeds.
  const [, baseName, commitHash] = match;
  return { dir, baseName, ext, commitHash };
}

/**
 * Derive the base file path from a latex diff file path.
 *
 * Given a diff file like `paper-diff1234abcd.tex`, returns `paper.tex`.
 *
 * @param filePath - Path to a latex diff file
 * @returns Path to the original base file, or null if not a diff file
 */
export function deriveBaseFileFromLatexDiff(filePath: string): string | null {
  const metadata = parseLatexDiffMetadata(filePath);
  if (!metadata) {
    return null;
  }

  const { dir, baseName, ext } = metadata;
  return path.join(dir, `${baseName}${ext}`);
}
