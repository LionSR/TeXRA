# Tactic Ledger Protocol

The tactic ledger is the persistent memory of a Lean project's automation. It lives in the project's `AGENTS.md` so that every agent session, regardless of harness, reads it at startup and inherits earlier extractions instead of rederiving them. Never replace a distinct `CLAUDE.md` with a link: preserve its contents and add a pointer to the `AGENTS.md` ledger, or leave it unchanged when both paths already identify the same file.

## Ledger format

Keep one section, one table, one line per entry:

```markdown
## Lean tactic ledger

Read this before writing proofs; prefer these over inline tactic chains.
When a pattern recurs three times, extract it (see lean-tactic-improver)
and add it here. Prune entries whose automation is removed.

| Name                   | Kind           | Use when                                              | Defined in                 |
| ---------------------- | -------------- | ----------------------------------------------------- | -------------------------- |
| `norm_bound`           | tactic macro   | closing `‖A x‖ ≤ C * ‖x‖` goals for bounded operators | `Project/Tactic.lean`      |
| `proj_simp`            | simp set       | reducing compositions of projections `P i * P j`      | `Project/Attr.lean`        |
| `Foo`                  | aesop rule set | membership/subset goals in the `Foo` lattice          | `Project/Attr.lean`        |
| `sum_swap_of_summable` | lemma          | interchanging double sums under summability           | `Project/Summability.lean` |
```

Rules:

- One line per entry; the "use when" column is the searchable part. Describe the goal shape, not the implementation.
- Record only automation with three or more real call sites. Single-use helpers are ordinary lemmas and do not belong in the ledger.
- Deleting automation means deleting its ledger row in the same change.
- If the project has an `AGENTS.md` convention already (sections, ordering), fit into it rather than imposing this layout.

## Standalone consumer fallback

Consumers should use the lean-tactic-improver workflow when the skill is available. When skill discovery is unavailable, use this minimal fallback: on the third occurrence, extract the lowest sufficient project-native abstraction without adding a framework solely for automation; rewrite the motivating call sites; add a `Name | Kind | Use when | Defined in` row to the canonical `AGENTS.md` tactic ledger, creating it if needed; if `CLAUDE.md` exists, preserve its contents and add a pointer to the `AGENTS.md` ledger unless both paths already identify the same file; and prune rows whose automation is removed.

## The abstraction ladder

Extract at the cheapest rung that eliminates the repetition. Each rung costs more to build, review, and maintain than the one before it.

1. **Helper lemma.** The default. A recurring goal shape usually means a missing lemma with the right statement. Search Mathlib first because the lemma often exists.
2. **`@[simp]` lemma or named simp set.** When the repetition is "the same rewrites over and over". Prefer a named set for domain-specific normal forms:

   ```lean
   -- Project/Attr.lean: dependency-light registration, imported early
   register_simp_attr proj_simp

   -- Project/Projection.lean: domain lemma, beside the definition of P
   @[proj_simp] theorem P_mul_P (i j : ι) : P i * P j = if i = j then P i else 0 := ...
   -- call sites: simp [proj_simp]   (or: simp only [proj_simp])
   ```

   Reserve global `@[simp]` for lemmas that are unconditionally good normal forms everywhere in the project.

3. **Aesop rule set.** When the project already depends on Aesop and the repetition is shallow search (membership, subsets, positivity-style side goals) rather than rewriting. Do not add Aesop as an incidental dependency; stay on a lower rung unless that dependency change is explicitly in scope.

   ```lean
   declare_aesop_rule_sets [Foo]
   @[aesop safe apply (rule_sets := [Foo])] theorem mem_bar_of_mem_foo ... := ...
   -- call sites: aesop (rule_sets := [Foo])
   ```

4. **Tactic macro.** When the repetition is a fixed _sequence_ of tactics:

   ```lean
   /-- Close `‖A x‖ ≤ C * ‖x‖` goals for operators built from bounded pieces. -/
   macro "norm_bound" : tactic =>
     `(tactic| (apply norm_le_of_bounded <;> simp [proj_simp] <;> positivity))
   ```

5. **Full `elab` tactic.** Only when the automation must inspect the goal or branch on it. This is rare in application projects; exhaust the rungs above first.

## Extraction checklist

- [ ] The pattern has at least three real occurrences (rule of three). Count them before building anything.
- [ ] Searched Mathlib for existing automation (`simp` lemma families, `positivity`/`gcongr`/`fun_prop` extensions, existing aesop rule sets) before writing project-local machinery.
- [ ] Picked the lowest sufficient ladder rung.
- [ ] Any framework-specific rung is already available in the project; otherwise stayed on a lower rung rather than adding an incidental dependency.
- [ ] Domain-specific automation is colocated with the declarations it uses; only dependency-light shared infrastructure lives in an early-imported automation file. Its docstring states the goal shapes it closes.
- [ ] Rewrote every motivating call site; each got shorter or clearer. Reverted if not.
- [ ] Full project still builds; no distant proof broke from a new simp/aesop attribute.
- [ ] Ledger row added or updated in the canonical `AGENTS.md` ledger; a distinct `CLAUDE.md` preserves its contents and points to that ledger.

## Failure modes to avoid

- **Premature abstraction.** Two occurrences is a coincidence; wait for the third.
- **Simp set pollution.** A broad `@[simp]` lemma can loop, slow the whole build, or break unrelated proofs. Named sets keep the blast radius local.
- **Opaque macros.** If a reviewer cannot guess what `crush` does from its name and docstring, split it or rename it. Automation names should describe the goal shape they close.
- **Ledger rot.** An entry that no longer matches the code is worse than no entry. Curation is part of every extraction pass.
- **Unrecorded automation.** Building a tactic without a ledger row wastes the work. The next session cannot see it, and the linear growth resumes.
