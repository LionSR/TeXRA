const notes = await import('builtIn:notes');
const first = await notes.add('Lemma 2 needs a citation.');
const second = await notes.add('Section 3 is done.');
return { first, second };
