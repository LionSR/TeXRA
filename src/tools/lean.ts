/**
 * Lean 4 theorem prover tools.
 *
 * This module provides two categories of tools:
 *
 * CLI Tools (simple, stateless):
 * - lean_check: Check a file for errors by running the Lean compiler
 * - lake_build: Build a project using Lake
 * - lean_goal: Extract goal state from compiler output
 *
 * LSP Tools (rich, uses language server):
 * - lean_lsp_goal: Real-time goal state via language server
 * - lean_hover: Hover documentation and type info
 * - lean_completions: Auto-completion suggestions
 * - lean_term_goal: Term-mode expected types
 *
 * The LSP tools require starting `lake serve` and maintain a persistent
 * connection for faster subsequent queries.
 */

// Re-export everything from the lean module
export * from './lean/index';
