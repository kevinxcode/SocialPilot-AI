import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { formatInTimeZone } from 'date-fns-tz';
import { CalendarClock, ImagePlus, Send, Upload } from 'lucide-react';
import { useRef } from 'react';
import { importFiles } from '@/services/media/importer';
import { Badge, Button, Dialog, Field, Input, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { createDraft } from '@/services/publishing/posts';
import { schedulePost, zonedToUtc } from '@/services/publishing/PublishingQueue';
import { sendToSw } from '@/background/messages';
import type { Platform } from '@/types/models';
import { MediaThumb } from './MediaLibrary';
import { platformLabel } from '@/lib/platform';

export interface PostActionsProps {
  text: string;
  platform: Platform;
  brandId: string;
  title?: string;
  contentType?: string;
  groupId?: string;
  disabled?: boolean;
  onDone?: () => void;
}

export const toZonedInput = (ms: number, tz: string) => formatInTimeZone(ms, tz, "yyyy-MM-dd'T'HH:mm");

export function MediaPicker({ value, onChange, max = 4 }: { value: string[]; onChange: (ids: string[]) => void; max?: number }) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const before = new Set((await db.media.toArray()).map((m) => m.id));
    await importFiles(Array.from(files));
    const added = (await db.media.orderBy('createdAt').toArray()).filter((m) => !before.has(m.id) && m.type.startsWith('image/'));
    onChange([...value, ...added.map((m) => m.id)].slice(0, max));
    setUploading(false);
  };
  const media = useLiveQuery(() => db.media.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const images = media.filter((m) => m.type.startsWith('image/'));
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <ImagePlus className="h-3.5 w-3.5" /> Media {value.length > 0 && <Badge tone="info">{value.length}</Badge>}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Attach images (max ${max})`}>
        {images.length === 0 ? (
          <p className="text-sm text-muted-foreground">No images in the Media Library yet.</p>
        ) : (
          <div className="grid max-h-96 grid-cols-3 gap-2 overflow-auto">
            {images.map((m) => {
              const sel = value.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={sel}
                  className={`overflow-hidden rounded-md border-2 ${sel ? 'border-primary' : 'border-transparent'}`}
                  onClick={() => onChange(sel ? value.filter((x) => x !== m.id) : value.length < max ? [...value, m.id] : value)}
                >
                  <MediaThumb m={m} className="h-24 w-full" />
                  <div className="truncate px-1 text-[10px]">{m.usedCount ? `used ${m.usedCount}× · ` : ''}{m.name}</div>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-3 flex justify-between gap-2">
          <Button variant="outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Upload from computer'}
          </Button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} />
          <Button onClick={() => setOpen(false)}>Done</Button>
        </div>
      </Dialog>
    </>
  );
}

export function PostActions(p: PostActionsProps) {
  const toast = useToast();
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const account = useLiveQuery(
    async () => (p.platform === 'fbgroup' ? (p.groupId ? db.groups.get(p.groupId) : undefined) : db.accounts.where('platform').equals(p.platform).first()),
    [p.platform, p.groupId],
  );
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(() => toZonedInput(Date.now() + 60 * 60_000, tz));
  const [busy, setBusy] = useState(false);

  const draft = () =>
    createDraft({ platform: p.platform, text: p.text, brandId: p.brandId, title: p.title, contentType: p.contentType, mediaIds, groupId: p.groupId });

  const schedule = async () => {
    const at = zonedToUtc(when, tz);
    if (Number.isNaN(at.getTime())) return toast('Pick a valid date and time', 'err');
    if (at.getTime() < Date.now() - 60_000) return toast('That time is in the past', 'err');
    setBusy(true);
    try {
      const post = await draft();
      await schedulePost(post.id, at);
      toast(`Scheduled for ${when.replace('T', ' ')} (${tz})`);
      setOpen(false);
      p.onDone?.();
    } finally {
      setBusy(false);
    }
  };
  const publishNow = async () => {
    if (!confirm(`Publish this post to ${platformLabel(p.platform)} now?`)) return;
    setBusy(true);
    try {
      const post = await draft();
      const r = await sendToSw({ type: 'publishNow', postId: post.id });
      toast(r.message ?? (r.ok ? 'Started' : 'Failed'), r.ok ? 'ok' : 'err');
      p.onDone?.();
    } finally {
      setBusy(false);
    }
  };

  const blocked = p.disabled || !p.text.trim() || busy;
  return (
    <>
      <MediaPicker value={mediaIds} onChange={setMediaIds} />
      <Button size="sm" variant="secondary" disabled={blocked || !account} title={!account ? 'Set up the account in Social Accounts' : undefined} onClick={() => setOpen(true)}>
        <CalendarClock className="h-3.5 w-3.5" /> Schedule
      </Button>
      <Button size="sm" disabled={blocked || !account} title={!account ? 'Set up the account in Social Accounts' : undefined} onClick={publishNow}>
        <Send className="h-3.5 w-3.5" /> Publish now
      </Button>
      {!account && (
        <span className="text-xs text-amber-600">{p.platform === 'fbgroup' ? 'Choose a group' : `No ${platformLabel(p.platform)} set up`}</span>
      )}
      {account && mediaIds.length === 0 && settings?.autoPickMedia && <span className="text-xs text-muted-foreground">image: auto-pick</span>}
      {p.disabled && <span className="text-xs text-red-500">Fix the warnings before scheduling</span>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Schedule post">
        <Field label={`Date & time (${tz})`}>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <p className="mt-2 text-xs text-muted-foreground">
          Chrome must be open at that time. Posts more than 2 h late are skipped; a {settings?.minGapMinutes ?? 60} min gap between posts on
          the same platform is enforced.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={schedule} disabled={busy}>
            Schedule
          </Button>
        </div>
      </Dialog>
    </>
  );
}
