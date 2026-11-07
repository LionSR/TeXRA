/**
 * Where a document task's revisions keep their files in the run's storage
 * (runDir-relative). Revision `n` writes its outputs and its reply under the
 * folder `r{n}/`; the files derived from them sit beside it, under
 * `compile/`, `output/`, `diff/` and `model/`. The folder name is one
 * grammar ({@link RevisionDirSchema}) that renders and parses it, so no
 * other module spells the prefix.
 *
 * Per-run isolation (executions/{id}/...) provides uniqueness;
 * agent/model/round-in-basename tokens are no longer needed.
 */
import { Result, Schema, SchemaTransformation } from 'effect';

import type { FileLocation } from '@texra-ai/harness/schemas';

/** The fixed basename of every workflow output file (no extension). */
export const WORKFLOW_OUTPUT_BASENAME = 'output';

/** A revision folder's name, `r` and the zero-based revision in decimal
 *  digits: `r0`, `r12`. Digits only, so a sign, an exponent or a bare `r`
 *  names no revision. */
const RevisionDirSchema = Schema.TemplateLiteralParser([
  'r',
  Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
    Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString),
  ),
]);

const revisionDir = (revision: number): string =>
  Schema.encodeSync(RevisionDirSchema)(['r', revision]);

/**
 * Drop the leading revision folder of a runDir-relative path; with
 * `round`, only that revision's. Any other path comes back unchanged.
 */
export function stripWorkflowRoundDir(
  relativePath: string,
  round?: number,
): string {
  const [head = '', ...rest] = relativePath.split(/[/\\]/);
  if (rest.length === 0) return relativePath;
  const parsed = Schema.decodeUnknownResult(RevisionDirSchema)(head);
  return Result.isSuccess(parsed) &&
    (round === undefined || parsed.success[1] === round)
    ? relativePath.slice(head.length + 1)
    : relativePath;
}

/**
 * The runDir-relative places of one revision's files: its folder (`dir`),
 * the reply it keeps whole there, and the folders and names of what its
 * steps derive from its outputs.
 */
export function revisionLayout(revision: number) {
  const dir = revisionDir(revision);
  return {
    dir,
    /** The revision's reply, whole, beside its outputs. */
    reply: `${dir}/${WORKFLOW_OUTPUT_BASENAME}.xml`,
    /** The folder latexdiff writes the revision's diffs under. */
    diffDir: `diff/${dir}`,
    /** The compile check's log of the output named `safeName`. */
    compileLog: (safeName: string) => `compile/${dir}_${safeName}.log`,
    /** The folder the compile check builds the output named `safeName` in. */
    compileBuild: (safeName: string) => `compile/build/${dir}/${safeName}`,
    /** A compiled PDF of the revision, at `pdf` within its folder. */
    pdf: (pdf: string) => `output/${dir}/${pdf}`,
    /**
     * Where the revision keeps the model's version of one of its outputs,
     * as extraction wrote it: Accept diffs the accepted file against it, so
     * the model learns what the user changed. The copies live under
     * `model/`, outside the revision folders extraction writes into, so no
     * extracted output can stand at a copy's path. A run-storage output
     * keeps its path within the revision, a workspace output its
     * workspace-relative path; an output outside both keeps none.
     */
    modelCopy: (location: FileLocation): string | undefined => {
      switch (location.kind) {
        case 'runStorage':
          return `model/${dir}/run/${stripWorkflowRoundDir(location.relativePath, revision)}`;
        case 'workspace':
          return `model/${dir}/workspace/${location.relativePath}`;
        case 'external':
          return undefined;
      }
    },
  };
}
