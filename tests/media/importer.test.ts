
test('isMediaFile rejects TypeScript files that Windows labels video/mp2t', async () => {
  const { isMediaFile } = await import('@/services/media/importer');
  expect(isMediaFile({ name: 'storyboard.ts', type: 'video/mp2t' })).toBe(false);
  expect(isMediaFile({ name: 'a.png', type: 'image/png' })).toBe(true);
  expect(isMediaFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe(true);
});
