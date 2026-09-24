---
name: lean-blueprint
description: Create and maintain Lean blueprint documents that connect informal mathematics to Lean 4 formalization. Use when Codex needs to draft or sync blueprint entries, map paper results to Lean declarations, track dependencies between statements, or keep blueprint prose aligned with a changing Lean codebase.
---

# Lean Blueprint

## When to use this skill

Use this skill for blueprint authoring and maintenance: writing new dependency-tracked blueprint content, syncing an existing blueprint with Lean declarations, or translating Lean formalization progress into human-readable mathematical prose.

## Workflow

1. Survey the Lean project and the existing blueprint files before writing anything. Understand the mathematical architecture and the current formalization status first.
2. Build or repair the dependency graph from the main results backward. Each node should be a meaningful unit of work for a contributor.
3. Use the blueprint macros deliberately:
   - `\lean{Namespace.decl}` to link to Lean declarations
   - `\leanok` only when the declaration is actually formalized and clean
   - `\uses{label1,label2}` for dependency tracking
   - `\notready` for items that still need blueprint work
   - `\proves{label}` when a proof block is separated from its statement
4. Write blueprint prose as mathematics, not as disguised Lean syntax. Use conventional notation and let the Lean linkage live in the explicit blueprint macros.
5. When a declaration exists, verify its name, status, and statement before marking blueprint entries as formalized.
6. Keep blueprint statements, proof sketches, and dependency annotations synchronized with the real Lean codebase.
7. Check for drift in both directions: Lean declarations missing from the blueprint, and blueprint entries that no longer match Lean.
8. Treat the blueprint as a human coordination document first and a status mirror second.

## Quality Bar

- Blueprint prose should read like normal mathematical writing.
- Never let Lean identifiers leak into the prose body when standard notation exists.
- Dependencies should be explicit and accurate enough to support parallel work.
- Formalized status markers should reflect reality, not aspiration.
- Statement mismatches between blueprint and Lean are real bugs, not cosmetic issues.
- A reader should be able to understand the mathematical roadmap without reading Lean source first.

For new blueprint skeletons or drift audits, use [references/blueprint-checklist.md](references/blueprint-checklist.md) to check dependency tracking, statement syncing, and notation translation.
