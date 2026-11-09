export type Platform = 'threads' | 'facebook' | 'fbgroup';
export type ProviderId = 'openrouter' | 'ollama' | 'nvidia';
export type RouterMode = 'manual' | 'auto' | 'freeOnly' | 'offline';
export type PostStatus = 'draft' | 'scheduled' | 'processing' | 'verifying' | 'published' | 'failed' | 'cancelled';
export type Language = 'id' | 'en';

export interface Brand {
  id: string;
  name: string;
  website: string;
  affiliateUrl?: string;
  industry: string;
  description: string;
  products: string;
  features: string;
  pricing: string;
  audience: string;
  voice: string;
  strategy: string;
  cta: string;
  prohibitedClaims: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrandKnowledge {
  id: string;
  brandId: string;
  title: string;
  content: string;
  createdAt: number;
}

/** Health/status of a provider (config incl. keys lives in chrome.storage settings). */
export interface ProviderStatus {
  id: ProviderId;
  lastTestOk?: boolean;
  lastTestMessage?: string;
  lastLatencyMs?: number;
  lastSuccessAt?: number;
  lastError?: string;
}

export interface AIModel {
  /** compound key `${providerId}:${id}` */
  key?: string;
  id: string;
  providerId: ProviderId;
  name: string;
  isFree: boolean;
  vision: boolean;
  contextLength?: number;
  pricing?: { inPerM: number; outPerM: number };
}

export interface Account {
  id: string;
  platform: Platform;
  name: string;
  profileUrl: string;
  lastCheckOk?: boolean;
  lastCheckAt?: number;
  lastCheckMessage?: string;
}

/** A Threads "Community or topic" tag in the master list. id = normalised name. */
export interface ThreadsTopic {
  id: string;
  name: string;
  source: 'ai' | 'manual';
  enabled: boolean;
  uses: number;
  lastUsedAt?: number;
  createdAt: number;
}

/** A Facebook Group the user is a member of. */
export interface FbGroup {
  /** set when posting failed for a reason that will not fix itself (paused, not a member); the group is switched off */
  disabledReason?: string;
  id: string;
  name: string;
  url: string;
  /** the group's posting rules, given to the AI and shown before posting */
  rules: string;
  enabled: boolean;
  lastCheckOk?: boolean;
  lastCheckMessage?: string;
}

export interface MediaItem {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  thumb?: string;
  tags: string[];
  category?: string;
  width?: number;
  height?: number;
  lastUsedAt?: number;
  usedCount: number;
  createdAt: number;
}

export interface ContentIdea {
  id: string;
  brandId?: string;
  title: string;
  body: string;
  kind: string;
  createdAt: number;
}

export interface Post {
  id: string;
  platform: Platform;
  accountId: string;
  /** platform 'fbgroup' only */
  groupId?: string;
  /** fbgroup: groups this post already failed in (moved at most once) */
  groupsTried?: string[];
  brandId?: string;
  title?: string;
  text: string;
  mediaIds: string[];
  status: PostStatus;
  scheduledAt?: number;
  publishedAt?: number;
  url?: string;
  /** informational, e.g. "Pending admin approval in the group" */
  note?: string;
  /** Threads topic / community tag */
  topic?: string;
  /** Threads reply target. Preserved across retries; never treat a reply as a root post. */
  replyTo?: string;
  replyTargetText?: string;
  fingerprint: string;
  source: 'manual' | 'autopilot';
  attempts: number;
  nextRetryAt?: number;
  error?: string;
  contentType?: string;
  providerId?: ProviderId;
  modelId?: string;
  /** Threads only: likes + replies + reposts read from the profile (never estimated) */
  engagement?: number;
  engagementAt?: number;
  /** set when this post was used as the base of a recycled post */
  recycledAt?: number;
  /** 'own': a reply to a comment on the brand's own post (not counted as an outreach comment) */
  replyKind?: 'own';
  createdAt: number;
  updatedAt: number;
}

export interface QueueItem {
  id: string;
  kind: 'post' | 'slot';
  platform: Platform;
  postId?: string;
  /** autopilot: `${yyyy-MM-dd}#${index}` — same slotKey is shared by both platforms */
  slotKey?: string;
  contentType?: string;
  runAt: number;
  lockedUntil?: number;
  /** "Publish now": skip the minimum-gap wait */
  immediate?: boolean;
}

export interface AIUsage {
  id: string;
  at: number;
  providerId: ProviderId;
  modelId: string;
  purpose: 'interactive' | 'autopilot';
  inTokens: number;
  outTokens: number;
  costUsd: number | null;
  ok: boolean;
  latencyMs: number;
}

export interface ActivityLog {
  id: string;
  at: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model?: string;
  timeoutMs: number;
  /** NVIDIA: the developer tier is free (rate-limited); treat its models as free */
  freeTier?: boolean;
}

export interface AutopilotSettings {
  enabled: boolean;
  paused: boolean;
  platforms: Record<Platform, boolean>;
  postsPerDay: number;
  /** Facebook Group posts per day (each to a different group) */
  groupPostsPerDay?: number;
  windowStart: string; // 'HH:mm'
  windowEnd: string;
  contentTypes: string[];
  language: Language;
  attachMedia: boolean;
  model?: { providerId: ProviderId; modelId: string };
  allowPaid: boolean;
  dailyCapUsd: number;
  facebookOffsetMinutes: number;
  reviewWindowMinutes: number;
  /** Threads: append the brand website with UTM tags to autopilot posts */
  ctaLink?: boolean;
  /** daily: read own Threads profile engagement and reuse the best angles */
  learnFromEngagement?: boolean;
  /** notification with the day's results after the window ends */
  dailySummary?: boolean;
  /** move half the slots to the hours with the best engagement */
  bestTimes?: boolean;
  /** rewrite top posts older than 30 days with a fresh angle */
  recycle?: boolean;
  /** let the AI choose the image that matches the post text */
  aiImagePick?: boolean;
  /** reply to comments on the brand's own Threads posts */
  ownReplies?: boolean;
  ownRepliesPerDay?: number;
}

export interface Settings {
  language: Language;
  theme: 'light' | 'dark' | 'system';
  timezone: string;
  minGapMinutes: number;
  /** minimum gap between posts to different Facebook Groups */
  groupGapMinutes: number;
  /** pick an image from the Media Library when a post has none */
  autoPickMedia: boolean;
  /** Threads: let the AI choose a topic for each post */
  autoTopic: boolean;
  /** once a day: read trending Threads posts and create post ideas for autopilot */
  trendingResearch: boolean;
  comments: { enabled: boolean; dailyLimit: number; gapMinutes: number };
  activeBrandId?: string;
  router: {
    mode: RouterMode;
    priority: ProviderId[];
    manualProvider?: ProviderId;
    allowPaid: boolean;
    dailyCapUsd: number;
  };
  providers: Record<ProviderId, ProviderConfig>;
  autopilot: AutopilotSettings;
}
