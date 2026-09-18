import { inlineText, readBase64 } from '../chat/attachments';
import { AgentAdapter, AgentEvent, ModelDef, ProviderDef, SendRequest, TokenUsage } from '../types';
import { t } from '../i18n';

export type KeyLookup = (providerId: string) => Promise<string | undefined>;

/** Talks to an OpenAI-compatible or Anthropic-compatible HTTP endpoint. */
export class HttpAdapter implements AgentAdapter {
  constructor(readonly def: ProviderDef, private readonly getKey: KeyLookup) {}

  async check(): Promise<{ ok: boolean; detail: string }> {
    if (!this.def.baseUrl) {
      return { ok: false, detail: t('err.noBaseUrl') };
    }
    const key = await this.getKey(this.def.id);
    if (!key) {
      return { ok: false, detail: t('err.noApiKeyHint') };
    }
    return { ok: true, detail: this.def.baseUrl };
  }

  async send(req: SendRequest, emit: (event: AgentEvent) => void): Promise<void> {
    try {
      const key = await this.getKey(this.def.id);
      if (!key) {
        emit({ type: 'error', message: t('err.noApiKeyHint') });
        return;
      }
      if (this.def.api === 'anthropic') {
        await this.sendAnthropic(req, key, emit);
      } else {
        await this.sendOpenAi(req, key, emit);
      }
    } catch (err) {
      if (!req.signal.aborted) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      emit({ type: 'done' });
    }
  }

  /** Models the endpoint reports via GET /models (OpenAI and Anthropic shape). */
  async listModels(): Promise<ModelDef[]> {
    if (!this.def.baseUrl) {
      throw new Error(t('err.noBaseUrl'));
    }
    const key = await this.getKey(this.def.id);
    if (!key) {
      throw new Error(t('err.noApiKey'));
    }
    const headers: Record<string, string> =
      this.def.api === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(this.def.headers ?? {}) }
        : { authorization: `Bearer ${key}`, ...(this.def.headers ?? {}) };

    const models: ModelDef[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${trimSlash(this.def.baseUrl)}/models`);
      if (this.def.api === 'anthropic') {
        url.searchParams.set('limit', '1000');
        if (afterId) {
          url.searchParams.set('after_id', afterId);
        }
      }
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        throw new Error(await errorText(response));
      }
      const body: any = await response.json();
      const list: any[] = Array.isArray(body) ? body : body?.data ?? body?.models ?? [];
      for (const entry of list) {
        const id = typeof entry === 'string' ? entry : entry?.id ?? entry?.name;
        if (id) {
          models.push({ id: String(id), label: entry?.display_name ?? entry?.name ?? String(id) });
        }
      }
      if (this.def.api !== 'anthropic' || !body?.has_more || !body?.last_id) {
        break;
      }
      afterId = body.last_id;
    }
    return models;
  }

  private model(req: SendRequest): string {
    return req.model ?? this.def.defaultModel ?? this.def.models?.[0]?.id ?? '';
  }

  private async sendOpenAi(req: SendRequest, key: string, emit: (event: AgentEvent) => void) {
    const url = `${trimSlash(this.def.baseUrl!)}/chat/completions`;
    const system = systemText(this.def, req);
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...req.history,
      { role: 'user', content: openAiContent(req) }
    ];

    const response = await fetch(url, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...(this.def.headers ?? {})
      },
      body: JSON.stringify({
        model: this.model(req),
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(req.effort ? { reasoning_effort: req.effort } : {}),
        ...(this.def.maxTokens ? { max_tokens: this.def.maxTokens } : {})
      })
    });

    if (!response.ok || !response.body) {
      emit({ type: 'error', message: await errorText(response) });
      return;
    }

    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') {
        break;
      }
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        emit({ type: 'text_delta', text: delta.content });
      }
      if (delta?.reasoning_content) {
        emit({ type: 'thinking_delta', text: delta.reasoning_content });
      }
      if (chunk.usage) {
        emit({ type: 'usage', usage: this.priceUsage(req, {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0
        }) });
      }
    }
  }

  private async sendAnthropic(req: SendRequest, key: string, emit: (event: AgentEvent) => void) {
    const url = `${trimSlash(this.def.baseUrl!)}/messages`;
    const system = systemText(this.def, req);
    const response = await fetch(url, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        ...(this.def.headers ?? {})
      },
      body: JSON.stringify({
        model: this.model(req),
        max_tokens: this.def.maxTokens ?? 8192,
        stream: true,
        ...(req.thinking && this.def.supportsThinking
          ? { thinking: { type: 'enabled', budget_tokens: Math.floor((this.def.maxTokens ?? 8192) / 2) } }
          : {}),
        ...(system ? { system } : {}),
        messages: [...req.history, { role: 'user', content: anthropicContent(req) }]
      })
    });

    if (!response.ok || !response.body) {
      emit({ type: 'error', message: await errorText(response) });
      return;
    }

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for await (const data of sseData(response.body)) {
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === 'message_start') {
        const raw = event.message?.usage ?? {};
        usage.inputTokens = raw.input_tokens ?? 0;
        usage.cacheReadTokens = raw.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens = raw.cache_creation_input_tokens ?? 0;
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          emit({ type: 'text_delta', text: event.delta.text });
        } else if (event.delta?.type === 'thinking_delta') {
          emit({ type: 'thinking_delta', text: event.delta.thinking });
        }
      } else if (event.type === 'message_delta') {
        usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
      } else if (event.type === 'error') {
        emit({ type: 'error', message: event.error?.message ?? t('err.api') });
      }
    }

    emit({ type: 'usage', usage: this.priceUsage(req, usage) });
  }

  /** Adds a cost estimate when the model carries a pricing table. */
  private priceUsage(req: SendRequest, usage: TokenUsage): TokenUsage {
    const model: ModelDef | undefined = this.def.models?.find((m) => m.id === this.model(req));
    const pricing = model?.pricing;
    if (!pricing) {
      return usage;
    }
    const perMillion = (tokens: number, rate?: number) => (rate ? (tokens / 1_000_000) * rate : 0);
    usage.costUsd =
      perMillion(usage.inputTokens, pricing.input) +
      perMillion(usage.outputTokens, pricing.output) +
      perMillion(usage.cacheWriteTokens, pricing.cacheWrite) +
      perMillion(usage.cacheReadTokens, pricing.cacheRead);
    return usage;
  }
}

/** Prompt plus attachments; a plain string when there are no images, for text-only endpoints. */
function openAiContent(req: SendRequest): unknown {
  const files = req.attachments ?? [];
  const text = [...files.filter((f) => f.kind === 'text').map(inlineText), req.prompt].join('\n\n');
  const images = files.filter((f) => f.kind === 'image');
  if (!images.length) {
    return text;
  }
  return [
    ...images.map((f) => ({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${readBase64(f)}` } })),
    { type: 'text', text }
  ];
}

function anthropicContent(req: SendRequest): unknown {
  const files = req.attachments ?? [];
  if (!files.length) {
    return req.prompt;
  }
  const blocks: unknown[] = [];
  for (const file of files) {
    if (file.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mime, data: readBase64(file) } });
    } else if (file.kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: readBase64(file) } });
    } else if (file.kind === 'text') {
      blocks.push({ type: 'text', text: inlineText(file) });
    }
  }
  blocks.push({ type: 'text', text: req.prompt });
  return blocks;
}

/** The provider's own system prompt plus per-request instructions. */
function systemText(def: ProviderDef, req: SendRequest): string {
  return [def.systemPrompt, req.instructions].filter(Boolean).join('\n\n');
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return `HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 600)}` : ''}`;
}

/** Yields the payload of each `data:` line of an SSE stream. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        yield trimmed.slice(5).trim();
      }
    }
  }
}
