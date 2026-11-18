import { stripLinks } from '@/services/content/noLinks';

test('removes URLs and dangling "di"/"kunjungi" leftovers', () => {
  expect(stripLinks('Coba CuciQu Pro di https://app.cuciqu.com/\n#CuciQuPro')).toBe('Coba CuciQu Pro\n#CuciQuPro');
  expect(stripLinks('Info: www.cuciqu.com sekarang!')).toBe('Info: sekarang!');
  expect(stripLinks('Kunjungi cuciqu.com untuk demo.')).toBe('Kunjungi untuk demo.');
  expect(stripLinks('Tanpa link, 5.000 outlet.')).toBe('Tanpa link, 5.000 outlet.');
});

test('a URL mid-sentence takes its "di"/"at" with it (no "di dan" leftovers)', () => {
  expect(stripLinks('Coba CuciQu Pro di https://app.cuciqu.com/ dan rasakan kemudahannya!')).toBe('Coba CuciQu Pro dan rasakan kemudahannya!');
  expect(stripLinks('Coba CuciQu Pro sekarang di https://app.cuciqu.com/ dan pantau.')).toBe('Coba CuciQu Pro sekarang dan pantau.');
});

test('literal backslash-n left in older queued posts becomes a real line break', () => {
  expect(stripLinks('Yakin mesin ready?\\n\\nPantau real-time.')).toBe('Yakin mesin ready?\n\nPantau real-time.');
});
