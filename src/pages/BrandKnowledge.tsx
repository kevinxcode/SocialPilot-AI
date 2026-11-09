import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, CardTitle, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db, CUCIQU_SEED } from '@/services/storage/db';
import { uid } from '@/lib/utils';
import type { Brand } from '@/types/models';

const FIELDS: { key: keyof Brand; label: string; long?: boolean }[] = [
  { key: 'name', label: 'Brand name' },
  { key: 'website', label: 'Website URL' },
  { key: 'affiliateUrl', label: 'Affiliate / sign-up URL' },
  { key: 'industry', label: 'Industry' },
  { key: 'description', label: 'Brand description', long: true },
  { key: 'products', label: 'Product information', long: true },
  { key: 'features', label: 'Features', long: true },
  { key: 'pricing', label: 'Pricing (leave empty if prices must never be mentioned)', long: true },
  { key: 'audience', label: 'Target audience', long: true },
  { key: 'voice', label: 'Brand voice', long: true },
  { key: 'strategy', label: 'Marketing strategy', long: true },
  { key: 'cta', label: 'Call to action', long: true },
  { key: 'prohibitedClaims', label: 'Prohibited claims', long: true },
];

export function BrandKnowledgePage() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const brands = useLiveQuery(() => db.brands.orderBy('name').toArray(), []) ?? [];
  const activeId = settings?.activeBrandId && brands.some((b) => b.id === settings.activeBrandId) ? settings.activeBrandId : brands[0]?.id;
  const [draft, setDraft] = useState<Brand | null>(null);
  const knowledge = useLiveQuery(() => (activeId ? db.knowledge.where('brandId').equals(activeId).toArray() : []), [activeId]) ?? [];
  const [kTitle, setKTitle] = useState('');
  const [kContent, setKContent] = useState('');

  useEffect(() => {
    const b = brands.find((x) => x.id === activeId);
    setDraft(b ? { ...b } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, brands.length]);

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return toast('Brand name is required', 'err');
    await db.brands.put({ ...draft, updatedAt: Date.now() });
    toast('Brand saved');
  };
  const addBrand = async () => {
    const id = uid();
    const now = Date.now();
    await db.brands.add({
      ...Object.fromEntries(Object.keys(CUCIQU_SEED).map((k) => [k, ''])),
      name: 'New brand',
      id,
      createdAt: now,
      updatedAt: now,
    } as Brand);
    await update({ activeBrandId: id });
  };
  const removeBrand = async () => {
    if (!draft || brands.length <= 1) return toast('At least one brand is required', 'err');
    if (!confirm(`Delete brand "${draft.name}" and its knowledge entries?`)) return;
    await db.transaction('rw', db.brands, db.knowledge, async () => {
      await db.knowledge.where('brandId').equals(draft.id).delete();
      await db.brands.delete(draft.id);
    });
    await update({ activeBrandId: undefined });
  };
  const addKnowledge = async () => {
    if (!activeId || !kTitle.trim() || !kContent.trim()) return;
    await db.knowledge.add({ id: uid(), brandId: activeId, title: kTitle.trim(), content: kContent.trim(), createdAt: Date.now() });
    setKTitle('');
    setKContent('');
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Field label="Active brand">
            <Select value={activeId ?? ''} onChange={(e) => update({ activeBrandId: e.target.value })}>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button variant="outline" onClick={addBrand}>
          <Plus className="h-4 w-4" /> New brand
        </Button>
        <Button variant="ghost" onClick={removeBrand} disabled={brands.length <= 1}>
          <Trash2 className="h-4 w-4" /> Delete brand
        </Button>
      </Card>

      {draft && (
        <Card>
          <CardTitle>Brand profile</CardTitle>
          <p className="mb-3 text-xs text-muted-foreground">
            AI uses only these facts. Numbers, prices and percentages that are not written here will be rejected by the claim check.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key} className={f.long ? 'md:col-span-2' : ''}>
                <Field label={f.label}>
                  {f.long ? (
                    <Textarea
                      rows={2}
                      value={(draft[f.key] as string | undefined) ?? ''}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                  ) : (
                    <Input value={(draft[f.key] as string | undefined) ?? ''} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                  )}
                </Field>
              </div>
            ))}
          </div>
          <Button className="mt-3" onClick={save}>
            Save brand
          </Button>
        </Card>
      )}

      <Card>
        <CardTitle>
          Knowledge entries <Badge>{knowledge.length}</Badge>
        </CardTitle>
        <div className="mb-3 grid gap-2 md:grid-cols-[1fr_2fr_auto]">
          <Input placeholder="Title (e.g. FAQ: multi-outlet)" value={kTitle} onChange={(e) => setKTitle(e.target.value)} />
          <Textarea rows={1} placeholder="Fact or note" value={kContent} onChange={(e) => setKContent(e.target.value)} />
          <Button onClick={addKnowledge} disabled={!kTitle.trim() || !kContent.trim()}>
            Add
          </Button>
        </div>
        <ul className="divide-y divide-border">
          {knowledge.map((k) => (
            <li key={k.id} className="flex items-start justify-between gap-3 py-2 text-sm">
              <div>
                <div className="font-medium">{k.title}</div>
                <div className="whitespace-pre-wrap text-muted-foreground">{k.content}</div>
              </div>
              <Button variant="ghost" size="icon" aria-label={`Delete ${k.title}`} onClick={() => db.knowledge.delete(k.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export async function getActiveBrandId(activeBrandId?: string): Promise<string | undefined> {
  if (activeBrandId && (await db.brands.get(activeBrandId))) return activeBrandId;
  return (await db.brands.orderBy('name').first())?.id;
}
