import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { BookmarkPlus, Globe, Loader2, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Empty,
  Field,
  Input,
  Select,
  Textarea,
  useToast,
} from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { db } from "@/services/storage/db";
import { research } from "@/services/content/generate";
import { RESEARCH_KINDS, type ResearchKind } from "@/services/content/prompts";
import { uid } from "@/lib/utils";
import type { Language } from "@/types/models";
import { getActiveBrandId } from "./BrandKnowledge";
import { IDEA_JOB_KEY, jobIsLive, type IdeaJob } from "@/services/content/ideasToQueue";
import { sendToSw } from "@/background/messages";
import type { Platform } from "@/types/models";

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,style,noscript,svg,nav,footer")
    .forEach((n) => n.remove());
  return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function fetchPublicPage(url: string): Promise<string> {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.hostname}/*`;
  const granted =
    (await chrome.permissions.contains({ origins: [origin] })) ||
    (await chrome.permissions.request({ origins: [origin] }));
  if (!granted) throw new Error("Permission to read that site was not granted");
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`Could not fetch page (HTTP ${res.status})`);
  return htmlToText(await res.text());
}

export function ResearchPage() {
  const { settings } = useSettings();
  const toast = useToast();
  const [brandId, setBrandId] = useState("");
  const [kind, setKind] = useState<ResearchKind>("topics");
  const [focus, setFocus] = useState("");
  const [language, setLanguage] = useState<Language>("id");
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [results, setResults] = useState<{ title: string; body: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const ideas =
    useLiveQuery(() => db.ideas.orderBy("createdAt").reverse().toArray(), []) ??
    [];
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [qPlatforms, setQPlatforms] = useState<Set<Platform>>(new Set<Platform>(["threads"]));
  const [removeAfter, setRemoveAfter] = useState(true);
  const [queuing, setQueuing] = useState<number | null>(null);
  const allChecked = ideas.length > 0 && ideas.every((i) => sel.has(i.id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const addToQueue = async () => {
    const ids = ideas.filter((i) => sel.has(i.id)).map((i) => i.id);
    if (!ids.length) return;
    const platforms = [...qPlatforms];
    if (!platforms.length) return toast("Pick at least one platform", "err");
    if (
      !confirm(
        `Generate and schedule ${ids.length * platforms.length} posts (${ids.length} ideas × ${platforms.join(", ")}), spaced by the minimum gap inside the autopilot window?`,
      )
    )
      return;
    const r = await sendToSw({ type: "queueIdeas", ids, platforms, removeAfter });
    if (!r.ok) return toast(r.message ?? "Could not start", "err");
    toast("Running in the background — you can switch menus");
    setSel(new Set());
  };

  // Background job progress (survives navigation).
  const [job, setJob] = useState<IdeaJob | null>(null);
  useEffect(() => {
    chrome.storage.local.get(IDEA_JOB_KEY).then((v) => setJob((v[IDEA_JOB_KEY] as IdeaJob) ?? null));
    const on = (ch: Record<string, chrome.storage.StorageChange>) => {
      if (ch[IDEA_JOB_KEY]) setJob(ch[IDEA_JOB_KEY].newValue as IdeaJob);
    };
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, []);
  useEffect(() => {
    const upd = () => setQueuing(jobIsLive(job) ? job!.done : null);
    upd();
    const t = setInterval(upd, 15_000); // a job that stopped making progress (worker restarted) unlocks the button
    return () => clearInterval(t);
  }, [job]);

  useEffect(() => {
    getActiveBrandId(settings?.activeBrandId).then(
      (id) => id && setBrandId(id),
    );
  }, [settings?.activeBrandId]);

  const run = async () => {
    if (!brandId) return toast("Create a brand first", "err");
    if (kind === "competitor" && !source.trim())
      return toast(
        "Paste competitor content or fetch a public URL first",
        "err",
      );
    setLoading(true);
    try {
      setResults(
        await research(kind, {
          brandId,
          language,
          focus,
          source: url ? `${source}\n\n(Source: ${url})` : source,
        }),
      );
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setLoading(false);
    }
  };
  const fetchUrl = async () => {
    try {
      const text = await fetchPublicPage(url);
      setSource(text.slice(0, 12000));
      toast(`Fetched ${text.length} characters`);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const saveAll = async () => {
    const have = new Set(ideas.map((i) => i.title.trim().toLowerCase()));
    const fresh = results.filter((r) => !have.has(r.title.trim().toLowerCase()));
    const ref = kind === "competitor" && url ? `

Source: ${url}` : "";
    await db.ideas.bulkAdd(fresh.map((r, i) => ({ id: uid(), brandId, title: r.title, body: r.body + ref, kind, createdAt: Date.now() + i })));
    setResults([]);
    toast(`Saved ${fresh.length} ideas${results.length - fresh.length ? ` (${results.length - fresh.length} already saved)` : ""}`);
  };
  const save = async (r: { title: string; body: string }) => {
    const ref = kind === "competitor" && url ? `\n\nSource: ${url}` : "";
    await db.ideas.add({
      id: uid(),
      brandId,
      title: r.title,
      body: r.body + ref,
      kind,
      createdAt: Date.now(),
    });
    setResults((rs) => rs.filter((x) => x !== r));
    toast("Saved as content idea");
  };

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-xs text-muted-foreground">
          Results are AI-generated from general knowledge and your brand
          knowledge base — <strong>not real-time trends</strong>. Competitor
          analysis uses only the text or public URL you provide.
        </p>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Research type">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as ResearchKind)}
            >
              {Object.entries(RESEARCH_KINDS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="md:col-span-2">
            <Field label="Focus">
              <Input
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder="mis. laundry kiloan multi-outlet"
              />
            </Field>
          </div>
          <Field label="Language">
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              <option value="id">Indonesia</option>
              <option value="en">English</option>
            </Select>
          </Field>
        </div>
        {kind === "competitor" && (
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://public-competitor-page.example"
              />
              <Button
                variant="outline"
                onClick={fetchUrl}
                disabled={!/^https?:\/\//.test(url)}
              >
                <Globe className="h-4 w-4" /> Fetch
              </Button>
            </div>
            <Textarea
              rows={5}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="…or paste competitor posts here"
            />
          </div>
        )}
        <Button className="mt-3" onClick={run} disabled={loading}>
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
          {loading ? "Researching…" : "Run research"}
        </Button>
      </Card>

      {results.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{results.length} results</span>
          <Button onClick={saveAll}>
            <BookmarkPlus className="h-4 w-4" /> Save all ({results.length})
          </Button>
        </div>
      )}
      {results.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {results.map((r, i) => (
            <Card key={i}>
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="font-medium">{r.title}</div>
                <Button size="sm" variant="outline" onClick={() => save(r)}>
                  <BookmarkPlus className="h-3.5 w-3.5" /> Save idea
                </Button>
              </div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {r.body}
              </p>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardTitle>
          Saved ideas <Badge>{ideas.length}</Badge>
        </CardTitle>
        {ideas.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={() =>
                  setSel(
                    allChecked ? new Set() : new Set(ideas.map((i) => i.id)),
                  )
                }
                aria-label="Select all ideas"
              />
              Select all ({sel.size})
            </label>
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-1.5">
              {(
                [
                  ["threads", "Threads"],
                  ["facebook", "Facebook Page"],
                  ["fbgroup", "Facebook Groups"],
                ] as [Platform, string][]
              ).map(([p, label]) => (
                <label key={p} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={qPlatforms.has(p)}
                    onChange={() =>
                      setQPlatforms((s) => {
                        const n = new Set(s);
                        if (n.has(p)) n.delete(p);
                        else n.add(p);
                        return n;
                      })
                    }
                    aria-label={`Queue to ${label}`}
                  />
                  {label}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={removeAfter} onChange={() => setRemoveAfter((v) => !v)} aria-label="Remove ideas after queuing" />
              Remove from saved ideas after queuing
            </label>
            <Button
              disabled={!sel.size || queuing !== null}
              onClick={addToQueue}
            >
              {queuing !== null && <Loader2 className="h-4 w-4 animate-spin" />}
              {queuing !== null
                ? `Generating… ${queuing}/${job?.total ?? 0}`
                : `Add to queue (${sel.size * qPlatforms.size})`}
            </Button>
            {queuing !== null && (
              <Button variant="outline" onClick={() => sendToSw({ type: "stopIdeaJob" })}>
                Stop
              </Button>
            )}
            {queuing !== null && job && <JobTimer job={job} />}
          </div>
        )}
        {job && !job.running && job.finishedAt && Date.now() - job.finishedAt < 30 * 60_000 && (
          <p className={`mb-2 text-xs ${job.failed.length && !job.queued ? "text-red-500" : "text-emerald-600"}`}>
            Last run: scheduled {job.queued}/{job.total} posts{job.removed ? ` · ${job.removed} ideas removed` : ""}
            {job.failed.length ? ` · ${job.failed.length} failed (${job.failed[0]})` : ""}
          </p>
        )}
        {ideas.length === 0 ? (
          <Empty>
            No saved ideas yet. Autopilot also draws topics from saved ideas.
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {ideas.map((i) => (
              <li
                key={i.id}
                className="flex items-start justify-between gap-2 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={sel.has(i.id)}
                  onChange={() => toggle(i.id)}
                  aria-label={`Select ${i.title}`}
                />
                <div className="flex-1">
                  <div className="font-medium">
                    {i.title} <Badge>{i.kind}</Badge>
                  </div>
                  <div className="whitespace-pre-wrap text-muted-foreground">
                    {i.body}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${i.title}`}
                  onClick={() => db.ideas.delete(i.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const mmss = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/** Elapsed time and a rough estimate from the average time per post so far. */
function JobTimer({ job }: { job: IdeaJob }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = now - job.startedAt;
  const eta = job.done > 0 ? (elapsed / job.done) * (job.total - job.done) : undefined;
  return (
    <span className="text-xs text-muted-foreground">
      {mmss(elapsed)} elapsed
      {eta !== undefined ? ` · ~${mmss(eta)} left` : " · estimating…"}
    </span>
  );
}
