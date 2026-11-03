const notes = await import('builtIn:notes');
const citations = await notes.add({ text: "Lemma 2 needs a citation." });
const section3 = await notes.add({ text: "Section 3 is done." });
return { citations, section3 };
