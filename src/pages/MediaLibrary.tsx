import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { FolderOpen, Loader2, Trash2, Upload } from 'lucide-react';
import { Badge, Button, Card, Dialog, Empty, Input, Select, useToast } from '@/components/ui';
import { db } from '@/services/storage/db';
import { importFiles } from '@/services/media/importer';
import type { MediaItem } from '@/types/models';

export const SUGGESTED_FOLDER = 'C:\\locale\\intelij\\londy-artifacts-marketing\\app-marketing';

export function MediaThumb({ m, className }: { m: MediaItem; className?: string }) {
  const [url, setUrl] = useState<string | undefined>(m.thumb);
  useEffect(() => {
    if (m.thumb || !m.type.startsWith('image/')) return;
    const u = URL.createObjectURL(m.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [m]);
  if (m.type.startsWith('video/')) return <div className={`flex items-center justify-center bg-muted text-xs ${className}`}>🎬 video</div>;
  return url ? <img src={url} alt={m.name} className={`object-cover ${className}`} loading="lazy" /> : <div className={`bg-muted ${className}`} />;
}

const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const EMPTY_MEDIA: MediaItem[] = [];

export function MediaLibraryPage() {
  const toast = useToast();
  const media = useLiveQuery(() => db.media.orderBy('createdAt').reverse().toArray(), []) ?? EMPTY_MEDIA;
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [usage, setUsage] = useState<'' | 'used' | 'unused'>('');
  const [busy, setBusy] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [edit, setEdit] = useState<MediaItem | null>(null);
  const [tagText, setTagText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => [...new Set(media.map((m) => m.category).filter(Boolean))] as string[], [media]);
  const filtered = media.filter((m) => {
    const hay = `${m.name} ${m.tags.join(' ')} ${m.category ?? ''}`.toLowerCase();
    return (
      (!q || q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) &&
      (!category || m.category === category) &&
      (!usage || (usage === 'used' ? m.usedCount > 0 : m.usedCount === 0))
    );
  });

  const doImport = async (input: File[] | FileSystemDirectoryHandle) => {
    setBusy(0);
    try {
      const r = await importFiles(input, setBusy);
      toast(`Imported ${r.added} · duplicates ${r.duplicates} · skipped ${r.skipped}`);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'err');
    } finally {
      setBusy(null);
    }
  };
  const pickFolder = async () => {
    const w = window as Window & { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> };
    if (!w.showDirectoryPicker) return fileRef.current?.click();
    try {
      await doImport(await w.showDirectoryPicker({ id: 'media', mode: 'read' }));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'err');
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files: File[] = [];
    const dirs: FileSystemDirectoryHandle[] = [];
    for (const it of Array.from(e.dataTransfer.items)) {
      const h = await (it as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.();
      if (h?.kind === 'directory') dirs.push(h as FileSystemDirectoryHandle);
      else {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) await doImport(files);
    for (const d of dirs) await doImport(d);
  };

  return (
    <div className="space-y-4">
      <Card
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        className={drag ? 'border-2 border-dashed border-primary' : ''}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={pickFolder} disabled={busy !== null}>
            {busy !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
            {busy !== null ? `Importing… ${busy}` : 'Import folder'}
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy !== null}>
            <Upload className="h-4 w-4" /> Add files
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,video/*"
            hidden
            onChange={(e) => e.target.files && doImport(Array.from(e.target.files))}
          />
          <div className="ml-auto flex gap-2">
            {filtered.length > 0 && filtered.length < media.length && (
              <Button
                variant="outline"
                onClick={async () => {
                  if (!confirm(`Delete the ${filtered.length} items shown by the current filter?`)) return;
                  await db.media.bulkDelete(filtered.map((m) => m.id));
                  toast(`Deleted ${filtered.length} items`);
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete shown ({filtered.length})
              </Button>
            )}
            {media.length > 0 && (
              <Button
                variant="outline"
                className="text-red-500"
                onClick={async () => {
                  if (!confirm(`Remove ALL ${media.length} items from the media library? Files on your computer are not touched.`)) return;
                  await db.media.clear();
                  toast('Media library cleared');
                }}
              >
                <Trash2 className="h-4 w-4" /> Clear all
              </Button>
            )}
          </div>
          <span className="w-full text-xs text-muted-foreground">
            or drag & drop files/folders here. Suggested folder: <code>{SUGGESTED_FOLDER}</code>
          </span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_200px_160px]">
          <Input placeholder="Search name or tag…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="">All folders</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <Select value={usage} onChange={(e) => setUsage(e.target.value as typeof usage)} aria-label="Usage">
            <option value="">Used & unused</option>
            <option value="unused">Unused</option>
            <option value="used">Used</option>
          </Select>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Empty>{media.length ? 'No media matches the filters.' : 'No media yet. Import your marketing folder to start.'}</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              className="overflow-hidden rounded-lg border border-border bg-card text-left hover:ring-2 hover:ring-primary"
              onClick={() => {
                setEdit(m);
                setTagText(m.tags.join(', '));
              }}
            >
              <MediaThumb m={m} className="h-32 w-full" />
              <div className="space-y-1 p-2">
                <div className="truncate text-xs font-medium" title={m.name}>
                  {m.name}
                </div>
                {m.category && (
                  <div className="truncate text-[11px] text-primary" title={m.category}>
                    📁 {m.category}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                  {m.width ? `${m.width}×${m.height}` : ''} · {fmtSize(m.size)}
                  {m.usedCount > 0 ? <Badge tone="info">used {m.usedCount}×</Badge> : <Badge tone="success">unused</Badge>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.name ?? ''}>
        {edit && (
          <div className="space-y-3">
            <MediaThumb m={edit} className="max-h-64 w-full rounded-md object-contain" />
            <div className="text-xs text-muted-foreground">
              {edit.type} · {fmtSize(edit.size)} {edit.width ? `· ${edit.width}×${edit.height}` : ''} · folder {edit.category ?? '—'}
            </div>
            <Input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="tags, comma separated" aria-label="Tags" />
            <div className="flex justify-between">
              <Button
                variant="destructive"
                onClick={async () => {
                  await db.media.delete(edit.id);
                  setEdit(null);
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
              <Button
                onClick={async () => {
                  await db.media.update(edit.id, {
                    tags: [...new Set(tagText.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))],
                  });
                  setEdit(null);
                }}
              >
                Save tags
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
