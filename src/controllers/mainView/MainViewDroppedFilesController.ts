// Standard library imports
import * as path from 'node:path';

// Local imports - shared schemas
import type { MultipleDocumentFileType } from '@shared/schemas';

export const MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES = [
  'input',
  'context',
  'media',
] as const satisfies readonly MultipleDocumentFileType[];

type MainViewAttachableDropCategory =
  (typeof MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES)[number];

export type MainViewAllowedDropExtensions = Readonly<
  Record<MainViewAttachableDropCategory, readonly string[]>
>;

export interface MainViewDroppedFileAttachmentPlan {
  readonly filesByCategory: Readonly<
    Record<MainViewAttachableDropCategory, readonly string[]>
  >;
  readonly attachedCount: number;
  readonly rejectedCount: number;
}

export interface MainViewDroppedFileAttachmentInput {
  readonly paths: readonly (string | null)[];
  readonly allowedExtensions: MainViewAllowedDropExtensions;
  readonly target?: MultipleDocumentFileType;
}

export function planMainViewDroppedFileAttachments(
  input: MainViewDroppedFileAttachmentInput,
): MainViewDroppedFileAttachmentPlan {
  const grouped = {
    input: new Set<string>(),
    context: new Set<string>(),
    media: new Set<string>(),
  } satisfies Record<MainViewAttachableDropCategory, Set<string>>;
  let rejectedCount = 0;

  for (const filePath of input.paths) {
    if (!filePath) {
      rejectedCount += 1;
      continue;
    }
    const category = resolveDroppedFileCategory(
      filePath,
      input.allowedExtensions,
      input.target,
    );
    if (!category) {
      rejectedCount += 1;
      continue;
    }
    grouped[category].add(filePath);
  }

  const filesByCategory = {
    input: [...grouped.input],
    context: [...grouped.context],
    media: [...grouped.media],
  } satisfies Record<MainViewAttachableDropCategory, string[]>;

  return {
    filesByCategory,
    attachedCount: MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES.reduce(
      (count, category) => count + filesByCategory[category].length,
      0,
    ),
    rejectedCount,
  };
}

export function normalizeMainViewFileExtension(filePath: string): string {
  const trimmed = filePath.trim();
  const extension = path.extname(trimmed) || trimmed;
  return extension.toLowerCase().replace(/^\./, '');
}

function resolveDroppedFileCategory(
  filePath: string,
  allowedExtensions: MainViewAllowedDropExtensions,
  target?: MultipleDocumentFileType,
): MainViewAttachableDropCategory | null {
  const extension = normalizeMainViewFileExtension(filePath);
  if (!extension) return null;

  if (target) {
    return isAttachableDropCategory(target) &&
      isExtensionAllowed(target, extension, allowedExtensions)
      ? target
      : null;
  }

  if (isExtensionAllowed('media', extension, allowedExtensions)) {
    return 'media';
  }
  if (
    ['bib', 'bbl', 'cls', 'sty'].includes(extension) &&
    isExtensionAllowed('context', extension, allowedExtensions)
  ) {
    return 'context';
  }
  if (isExtensionAllowed('input', extension, allowedExtensions)) {
    return 'input';
  }
  if (isExtensionAllowed('context', extension, allowedExtensions)) {
    return 'context';
  }
  return null;
}

function isAttachableDropCategory(
  category: MultipleDocumentFileType,
): category is MainViewAttachableDropCategory {
  return category === 'input' || category === 'context' || category === 'media';
}

function isExtensionAllowed(
  category: MainViewAttachableDropCategory,
  extension: string,
  allowedExtensions: MainViewAllowedDropExtensions,
): boolean {
  return allowedExtensions[category].some(
    (candidate) => normalizeMainViewFileExtension(candidate) === extension,
  );
}
