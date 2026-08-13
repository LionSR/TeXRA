---
name: lean-search
description: Find existing Lean 4 and Mathlib lemmas, APIs, imports, and formalization patterns. Use when Codex needs to answer whether a result already exists, locate the right theorem or module, understand how Mathlib formalizes a concept, or avoid duplicate formalization work.
---

# Lean Search

## When to use this skill

Use this skill when the main job is discovery rather than proving: find the right lemma, import, namespace, declaration name, or formalization pattern before writing code.

## Workflow

1. Start from the mathematical content, not from a guessed theorem name.
2. Search broadly and iteratively. Try multiple surfaces before concluding something is missing: type-shape search, name-pattern search, source grep, module-path discovery, and docs or community references.
3. Read the actual source around promising hits. The surrounding lemmas and proof patterns often matter more than the first exact match.
4. Distinguish exact matches, adaptable near-matches, and genuinely missing API.
5. When something appears missing, say where it would likely belong and what the most general statement should be.
6. Report enough metadata to make the result usable immediately: full name, import path, statement shape, and any caveats.
7. Show your search process briefly so another formalizer can trust the conclusion and continue from it.

## Quality Bar

- Prevent duplicate work whenever possible.
- Do not stop after one search method fails.
- Prefer Mathlib's general result over a project-specific reproving of the same fact.
- Show what you searched and what you found so the answer is auditable.
- When uncertain, provide the best nearby API and explain the gap.

For hard-to-find results, use [references/search-playbook.md](references/search-playbook.md) to run a more disciplined search across theorem names, type shapes, source files, and import paths.
