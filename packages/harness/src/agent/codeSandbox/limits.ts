// The QuickJS limits every guest script runs under, shared by the code
// sandbox host and its worker. This module holds numbers only, so the worker
// bundle stays free of the host-side WASM bytes.

/** Heap a guest script's QuickJS runtime may allocate; past it the script
 *  ends `MemoryExhausted`. */
export const QUICKJS_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
/** Native stack a guest script's QuickJS runtime may use. */
export const QUICKJS_STACK_LIMIT_BYTES = 1 * 1024 * 1024;
/** Most operations one script may have outstanding at once. */
export const MAX_FANOUT = 4096;
/**
 * Total time guest code may run across every step, apart from the wall
 * clock. A loop that never yields would otherwise hold its thread until the
 * whole-run deadline; waiting on the host is not guest time and never counts.
 */
export const GUEST_CPU_BUDGET_MS = 30_000;
/** The run-log tail a script result keeps: its last lines, each one line. */
export const RUN_LOG_MAX_LINES = 80;
/** Characters a kept run-log line holds, its whitespace collapsed; a longer
 *  line is shortened to this length with an ellipsis. */
export const RUN_LOG_MAX_LINE_LENGTH = 500;
