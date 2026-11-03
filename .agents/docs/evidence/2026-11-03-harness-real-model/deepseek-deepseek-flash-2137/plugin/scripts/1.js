const notes = await import('builtIn:notes');
const mem = await tools.memory ? null : null;
return { keys: Object.keys(notes) };
