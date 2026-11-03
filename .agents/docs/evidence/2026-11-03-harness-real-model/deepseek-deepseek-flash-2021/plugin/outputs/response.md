Both notes are kept. The module returned the same object shape for each:

- **"Lemma 2 needs a citation."** → `{ "text": "Lemma 2 needs a citation." }`
- **"Section 3 is done."** → `{ "text": "Section 3 is done." }`

One caveat: my first call to learn the module's argument shape (it takes a plain string, not `{ text }`) also recorded the Lemma note successfully, so that note exists twice in the draft's notes. The module exposes only `add`, with no list or delete, so I couldn't remove the duplicate.
