/**
 * Which files count as edited versions of a base file (PRD 12.1): the
 * Tools sheet derives its edited-file list from the host's catalog and the
 * surface's base with this rule, so a base change never leaves a file of
 * another base selected. Shared because the sheet is a browser renderer.
 */
import { getFileStem } from '@utils/core';

/**
 * Trailing/embedded `_r{N}` round token used by mid-era workflow output
 * filenames (`<base>_r{round}`). No shared owner function covers this
 * end-anchored form: `extractLastRoundMatch`'s `/_r(\d+)_/g` requires a
 * trailing underscore and does not match it (verified), so this module owns
 * it for both uses below.
 */
const ROUND_TOKEN_SOURCE = '_r\\d+';
const TRAILING_ROUND_TOKEN_REGEX = new RegExp(
  `^(.+?)(?:${ROUND_TOKEN_SOURCE})?$`,
);
const ROUND_TOKEN_REGEX = new RegExp(ROUND_TOKEN_SOURCE);

function getBaseNameWithoutRound(baseName: string): string {
  return baseName.match(TRAILING_ROUND_TOKEN_REGEX)?.[1] ?? baseName;
}

export function matchesEditedFile(
  filePath: string,
  baseFileName: string,
): boolean {
  const baseName = getFileStem(baseFileName);
  const fileBase = getFileStem(filePath);
  if (fileBase === baseName) return false;
  const baseNameWithoutRound = getBaseNameWithoutRound(baseName);
  return (
    fileBase.startsWith(baseName) ||
    (fileBase.startsWith(baseNameWithoutRound) &&
      ROUND_TOKEN_REGEX.test(fileBase))
  );
}
