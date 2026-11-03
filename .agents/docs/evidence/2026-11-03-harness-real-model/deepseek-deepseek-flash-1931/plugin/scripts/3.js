const { add } = await import('builtIn:notes');

const first = await add('Lemma 2 needs a citation.');
const second = await add('Section 3 is done.');

return {
  'Lemma 2 needs a citation.': first,
  'Section 3 is done.': second
};
