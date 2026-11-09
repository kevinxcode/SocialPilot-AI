import { stripLinks } from '@/services/content/noLinks';

test('removes URLs and dangling "di"/"kunjungi" leftovers', () => {
  expect(stripLinks('Coba CuciQu Pro di https://app.cuciqu.com/\n#CuciQuPro')).toBe('Coba CuciQu Pro\n#CuciQuPro');
  expect(stripLinks('Info: www.cuciqu.com sekarang!')).toBe('Info: sekarang!');
  expect(stripLinks('Kunjungi cuciqu.com untuk demo.')).toBe('Kunjungi untuk demo.');
  expect(stripLinks('Tanpa link, 5.000 outlet.')).toBe('Tanpa link, 5.000 outlet.');
});
