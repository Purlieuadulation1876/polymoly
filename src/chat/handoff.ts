import { ModelDef, ModelTier, ProviderDef, TokenUsage } from '../types';
import { ChatMessage, Conversation } from './session';

/**
 * Hand-off between providers inside one conversation: spotting an exhausted quota,
 * suggesting an equivalent model elsewhere, and carrying the transcript over.
 */

const TIER_RANK: Record<ModelTier, number> = { fast: 0, balanced: 1, flagship: 2, frontier: 3 };

/** Errors that mean "this provider will not answer for a while". */
const QUOTA_ERROR =
  /usage limit|limit reached|hit your (?:usage )?limit|rate[ _-]?limit|quota|credit balance is too low|out of credits|insufficient[_ ]credits|\b429\b/i;

/** Limit notices some CLIs print as the assistant's answer instead of an error. */
const QUOTA_TEXT = /^(?:claude ai usage limit reached|you'?ve hit your (?:usage )?limit|api error: 429)|usage limit reached/i;

/** Tool output kept per call in a transcript; the new agent re-reads files anyway. */
const TOOL_OUTPUT_CHARS = 600;
const TOOL_INPUT_CHARS = 300;
/** Share of the target's context window the transcript may fill. */
const TRANSCRIPT_SHARE = 0.5;
const DEFAULT_CONTEXT_WINDOW = 200_000;

export interface QuotaHit {
  message: string;
  /** Epoch milliseconds, when the provider says so. */
  resetsAt?: number;
}

export interface HandoffTarget {
  providerId: string;
  model?: string;
}

export interface Transfer {
  /** Messages the target has not seen and receives now. */
  messages: number;
  /** Older unseen messages dropped to fit the target's context window. */
  omitted: number;
  /** Estimated tokens the target reads on its first turn, besides its own system prompt. */
  tokens: number;
  /** The target resumes its own session and only receives what happened since. */
  resumesSession: boolean;
  contextWindow?: number;
}

/** Quota problem of a finished turn, or undefined when the turn failed for another reason. */
export function detectQuota(assistant: ChatMessage): QuotaHit | undefined {
  const text = assistant.text.trim();
  const message =
    assistant.error && QUOTA_ERROR.test(assistant.error)
      ? assistant.error
      : text.length < 600 && QUOTA_TEXT.test(text)
        ? text
        : undefined;
  if (!message) {
    return undefined;
  }
  // claude prints "Claude AI usage limit reached|<unix seconds>".
  const unix = /\|(\d{10})\b/.exec(message);
  return {
    message: message.split('\n')[0].replace(/\|\d{10}\b/, '').trim().slice(0, 200),
    resetsAt: unix ? Number(unix[1]) * 1000 : undefined
  };
}

/** Capability class of a model: its configured tier, else a guess from the id. */
export function modelTier(model: ModelDef | undefined, id = model?.id ?? ''): ModelTier {
  if (model?.tier) {
    return model.tier;
  }
  const name = id.toLowerCase();
  if (/fable|ultra/.test(name)) {
    return 'frontier';
  }
  // Whole name parts only: "minimax" is neither "mini" nor "max".
  if (/haiku|(?:^|[-_.\s])(?:mini|nano|flash|lite|small|spark)(?:$|[-_.\s])/.test(name)) {
    return 'fast';
  }
  if (/opus|(?:^|[-_.\s])(?:sol|pro|max|large)(?:$|[-_.\s])/.test(name)) {
    return 'flagship';
  }
  return 'balanced';
}

/**
 * The model to continue with when `from` is out of quota. `preferred` entries
 * ("provider" or "provider/model") win in order; otherwise the closest tier on another
 * provider, same kind (CLI agent vs. plain API) first.
 */
export function suggestTarget(
  providers: ProviderDef[],
  from: HandoffTarget,
  usable: (def: ProviderDef) => boolean,
  preferred: string[]
): HandoffTarget | undefined {
  const candidates = providers.filter((def) => def.id !== from.providerId && usable(def) && def.models?.length);

  for (const entry of preferred) {
    const [providerId, ...rest] = entry.split('/');
    const def = candidates.find((p) => p.id === providerId);
    const modelId = rest.join('/') || def?.defaultModel;
    if (def && def.models?.some((m) => m.id === modelId)) {
      return { providerId: def.id, model: modelId };
    }
  }

  const fromDef = providers.find((p) => p.id === from.providerId);
  const fromModelId = from.model ?? fromDef?.defaultModel;
  const fromRank = TIER_RANK[modelTier(fromDef?.models?.find((m) => m.id === fromModelId), fromModelId)];

  let best: { target: HandoffTarget; score: number } | undefined;
  candidates.forEach((def, providerIndex) => {
    for (const model of def.models ?? []) {
      const rank = TIER_RANK[modelTier(model)];
      const score =
        Math.abs(rank - fromRank) * 10 +
        (rank > fromRank ? 1 : 0) +
        (fromDef && def.kind !== fromDef.kind ? 5 : 0) +
        (model.id === def.defaultModel ? 0 : 0.5) +
        providerIndex * 0.01;
      if (!best || score < best.score) {
        best = { target: { providerId: def.id, model: model.id }, score };
      }
    }
  });
  return best?.target;
}

/** Rough token count; good enough to size a hand-off. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Messages before `end` that `providerId` has not seen: everything after its own last
 * answer, or the whole conversation when it has no session to resume.
 */
export function unseenMessages(conversation: Conversation, providerId: string, end: number): ChatMessage[] {
  const prior = conversation.messages.slice(0, end);
  if (!conversation.providerSessions[providerId]) {
    return prior;
  }
  let cursor = 0;
  prior.forEach((message, index) => {
    if (message.role === 'assistant' && message.providerId === providerId) {
      cursor = index + 1;
    }
  });
  return prior.slice(cursor);
}

function entryText(message: ChatMessage, labelOf: (message: ChatMessage) => string): string {
  if (message.role === 'user') {
    const files = message.attachments?.length
      ? `\n(attached: ${message.attachments.map((f) => f.path).join(', ')})`
      : '';
    return `[User]\n${message.text}${files}`;
  }
  const lines = [`[Assistant · ${labelOf(message)}]`];
  for (const tool of message.tools ?? []) {
    const input = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input ?? '');
    let line = `- tool ${tool.name}(${clip(input, TOOL_INPUT_CHARS)})`;
    if (tool.output) {
      line += `\n  ${tool.isError ? 'error' : 'result'}: ${clip(tool.output, TOOL_OUTPUT_CHARS).replace(/\n/g, '\n  ')}`;
    } else if (!tool.done) {
      line += ' (no result, interrupted)';
    }
    lines.push(line);
  }
  if (message.text.trim()) {
    lines.push(message.text.trim());
  }
  if (message.error) {
    lines.push(`(turn interrupted: ${clip(message.error, 200)})`);
  }
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}… [${flat.length - max} chars cut]` : flat;
}

/**
 * Transcript block for a CLI agent that joins mid-conversation. Oldest messages go first
 * when the transcript would not fit the target's context window.
 */
export function handoffPreamble(
  messages: ChatMessage[],
  labelOf: (message: ChatMessage) => string,
  contextWindow = DEFAULT_CONTEXT_WINDOW
): { text: string; omitted: number } {
  const entries = messages.map((m) => entryText(m, labelOf));
  const budget = contextWindow * TRANSCRIPT_SHARE;
  let omitted = 0;
  let tokens = entries.reduce((sum, entry) => sum + estimateTokens(entry), 0);
  while (entries.length > 1 && tokens > budget) {
    tokens -= estimateTokens(entries.shift()!);
    omitted++;
  }
  const text = [
    '<conversation_handoff>',
    'You are joining a conversation that other AI agents handled so far. Below is the part you have not seen.',
    'Tool calls are summarised and their output is truncated. Files on disk already contain every change made so far, so re-read files instead of trusting this summary.',
    omitted ? `[${omitted} earlier messages omitted]` : '',
    entries.join('\n\n'),
    '</conversation_handoff>',
    ''
  ]
    .filter((line, index, all) => line || index === all.length - 1)
    .join('\n\n');
  return { text, omitted };
}

/** What switching the conversation to `target` would carry over on the next turn. */
export function planTransfer(
  conversation: Conversation,
  target: ProviderDef,
  modelId: string | undefined,
  labelOf: (message: ChatMessage) => string
): Transfer {
  const contextWindow = target.models?.find((m) => m.id === (modelId ?? target.defaultModel))?.contextWindow;
  const end = conversation.messages.length;

  if (target.kind === 'http') {
    const text = conversation.messages.map((m) => m.text).join('\n');
    return { messages: end, omitted: 0, tokens: estimateTokens(text), resumesSession: false, contextWindow };
  }

  const unseen = unseenMessages(conversation, target.id, end);
  const { text, omitted } = handoffPreamble(unseen, labelOf, contextWindow);
  return {
    messages: unseen.length - omitted,
    omitted,
    tokens: unseen.length ? estimateTokens(text) : 0,
    resumesSession: Boolean(conversation.providerSessions[target.id]),
    contextWindow
  };
}

/** Usage of the last answer `providerId` gave in this conversation. */
export function lastUsage(conversation: Conversation, providerId: string): TokenUsage | undefined {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const message = conversation.messages[i];
    if (message.role === 'assistant' && message.providerId === providerId && message.usage) {
      return message.usage;
    }
  }
  return undefined;
}
