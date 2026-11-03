const notes = await import('builtIn:notes');
const attempts = [];
for (const arg of ["Lemma 2 needs a citation."]) {
  try { attempts.push({ arg, ok: await notes.add(arg) }); }
  catch (e) { attempts.push({ arg, err: String(e && e.message || e) }); }
}
return attempts;
