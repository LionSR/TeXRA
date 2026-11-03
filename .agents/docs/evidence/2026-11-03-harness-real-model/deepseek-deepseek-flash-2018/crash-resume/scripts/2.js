const t = await self({ fork: false, prompt: "Reply with the single word: ok", label: "probe" });
console.log(typeof t.response, JSON.stringify(t.response).slice(0, 200));
return { probe: t.response };
