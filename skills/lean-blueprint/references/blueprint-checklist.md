# Lean Blueprint Checklist

Use this checklist when authoring or syncing a blueprint against a Lean project.

## Project survey

- Read both the blueprint files and the Lean declarations they reference.
- Identify the main results, the dependency DAG, and the current formalization status.

## Writing

- Write the prose as standard mathematics, not as Lean syntax with punctuation.
- Use conventional notation whenever possible.
- Keep proof sketches strategic and human-readable.

## Syncing

- Verify each linked Lean declaration still exists and still states the same mathematics.
- Update formalization-status markers only after checking the real code.
- Check for declaration drift in both directions: missing blueprint entries and stale references.

## Dependencies

- Keep dependency annotations explicit and accurate.
- Remove spurious dependencies that hide parallelism.
- Flag circular mathematical dependencies, not just syntactic graph issues.
