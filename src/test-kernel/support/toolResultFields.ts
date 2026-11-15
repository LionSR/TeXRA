/** A tool result's fields by its status, for assertions on a result whose
 *  status the test did not narrow: the absent field reads `undefined`. */
type Result =
  | { readonly status: 'executed'; readonly output?: string | undefined }
  | { readonly status: 'error'; readonly error: string };

/** The output of an executed result. */
export const outputOf = (result: Result | undefined): string | undefined =>
  result?.status === 'executed' ? result.output : undefined;

/** The message of a failed result. */
export const errorOf = (result: Result | undefined): string | undefined =>
  result?.status === 'error' ? result.error : undefined;
