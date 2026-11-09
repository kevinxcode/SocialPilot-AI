import Dexie, { type Table } from 'dexie';
import type {
  AIModel,
  AIUsage,
  Account,
  ActivityLog,
  Brand,
  BrandKnowledge,
  ContentIdea,
  MediaItem,
  Post,
  ProviderStatus,
  QueueItem,
} from '@/types/models';
import { uid } from '@/lib/utils';

export class SocialPilotDB extends Dexie {
  brands!: Table<Brand, string>;
  knowledge!: Table<BrandKnowledge, string>;
  providers!: Table<ProviderStatus, string>;
  models!: Table<AIModel, string>;
  accounts!: Table<Account, string>;
  media!: Table<MediaItem, string>;
  ideas!: Table<ContentIdea, string>;
  posts!: Table<Post, string>;
  queue!: Table<QueueItem, string>;
  aiUsage!: Table<AIUsage, string>;
  logs!: Table<ActivityLog, string>;

  constructor() {
    super('socialpilot');
    this.version(1).stores({
      brands: 'id, name',
      knowledge: 'id, brandId',
      providers: 'id',
      models: 'key, providerId',
      accounts: 'id, platform',
      media: 'id, createdAt, lastUsedAt, *tags, category',
      ideas: 'id, brandId, createdAt',
      posts: 'id, status, scheduledAt, platform, fingerprint, createdAt, publishedAt',
      queue: 'id, runAt, postId, slotKey, platform',
      aiUsage: 'id, at, providerId, purpose',
      logs: 'id, at, level',
    });
  }
}

export const db = new SocialPilotDB();

export const TABLES = [
  'brands',
  'knowledge',
  'providers',
  'models',
  'accounts',
  'media',
  'ideas',
  'posts',
  'queue',
  'aiUsage',
  'logs',
] as const;
export type TableName = (typeof TABLES)[number];

export async function resetDb(): Promise<void> {
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) await db.table(t).clear();
  });
}

export async function log(level: ActivityLog['level'], scope: string, message: string): Promise<void> {
  await db.logs.add({ id: uid(), at: Date.now(), level, scope, message });
}

export const CUCIQU_SEED: Omit<Brand, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'CuciQu Pro',
  website: 'https://cuciqu.com/',
  affiliateUrl: 'https://app.cuciqu.com/',
  industry: 'Laundry Management Software',
  description:
    'A mobile cashier and laundry management application that helps laundry businesses manage transactions, orders, employees, and operations.',
  products: 'CuciQu Pro — aplikasi kasir dan manajemen laundry berbasis mobile.',
  features: 'Manajemen transaksi, pesanan, karyawan, dan operasional laundry.',
  pricing: '',
  audience: 'Laundry owners, laundry entrepreneurs, multi-outlet laundry businesses, laundry operators.',
  voice: 'Ramah, praktis, membantu; bahasa Indonesia sehari-hari yang profesional.',
  strategy: 'Edukasi masalah operasional laundry, lalu tunjukkan bagaimana CuciQu Pro membantu.',
  cta: 'Coba CuciQu Pro di https://app.cuciqu.com/',
  prohibitedClaims:
    'Jangan menyebut harga, diskon, statistik, jumlah pengguna, testimoni, atau fitur yang tidak tercantum di knowledge base.',
};

export async function seedIfEmpty(): Promise<void> {
  await db.transaction('rw', db.brands, async () => {
    if ((await db.brands.count()) > 0) return;
    const now = Date.now();
    await db.brands.add({ ...CUCIQU_SEED, id: uid(), createdAt: now, updatedAt: now });
  });
}
