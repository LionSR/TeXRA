/** A settlement's state operations over a JSON document (`runStateFold`). */
import { Result } from 'effect';

import type { StateOperation } from '@shared/schemas';
import { isObject } from '@utils/core';

/** One state operation over a JSON document, immutably. */
export function mutate(
  node: unknown,
  path: readonly string[],
  op: StateOperation,
): Result.Result<unknown, string> {
  if (!isObject(node)) {
    return Result.fail(`path ${op.path.join('.')} crosses a non-object`);
  }
  const [key, ...rest] = path;
  if (key === undefined) return Result.fail('empty path');
  if (rest.length > 0) {
    if (!Object.hasOwn(node, key)) {
      return Result.fail(`path ${op.path.join('.')} names no ${key}`);
    }
    return Result.map(mutate(node[key], rest, op), (child) => ({
      ...node,
      [key]: child,
    }));
  }
  return Result.succeed({ ...node, [key]: op.value });
}
