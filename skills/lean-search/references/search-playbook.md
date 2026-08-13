# Lean Search Playbook

Use this playbook when the first obvious search attempt does not find the right API.

## Search order

- Start with type-shape or theorem-name search.
- Search Mathlib source directly when local packages are available.
- Read surrounding source, not just isolated hits.
- Check docs or community references when the local codebase is inconclusive.
- Do not conclude “missing” after a single failed query; reformulate the statement and search again.

## Reporting results

- Distinguish exact match, near match, and missing result.
- Include the full declaration name and import path.
- Explain how a near match needs to be adapted.

## Missing-lemma cases

- Say why the result appears absent.
- Suggest the likely general statement.
- Suggest where such a lemma would naturally live.
