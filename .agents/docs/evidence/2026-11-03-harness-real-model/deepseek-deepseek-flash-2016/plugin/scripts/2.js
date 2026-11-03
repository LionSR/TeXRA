const notes = await import('builtIn:notes');
const r1 = await notes.add("Lemma 2 needs a citation.");
const r2 = await notes.add("Section 3 is done.");
return { first: r1, second: r2 };
