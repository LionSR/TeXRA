export type GitHubCheckAnnotationLevel = 'notice' | 'warning' | 'failure';

export const DEFAULT_CHECK_ANNOTATION_LEVEL: GitHubCheckAnnotationLevel =
  'failure';

const ANNOTATION_LEVEL_RANK: Readonly<
  Record<GitHubCheckAnnotationLevel, number>
> = {
  notice: 0,
  warning: 1,
  failure: 2,
};

/** Every level, most severe first: the one order RANK declares, read back. */
const ANNOTATION_LEVELS_BY_SEVERITY: readonly GitHubCheckAnnotationLevel[] = (
  Object.keys(ANNOTATION_LEVEL_RANK) as GitHubCheckAnnotationLevel[]
).sort((a, b) => ANNOTATION_LEVEL_RANK[b] - ANNOTATION_LEVEL_RANK[a]);

function normalizeCheckAnnotationLevel(
  level: string | null | undefined,
): GitHubCheckAnnotationLevel {
  if (level === 'warning' || level === 'failure') {
    return level;
  }
  return 'notice';
}

export function includesCheckAnnotationLevel(
  annotationLevel: string | null | undefined,
  minLevel: GitHubCheckAnnotationLevel,
): boolean {
  return (
    ANNOTATION_LEVEL_RANK[normalizeCheckAnnotationLevel(annotationLevel)] >=
    ANNOTATION_LEVEL_RANK[minLevel]
  );
}

export function formatCheckAnnotationLevelList(
  annotations: ReadonlyArray<{ annotation_level?: string | null }>,
): string {
  const levels = new Set(
    annotations.map((annotation) =>
      normalizeCheckAnnotationLevel(annotation.annotation_level),
    ),
  );
  return ANNOTATION_LEVELS_BY_SEVERITY.filter((level) => levels.has(level))
    .map((level) => `[${level.toUpperCase()}]`)
    .join(', ');
}
