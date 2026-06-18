/**
 * Shared Result type — a discriminated union for operations that can fail
 * without throwing. Replaces per-module `{ ok: true; ... } | { ok: false; ... }`
 * declarations with a single canonical shape.
 *
 * Use `ok(value)` / `err(error)` as constructors; branch on `result.ok`.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };

/** `Result<T, E>` — either a successful value or a typed error. */
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
