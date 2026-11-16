import { Schema } from 'effect';

/** GitHub's check-annotation levels, most severe first. */
export const GitHubCheckAnnotationLevelSchema = Schema.Literals([
  'failure',
  'warning',
  'notice',
]);

export type GitHubCheckAnnotationLevel =
  typeof GitHubCheckAnnotationLevelSchema.Type;

export const DEFAULT_CHECK_ANNOTATION_LEVEL: GitHubCheckAnnotationLevel =
  'failure';

const LEVELS_BY_SEVERITY = GitHubCheckAnnotationLevelSchema.literals;
const isCheckAnnotationLevel = Schema.is(GitHubCheckAnnotationLevelSchema);

/** Unknown or missing levels read as GitHub's own default, `notice`. */
export function normalizeCheckAnnotationLevel(
  level: string | null | undefined,
): GitHubCheckAnnotationLevel {
  return isCheckAnnotationLevel(level) ? level : 'notice';
}

export function includesCheckAnnotationLevel(
  annotationLevel: string | null | undefined,
  minLevel: GitHubCheckAnnotationLevel,
): boolean {
  return (
    LEVELS_BY_SEVERITY.indexOf(
      normalizeCheckAnnotationLevel(annotationLevel),
    ) <= LEVELS_BY_SEVERITY.indexOf(minLevel)
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
  return LEVELS_BY_SEVERITY.filter((level) => levels.has(level))
    .map((level) => `[${level.toUpperCase()}]`)
    .join(', ');
}
