const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
  import('@platform/platform'),
  import('./FakePlatform'),
]);
initPlatform(createFakePlatform());

export {};
