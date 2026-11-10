import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bookmark, CalendarClock, Heart, Info, Loader2, MessageCircle, MoreHorizontal, Save, Send, Sparkles, X } from 'lucide-react';
import { Button, Card, CardTitle, Field, Input, Textarea, useToast } from '@/components/ui';
import { useSettings } from '@/hooks/useSettings';
import { db } from '@/services/storage/db';
import { createDraft } from '@/services/publishing/posts';
import { INSTAGRAM_MIN_GAP_MINUTES, instagramMediaError, schedulePost, zonedToUtc } from '@/services/publishing/PublishingQueue';
import { sendToSw } from '@/background/messages';

/** Time of the last published Instagram post (for the 2-hour gap message). */
async function lastInstagramPublishedAt(): Promise<number> {
  const posts = await db.posts.where('platform').equals('instagram').filter((p) => p.status === 'published' && !!p.publishedAt).toArray();
  return Math.max(0, ...posts.map((p) => p.publishedAt!));
}
import { fingerprint } from '@/services/publishing/fingerprint';
import { stripLinks } from '@/services/content/noLinks';
import { LIMITS, MAX_HASHTAGS, validatePost, visibleLength } from '@/services/content/validate';
import { generateInstagramCaption } from '@/services/content/generate';
import { shrinkImage } from '@/lib/image';
import type { MediaItem } from '@/types/models';
import { getActiveBrandId } from './BrandKnowledge';
import { INSTAGRAM } from '@/services/publishing/rpa/selectors/instagram';
import { MediaThumb } from './MediaLibrary';
import { MediaPicker, toZonedInput } from './PostActions';
import { AccountCard } from './SocialAccounts';
import { ScheduledPostsPage } from './ScheduledPosts';

const MAX_CAPTION = LIMITS.instagram;
const MAX_TAGS = MAX_HASHTAGS.instagram ?? 30;
/** Instagram cuts the caption in the feed after about this many characters ("… more"). */
export const FEED_CUT = 125;
export const countHashtags = (text: string) => text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;

/** Caption + hashtags as one Instagram caption (hashtags on their own line at the end). */
export function joinCaption(caption: string, hashtags: string[]): string {
  return [caption.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n');
}

/** Caption text with #hashtags highlighted, as Instagram shows them. */
function RichCaption({ text }: { text: string }) {
  const parts = text.split(/(#[\p{L}\p{N}_]+)/gu);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('#') ? (
          <span key={i} className="text-[#00376b] dark:text-[#e0f1ff]">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Full-size image (the library thumbnail is too small for the preview). */
function FullImage({ m }: { m: MediaItem }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!m.blob) return;
    const u = URL.createObjectURL(m.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [m]);
  return url ? <img src={url} alt={m.name} className="h-full w-full object-cover" /> : <MediaThumb m={m} className="h-full w-full" />;
}

/** How the post will look in the Instagram feed. */
export function InstagramPreview({ handle, media, caption }: { handle: string; media?: MediaItem; caption: string }) {
  const [expanded, setExpanded] = useState(false);
  const text = stripLinks(caption); // what is really posted
  const long = visibleLength(text) > FEED_CUT;
  const shown = expanded || !long ? text : `${[...text].slice(0, FEED_CUT).join('').trimEnd()}…`;
  return (
    <div
      className="mx-auto w-full max-w-[380px] overflow-hidden rounded-lg border border-neutral-200 bg-white text-[14px] text-neutral-900 shadow-sm dark:border-neutral-800 dark:bg-black dark:text-neutral-100"
      aria-label="Instagram preview"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 p-[2px]">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-[11px] font-bold uppercase text-neutral-700 dark:bg-black dark:text-neutral-200">
            {handle.slice(0, 1)}
          </div>
        </div>
        <span className="font-semibold">{handle}</span>
        <MoreHorizontal className="ml-auto h-5 w-5" />
      </div>
      <div className="flex aspect-square w-full items-center justify-center overflow-hidden bg-neutral-100 dark:bg-neutral-900">
        {media ? <FullImage m={media} /> : <span className="px-6 text-center text-xs text-neutral-500">Pick an image to see the preview</span>}
      </div>
      <div className="flex items-center gap-4 px-3 pb-1 pt-2">
        <Heart className="h-6 w-6" />
        <MessageCircle className="h-6 w-6" />
        <Send className="h-6 w-6" />
        <Bookmark className="ml-auto h-6 w-6" />
      </div>
      <div className="whitespace-pre-wrap break-words px-3 pb-3 leading-snug">
        {text.trim() ? (
          <>
            <span className="mr-1 font-semibold">{handle}</span>
            <RichCaption text={shown} />
            {long && (
              <button type="button" className="ml-1 text-neutral-500" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'less' : 'more'}
              </button>
            )}
          </>
        ) : (
          <span className="text-neutral-500">Your caption appears here.</span>
        )}
      </div>
    </div>
  );
}

/** New Instagram feed post: one image + caption (written by hand or by AI from the image), with a live preview. */
function NewInstagramPost() {
  const toast = useToast();
  const { settings } = useSettings();
  const tz = settings?.timezone ?? 'Asia/Jakarta';
  const [caption, setCaption] = useState('');
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [hint, setHint] = useState('');
  const [when, setWhen] = useState(() => toZonedInput(Date.now() + 60 * 60_000, tz));
  const [busy, setBusy] = useState<'ai' | 'save' | null>(null);
  const account = useLiveQuery(() => db.accounts.where('platform').equals('instagram').first(), []);
  const media = useLiveQuery(() => (mediaIds[0] ? db.media.get(mediaIds[0]) : undefined), [mediaIds[0]]);
  const handle = account?.name || 'your_account';

  const len = visibleLength(caption);
  const tags = countHashtags(caption);
  const hasLink = /https?:\/\/|www\./i.test(caption);

  const generate = async () => {
    if (!media?.blob) return toast('Pick an image first — the AI writes the caption from it', 'err');
    const brandId = await getActiveBrandId(settings?.activeBrandId);
    if (!brandId) return toast('Set up your brand first (Brand Knowledge)', 'err');
    if (caption.trim() && !confirm('Replace the current caption with a new one from the AI?')) return;
    setBusy('ai');
    try {
      const r = await generateInstagramCaption(await shrinkImage(media.blob), { brandId, language: settings?.language ?? 'id', hint });
      setCaption(joinCaption(r.caption, r.hashtags));
      toast(`Caption written by ${r.meta.providerId}/${r.meta.modelId} — check it before scheduling`);
    } catch (e) {
      const msg = (e as Error).message;
      toast(
        /vision/i.test(msg)
          ? 'No AI model that can read images is available. In AI Providers, enable a vision model (e.g. Ollama llava / qwen2.5vl, or an OpenRouter vision model).'
          : msg.slice(0, 220),
        'err',
      );
    } finally {
      setBusy(null);
    }
  };

  const save = async (mode: 'schedule' | 'draft' | 'now') => {
    const schedule = mode === 'schedule';
    const brandId = await getActiveBrandId(settings?.activeBrandId);
    if (!brandId) return toast('Set up your brand first (Brand Knowledge)', 'err');
    const mediaErr = instagramMediaError({ platform: 'instagram', mediaIds, fingerprint: fingerprint(stripLinks(caption)) });
    if (mediaErr) return toast(mediaErr, 'err');
    const v = await validatePost(caption, 'instagram', brandId);
    if (!v.ok) return toast(v.errors.join(' · '), 'err');
    const at = zonedToUtc(when, tz).getTime();
    if (schedule && (!Number.isFinite(at) || at < Date.now() - 60_000)) return toast('Pick a time in the future', 'err');
    if (mode === 'now' && !confirm('Publish this post to Instagram now?')) return;
    setBusy('save');
    try {
      const post = await createDraft({ platform: 'instagram', text: caption, brandId, mediaIds, autoMedia: false });
      if (schedule) await schedulePost(post.id, new Date(at));
      if (mode === 'now') {
        const r = await sendToSw({ type: 'publishNow', postId: post.id });
        if (!r.ok) throw new Error(r.message ?? 'Could not start publishing');
        // The 2-hour safety gap also applies to "Publish now": say when it will really go out.
        const last = await lastInstagramPublishedAt();
        const waitUntil = last ? last + INSTAGRAM_MIN_GAP_MINUTES * 60_000 : 0;
        toast(
          waitUntil > Date.now()
            ? `Queued — Instagram allows one post every 2 hours, so this goes out at ${new Date(waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'Publishing to Instagram now — you will get a notification',
        );
      } else toast(schedule ? 'Instagram post scheduled' : 'Saved as draft');
      setCaption('');
      setMediaIds([]);
      setHint('');
    } catch (e) {
      toast((e as Error).message.slice(0, 200), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardTitle className="mb-1">New Instagram post</CardTitle>
      <p className="mb-4 text-sm text-muted-foreground">Pick one image, let the AI write the caption and hashtags from it, check the preview, then schedule.</p>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-sm font-medium">1. Image</div>
            {media ? (
              <div className="flex items-center gap-3">
                <MediaThumb m={media} className="h-20 w-20 rounded-md" />
                <div className="min-w-0 text-sm">
                  <div className="truncate">{media.name}</div>
                  <div className="mt-1 flex gap-2">
                    <MediaPicker value={mediaIds} onChange={setMediaIds} max={1} />
                    <Button size="sm" variant="ghost" onClick={() => setMediaIds([])} aria-label="Remove image">
                      <X className="h-3.5 w-3.5" /> Remove
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <MediaPicker value={mediaIds} onChange={setMediaIds} max={1} />
                <span className="text-xs text-amber-500">Required</span>
              </div>
            )}
          </div>

          <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="mb-1.5 text-sm font-medium">2. Caption &amp; hashtags with AI</div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Optional direction, e.g. promo for new outlets, friendly tone" aria-label="AI direction" />
              </div>
              <Button disabled={!!busy || !media} onClick={generate}>
                {busy === 'ai' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {busy === 'ai' ? 'Reading the image…' : 'Generate from image'}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">The AI looks at the image and your Brand Knowledge. It needs a model that can read images (vision).</p>
          </div>

          <Field label="3. Caption (edit freely)">
            <Textarea
              rows={8}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={'Strong first line… then the details.\n\n#laundry #cuciqu'}
              aria-label="Instagram caption"
            />
          </Field>
          <div className="-mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span className={len > MAX_CAPTION ? 'text-red-500' : 'text-muted-foreground'}>
              {len}/{MAX_CAPTION} characters
            </span>
            <span className={tags > MAX_TAGS ? 'text-red-500' : 'text-muted-foreground'}>
              {tags}/{MAX_TAGS} hashtags
            </span>
            {hasLink && <span className="text-amber-500">Links are removed when posting (not clickable on Instagram) — use “link di bio”.</span>}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Field label={`4. Publish at (${tz})`}>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
            <Button disabled={!!busy} onClick={() => save('schedule')}>
              {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />} Schedule
            </Button>
            <Button variant="secondary" disabled={!!busy} onClick={() => save('now')}>
              <Send className="h-4 w-4" /> Publish now
            </Button>
            <Button variant="outline" disabled={!!busy} onClick={() => save('draft')}>
              <Save className="h-4 w-4" /> Save draft
            </Button>
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium">Preview</div>
          <InstagramPreview handle={handle} media={media ?? undefined} caption={caption} />
          <p className="mt-2 text-center text-xs text-muted-foreground">In the feed the caption is cut after ~{FEED_CUT} characters — make the first line count.</p>
        </div>
      </div>
    </Card>
  );
}

export function InstagramPage() {
  return (
    <div className="space-y-4">
      <Card className="flex gap-3 border-sky-500/40 bg-sky-500/5 text-sm">
        <Info className="h-5 w-5 shrink-0 text-sky-500" />
        <div className="space-y-1">
          <p>
            Feed posts with one image. Instagram is posted by automating instagram.com in this Chrome profile — stay logged in, and run a <b>Dry run</b>{' '}
            first. To be safe, at most one Instagram post every 2 hours. Instagram is not part of autopilot.
          </p>
          <p className="text-muted-foreground">Stories, Reels and carousels are not supported yet (Instagram does not offer Stories on desktop).</p>
          <p className="text-xs text-muted-foreground">Automation version {INSTAGRAM.version}</p>
        </div>
      </Card>
      <NewInstagramPost />
      <Card>
        <CardTitle className="mb-3">Instagram posts</CardTitle>
        <ScheduledPostsPage lockPlatform="instagram" />
      </Card>
      <AccountCard platform="instagram" />
    </div>
  );
}
