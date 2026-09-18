import * as vscode from 'vscode';
import { Attachment, EffortLevel, TokenUsage } from '../types';

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  done: boolean;
}

export interface ChatMessage {
  id: string;
  /** 'system' is a display-only notice (e.g. a model switch) and never enters provider history. */
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  tools?: ToolCall[];
  usage?: TokenUsage;
  providerId?: string;
  model?: string;
  error?: string;
  /** Files sent with a user message. */
  attachments?: Attachment[];
  /** Attached files the model could not take, with the reason. */
  skippedAttachments?: { name: string; note: string }[];
  /** User message that PolyMoly wrote to continue after a provider switch. */
  handoff?: boolean;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  model?: string;
  messages: ChatMessage[];
  /** Provider session ids, so a CLI turn can resume its own thread. */
  providerSessions: Record<string, string>;
  effort: EffortLevel;
  thinking: boolean;
  showTools: boolean;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'polyagent.conversations';
const MAX_STORED = 100;

export function newConversation(providerId: string, model?: string): Conversation {
  const now = Date.now();
  return {
    id: `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: 'Untitled',
    providerId,
    model,
    messages: [],
    providerSessions: {},
    effort: 'high',
    thinking: true,
    showTools: true,
    createdAt: now,
    updatedAt: now
  };
}

/** Conversation list persisted in global state. */
export class ConversationStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): Conversation[] {
    return this.memento.get<Conversation[]>(STORAGE_KEY, []);
  }

  get(id: string): Conversation | undefined {
    return this.all().find((c) => c.id === id);
  }

  async save(conversation: Conversation): Promise<void> {
    conversation.updatedAt = Date.now();
    if (conversation.title === 'Untitled') {
      const first = conversation.messages.find((m) => m.role === 'user');
      if (first) {
        conversation.title = first.text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
      }
    }
    const rest = this.all().filter((c) => c.id !== conversation.id);
    const next = [conversation, ...rest]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_STORED);
    await this.memento.update(STORAGE_KEY, next);
  }

  async remove(id: string): Promise<void> {
    await this.memento.update(
      STORAGE_KEY,
      this.all().filter((c) => c.id !== id)
    );
  }
}
