const [mem, found] = await Promise.all([
  tools.memory({ command: 'view' }),
  searchTools('notes draft note_add module', { limit: 10 })
]);
return { mem, found };
