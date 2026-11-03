const notes = await import('builtIn:notes');
return { sig: notes.add.toString(), len: notes.add.length };
