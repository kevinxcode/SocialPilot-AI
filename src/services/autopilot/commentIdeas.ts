/** Saved ideas the user picked for comments: automatic comments search Threads for these first. */
import { log } from '@/services/storage/db';

const KEY = 'commentIdeas';
const MAX_SEARCHES = 3;

export interface CommentIdea {
  id: string;
  title: string;
  body: string;
  searches?: number;
}

export async function commentIdeas(): Promise<CommentIdea[]> {
  return ((await chrome.storage.local.get(KEY))[KEY] as CommentIdea[] | undefined) ?? [];
}

const save = (list: CommentIdea[]) => chrome.storage.local.set({ [KEY]: list });

export async function addCommentIdeas(ideas: CommentIdea[]): Promise<void> {
  const list = await commentIdeas();
  const have = new Set(list.map((i) => i.id));
  await save([...list, ...ideas.filter((i) => !have.has(i.id)).map(({ id, title, body }) => ({ id, title, body }))]);
}

const COMMON_WORDS = new Set(
  'agar akan atau bagaimana banyak bisa cara dalam dan dari dengan di hari ikut ini itu jangan kelola ke lebih membantu mencek menjaga meningkatkan pada para saja sehari-hari tips tidak untuk yang'.split(' '),
);
const GENERIC_INDUSTRY = new Set('aplikasi bisnis industri jasa management manajemen perusahaan platform service services sistem software usaha'.split(' '));
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);

/** Threads search finds relevant posts with the idea's core words plus the brand's field, not a full headline. */
export function commentQuery(title: string, industry = ''): string {
  const headline = title.split(/[:?]/)[0].trim();
  const field = words(industry).find((w) => !GENERIC_INDUSTRY.has(w)) ?? '';
  const core = [...new Set(words(headline))].filter((w) => !COMMON_WORDS.has(w) && w !== field).slice(0, 2);
  if (!core.length && !field) return headline.split(/\s+/).slice(0, 5).join(' ');
  return [...core, field].filter(Boolean).join(' ');
}

/** Counts a search that read posts but found none relevant; after the limit the idea is dropped. */
export async function markIdeaSearched(id: string): Promise<void> {
  const list = await commentIdeas();
  const idea = list.find((i) => i.id === id);
  if (!idea) return;
  const rest = list.filter((i) => i.id !== id);
  const searches = (idea.searches ?? 0) + 1;
  if (searches >= MAX_SEARCHES) {
    await save(rest);
    await log('warn', 'comments', `No suitable Threads post found for idea “${idea.title}” after ${MAX_SEARCHES} searches — removed from the comment list`);
    return;
  }
  await save([...rest, { ...idea, searches }]);
}

/** Gives the next idea a turn without counting this search against the idea. */
export async function moveIdeaToBack(id: string): Promise<void> {
  const list = await commentIdeas();
  const idea = list.find((i) => i.id === id);
  if (idea) await save([...list.filter((i) => i.id !== id), idea]);
}

export async function removeCommentIdea(id: string): Promise<void> {
  await save((await commentIdeas()).filter((i) => i.id !== id));
}

export const COMMENT_IDEAS_KEY = KEY;
