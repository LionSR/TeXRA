/**
 * What a GitHub subscription watches: a whole repository, one pull request or
 * one issue. The path form mirrors GitHub's REST URL shape
 * (`owner/repo`, `owner/repo/pulls/N`, `owner/repo/issues/N`) and is the one
 * string a target is written as: the tool's `path`, the subscription table's
 * key, the settings view's row and every reference in an event message.
 */

// Third-party imports
import { Schema, SchemaGetter } from 'effect';

const RepoFields = { owner: Schema.String, repo: Schema.String };
const NumberedFields = { ...RepoFields, number: Schema.Int };

export const SubscriptionTarget = Schema.TaggedUnion({
  repo: RepoFields,
  pull: NumberedFields,
  issue: NumberedFields,
});

export type SubscriptionTarget = typeof SubscriptionTarget.Type;
export type PullTarget = Extract<SubscriptionTarget, { _tag: 'pull' }>;
export type IssueTarget = Extract<SubscriptionTarget, { _tag: 'issue' }>;
export type RepoTarget = Extract<SubscriptionTarget, { _tag: 'repo' }>;

const TARGET_PATH_RE =
  /^([^/\s]+)\/([^/\s]+)(?:\/(pulls|issues)\/([1-9]\d*))?$/;

const PATH_SEGMENT = { pull: 'pulls', issue: 'issues' } as const;

/** A target from its path form; the path has already matched the pattern. */
function fromPath(path: string): typeof SubscriptionTarget.Encoded {
  const [, owner = '', repo = '', segment, digits] =
    TARGET_PATH_RE.exec(path) ?? [];
  if (segment === undefined) return { _tag: 'repo', owner, repo };
  return {
    _tag: segment === 'pulls' ? 'pull' : 'issue',
    owner,
    repo,
    number: Number(digits),
  };
}

function toPath(target: typeof SubscriptionTarget.Encoded): string {
  const slug = `${target.owner}/${target.repo}`;
  return target._tag === 'repo'
    ? slug
    : `${slug}/${PATH_SEGMENT[target._tag]}/${target.number}`;
}

/** A target as its path string. */
export const SubscriptionTargetPath = Schema.String.check(
  Schema.isPattern(TARGET_PATH_RE),
).pipe(
  Schema.decodeTo(SubscriptionTarget, {
    decode: SchemaGetter.transform(fromPath),
    encode: SchemaGetter.transform(toPath),
  }),
);

/** The path string of a target, e.g. `owner/repo/pulls/42`. */
export const targetPath: (target: SubscriptionTarget) => string =
  Schema.encodeSync(SubscriptionTargetPath);

/** How messages name each kind of target. */
export const TARGET_LABEL: Readonly<
  Record<SubscriptionTarget['_tag'], string>
> = { pull: 'PR', issue: 'Issue', repo: 'Repo' };
