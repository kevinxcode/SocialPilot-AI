import type { AIModel, ProviderConfig, ProviderId } from '@/types/models';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** base64 data URLs */
  images?: string[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  usage?: { in: number; out: number };
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

export interface AIProvider {
  id: ProviderId;
  listModels(): Promise<AIModel[]>;
  test(): Promise<TestResult>;
  chat(req: ChatRequest, onToken?: (t: string) => void): Promise<ChatResult>;
}

export type ProviderFactory = (cfg: ProviderConfig) => AIProvider;

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
