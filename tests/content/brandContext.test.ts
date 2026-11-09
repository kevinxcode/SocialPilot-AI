import { buildBrandContext, allowedFacts, extractFacts } from '@/services/content/brandContext';
import { db, resetDb, CUCIQU_SEED } from '@/services/storage/db';

beforeEach(async () => {
  await resetDb();
  await db.brands.add({ ...CUCIQU_SEED, id: 'b1', pricing: 'Paket Pro Rp 99.000/bulan, hemat 50% untuk 3 outlet', createdAt: 0, updatedAt: 0 });
  await db.knowledge.add({ id: 'k1', brandId: 'b1', title: 'Fitur', content: 'Laporan harian otomatis jam 21.00', createdAt: 0 });
});

test('context includes brand facts, knowledge and prohibited claims', async () => {
  const ctx = await buildBrandContext('b1');
  expect(ctx).toContain('CuciQu Pro');
  expect(ctx).toContain('https://cuciqu.com/');
  expect(ctx).toContain('Laporan harian otomatis');
  expect(ctx).toContain(CUCIQU_SEED.prohibitedClaims);
  expect(ctx).toMatch(/never invent prices, features, statistics or testimonials/i);
});

test('allowedFacts extracts prices, percentages and numbers from KB', async () => {
  const f = await allowedFacts('b1');
  expect(f.has('rp99000')).toBe(true);
  expect(f.has('50%')).toBe(true);
  expect(f.has('3')).toBe(true);
});

test('extractFacts normalises price formats', () => {
  expect([...extractFacts('Hanya Rp99.000! atau IDR 99,000 atau Rp 1,5 juta dan 20% off')].sort()).toEqual(
    ['20%', 'rp1500000', 'rp99000'].sort(),
  );
});
