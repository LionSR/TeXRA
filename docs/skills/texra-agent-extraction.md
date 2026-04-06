# Extracting Codex Skills from TeXRA Agents

This repo now contains standalone Codex skills under `skills/` that were distilled from TeXRA agent prompts. They are versioned here for reuse, but they are not wired into TeXRA itself.

## Extraction rules

- Preserve reusable expertise: workflow, heuristics, quality bars, and common failure modes.
- Remove TeXRA transport details: template variables, XML wrappers, round mechanics, file-routing variants, and TeXRA-only tool names.
- Rewrite instructions in Codex-native terms: inspect the workspace, compile and verify output, browse for sources when needed, and produce deliverables directly.
- Prefer one skill per durable job, not one skill per source YAML file.
- Keep `SKILL.md` concise. Move long checklists into `references/`.

## First-wave mapping

- `scientific-presenter`
  - `reference-agents/presenter.yaml`
  - `resources/tool_use_agents/presenter.yaml`
- `literature-search`
  - `reference-agents/search.yaml`
- `scientific-simplifier`
  - `reference-agents/simplifier.yaml`
- `manuscript-review`
  - `resources/tool_use_agents/review.yaml`
  - `reference-agents/criticize.yaml`
  - `reference-agents/verifyFix.yaml`
- `tikz-figure-author`
  - `resources/agents/draw.yaml`
- `math-ocr`
  - `resources/agents/ocr.yaml`

## Lean skill mapping

- `lean-proof-assistant`
  - `resources/tool_use_agents/lean.yaml`
- `lean-search`
  - `reference-agents/Lean4/leanSearch.yaml`
- `lean-simplifier`
  - `reference-agents/Lean4/leanSimplifier.yaml`
- `lean-blueprint`
  - `reference-agents/Lean4/leanBlueprint.yaml`

## Deferred sources

- `reference-agents/orchestrator.yaml`
- all `_multiple` variants
- `apply*`
- `merge*`
- `generic`
- `correct`
- `polish`
- `transcribe_audio`

These were deferred because they are either TeXRA-orchestration specific, mostly file-routing variants, or too generic to make strong standalone Codex skills in the first pass.
