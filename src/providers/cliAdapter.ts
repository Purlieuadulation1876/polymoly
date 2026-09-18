import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { attachmentList } from '../chat/attachments';
import { AgentAdapter, AgentEvent, McpServerDef, ProviderDef, SendRequest, TokenUsage } from '../types';
import { t } from '../i18n';

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

let cachedPath: string | undefined;

/**
 * PATH of the user's login shell plus common install dirs. VS Code started from the
 * Dock/Finder only inherits launchd's minimal PATH, so CLIs in ~/.local/bin etc. are missing.
 */
function userPath(): string {
  if (cachedPath !== undefined) {
    return cachedPath;
  }
  const parts = (process.env.PATH ?? '').split(path.delimiter);
  if (process.platform !== 'win32') {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = /__PATH__(.*)__PATH__/.exec(out);
      if (match) {
        parts.push(...match[1].split(path.delimiter));
      }
    } catch {
      /* shell unavailable or slow; fall back to the fixed dirs below */
    }
    const home = os.homedir();
    parts.push(
      path.join(home, '.local', 'bin'),
      path.join(home, '.claude', 'local'),
      '/opt/homebrew/bin',
      '/usr/local/bin'
    );
  }
  cachedPath = [...new Set(parts.filter(Boolean))].join(path.delimiter);
  return cachedPath;
}

/** Absolute path for a bare command name, searched in userPath(); otherwise the input unchanged. */
function resolveCommand(command: string): string {
  if (process.platform === 'win32' || command.includes('/')) {
    return command;
  }
  for (const dir of userPath().split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return command;
}

/** Runs an agent CLI as a child process and translates its JSONL output into AgentEvents. */
export class CliAdapter implements AgentAdapter {
  constructor(readonly def: ProviderDef) {}

  async check(): Promise<{ ok: boolean; detail: string }> {
    const command = this.def.command;
    if (!command) {
      return { ok: false, detail: t('err.noCommand') };
    }
    return new Promise((resolve) => {
      const child = spawn(resolveCommand(command), ['--version'], {
        env: { ...process.env, PATH: userPath() },
        shell: process.platform === 'win32'
      });
      let out = '';
      child.stdout?.on('data', (d) => (out += String(d)));
      child.on('error', () => resolve({ ok: false, detail: t('err.commandNotFound', { command }) }));
      child.on('close', (code) =>
        resolve(
          code === 0
            ? { ok: true, detail: out.trim() || command }
            : { ok: false, detail: `\`${command} --version\` endete mit Code ${code}.` }
        )
      );
    });
  }

  async send(req: SendRequest, emit: (event: AgentEvent) => void): Promise<void> {
    const command = this.def.command;
    if (!command) {
      emit({ type: 'error', message: t('err.noCommand') });
      emit({ type: 'done' });
      return;
    }

    const protocol = this.def.protocol ?? 'claude-stream-json';
    const { args, useStdin } =
      protocol === 'claude-stream-json' ? this.claudeArgs(req) : this.codexArgs(req);

    const env: NodeJS.ProcessEnv = { ...process.env, PATH: userPath(), ...(this.def.env ?? {}) };
    if (protocol === 'claude-stream-json' && req.thinking === false) {
      env.MAX_THINKING_TOKENS = '0';
    }

    const child = spawn(resolveCommand(command), args, {
      cwd: req.cwd,
      env,
      shell: process.platform === 'win32'
    });

    const onAbort = () => child.kill('SIGTERM');
    req.signal.addEventListener('abort', onAbort, { once: true });

    if (useStdin) {
      child.stdin.write(req.prompt + attachmentList(req.attachments ?? []));
    }
    child.stdin.end();

    const parse =
      protocol === 'claude-stream-json' ? makeClaudeParser(emit) : makeCodexParser(emit);

    let stdoutRest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutRest += chunk;
      const lines = stdoutRest.split('\n');
      stdoutRest = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          parse(JSON.parse(trimmed));
        } catch {
          emit({ type: 'notice', text: trimmed });
        }
      }
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    await new Promise<void>((resolve) => {
      child.on('error', (err) => {
        emit({ type: 'error', message: `${command}: ${err.message}` });
        resolve();
      });
      child.on('close', (code) => {
        if (stdoutRest.trim()) {
          try {
            parse(JSON.parse(stdoutRest.trim()));
          } catch {
            /* trailing partial line, ignore */
          }
        }
        if (code !== 0 && !req.signal.aborted) {
          emit({ type: 'error', message: stderr.trim() || `${command} endete mit Code ${code}.` });
        }
        resolve();
      });
    });

    req.signal.removeEventListener('abort', onAbort);
    emit({ type: 'done' });
  }

  private claudeArgs(req: SendRequest): { args: string[]; useStdin: boolean } {
    const permissionMode = vscode.workspace
      .getConfiguration('polyagent')
      .get<string>('claude.permissionMode', 'acceptEdits');

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      permissionMode
    ];
    if (req.model) {
      args.push('--model', req.model);
    }
    if (req.effort) {
      args.push('--effort', req.effort);
    }
    if (req.sessionId) {
      args.push('--resume', req.sessionId);
    }
    if (req.instructions) {
      args.push('--append-system-prompt', req.instructions);
    }
    if (req.skillsDir) {
      args.push('--add-dir', req.skillsDir);
    }
    const mcpFile = writeClaudeMcpConfig(req.mcpServers);
    if (mcpFile) {
      args.push('--mcp-config', mcpFile);
    }
    args.push(...(this.def.extraArgs ?? []));
    return { args, useStdin: true };
  }

  private codexArgs(req: SendRequest): { args: string[]; useStdin: boolean } {
    const sandbox = vscode.workspace
      .getConfiguration('polyagent')
      .get<string>('codex.sandbox', 'workspace-write');

    const args = ['exec'];
    if (req.sessionId) {
      args.push('resume', req.sessionId);
    }
    args.push('--json', '--sandbox', sandbox, '--skip-git-repo-check');
    if (req.effort) {
      args.push('-c', `model_reasoning_effort=${tomlString(req.effort)}`);
    }
    if (req.model) {
      args.push('--model', req.model);
    }
    args.push(...codexMcpArgs(req.mcpServers));
    args.push(...(this.def.extraArgs ?? []));
    const files = req.attachments ?? [];
    for (const image of files.filter((f) => f.kind === 'image')) {
      args.push(`--image=${image.path}`);
    }
    // codex exec has no system-prompt flag; a new thread gets the instructions ahead of the prompt.
    const preamble = req.instructions && !req.sessionId ? `<instructions>\n${req.instructions}\n</instructions>\n\n` : '';
    // `--image` takes several values; `--` keeps the prompt from being read as one.
    args.push('--', preamble + req.prompt + attachmentList(files.filter((f) => f.kind !== 'image')));
    return { args, useStdin: false };
  }
}

/** Parser for `claude -p --output-format stream-json --include-partial-messages`. */
function makeClaudeParser(emit: (event: AgentEvent) => void): (msg: any) => void {
  let sawPartial = false;

  return (msg: any) => {
    switch (msg?.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          emit({ type: 'session', sessionId: msg.session_id, model: msg.model });
        }
        return;

      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {};
        const windows = Object.entries(info.unifiedWindows ?? {}).map(([name, window]: [string, any]) => ({
          name,
          utilization: Number(window?.utilization ?? 0),
          resetsAt: window?.resetsAt
        }));
        if (windows.length) {
          emit({
            type: 'rate_limit',
            info: {
              status: info.status,
              windows,
              isUsingOverage: Boolean(info.isUsingOverage),
              observedAt: new Date().toISOString()
            }
          });
        }
        return;
      }

      case 'stream_event': {
        const event = msg.event;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            sawPartial = true;
            emit({ type: 'text_delta', text: delta.text });
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            sawPartial = true;
            emit({ type: 'thinking_delta', text: delta.thinking });
          }
        }
        return;
      }

      case 'assistant': {
        const blocks = msg.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'tool_use') {
            emit({ type: 'tool_start', id: block.id, name: block.name, input: block.input });
          } else if (block.type === 'text' && !sawPartial && block.text) {
            emit({ type: 'text_delta', text: block.text });
          } else if (block.type === 'thinking' && !sawPartial && block.thinking) {
            emit({ type: 'thinking_delta', text: block.thinking });
          }
        }
        return;
      }

      case 'user': {
        const blocks = msg.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            emit({
              type: 'tool_end',
              id: block.tool_use_id,
              output: stringifyToolOutput(block.content),
              isError: Boolean(block.is_error)
            });
          }
        }
        return;
      }

      case 'result': {
        const usage = emptyUsage();
        const raw = msg.usage ?? {};
        usage.inputTokens = raw.input_tokens ?? 0;
        usage.outputTokens = raw.output_tokens ?? 0;
        usage.cacheReadTokens = raw.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens = raw.cache_creation_input_tokens ?? 0;
        if (typeof msg.total_cost_usd === 'number') {
          usage.costUsd = msg.total_cost_usd;
        }
        emit({ type: 'usage', usage });
        if (msg.subtype && msg.subtype !== 'success') {
          emit({ type: 'error', message: msg.result ?? `Lauf endete mit "${msg.subtype}".` });
        }
        return;
      }

      default:
        return;
    }
  };
}

/** Parser for `codex exec --json`, tolerant of both the item and the msg event shapes. */
function makeCodexParser(emit: (event: AgentEvent) => void): (msg: any) => void {
  const openItems = new Map<string, string>();
  let emittedText = false;

  return (msg: any) => {
    // Older protocol: {"id":"0","msg":{"type":"agent_message_delta","delta":"..."}}
    const inner = msg?.msg;
    if (inner?.type) {
      switch (inner.type) {
        case 'session_configured':
          if (inner.session_id) {
            emit({ type: 'session', sessionId: inner.session_id, model: inner.model });
          }
          return;
        case 'agent_message_delta':
          emittedText = true;
          emit({ type: 'text_delta', text: inner.delta ?? '' });
          return;
        case 'agent_reasoning_delta':
          emit({ type: 'thinking_delta', text: inner.delta ?? '' });
          return;
        case 'agent_message':
          if (!emittedText && inner.message) {
            emit({ type: 'text_delta', text: inner.message });
          }
          return;
        case 'exec_command_begin':
          emit({
            type: 'tool_start',
            id: String(inner.call_id ?? msg.id),
            name: 'shell',
            input: inner.command
          });
          return;
        case 'exec_command_end':
          emit({
            type: 'tool_end',
            id: String(inner.call_id ?? msg.id),
            output: inner.stdout ?? inner.stderr ?? '',
            isError: inner.exit_code !== 0
          });
          return;
        case 'token_count': {
          const info = inner.info?.last_token_usage ?? inner.info?.total_token_usage ?? inner;
          emit({
            type: 'usage',
            usage: {
              inputTokens: info.input_tokens ?? 0,
              outputTokens: info.output_tokens ?? 0,
              cacheReadTokens: info.cached_input_tokens ?? 0,
              cacheWriteTokens: 0
            }
          });
          return;
        }
        case 'error':
          emit({ type: 'error', message: inner.message ?? t('err.codexUnknown') });
          return;
        default:
          return;
      }
    }

    // Current protocol: thread/turn/item events.
    switch (msg?.type) {
      case 'thread.started':
        if (msg.thread_id) {
          emit({ type: 'session', sessionId: msg.thread_id });
        }
        return;

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = msg.item ?? {};
        const itemType = item.item_type ?? item.type;
        const id = String(item.id ?? openItems.size);

        if (itemType === 'error') {
          emit({ type: 'error', message: item.message ?? t('err.codex') });
          return;
        }

        if (itemType === 'agent_message') {
          if (msg.type === 'item.completed' && item.text) {
            const already = openItems.get(id) ?? '';
            const rest = item.text.startsWith(already) ? item.text.slice(already.length) : item.text;
            if (rest) {
              emit({ type: 'text_delta', text: rest });
            }
            openItems.set(id, item.text);
          } else if (item.text) {
            const already = openItems.get(id) ?? '';
            if (item.text.length > already.length) {
              emit({ type: 'text_delta', text: item.text.slice(already.length) });
              openItems.set(id, item.text);
            }
          }
          return;
        }

        if (itemType === 'reasoning' && item.text) {
          const already = openItems.get(id) ?? '';
          if (item.text.length > already.length) {
            emit({ type: 'thinking_delta', text: item.text.slice(already.length) });
            openItems.set(id, item.text);
          }
          return;
        }

        if (itemType === 'command_execution' || itemType === 'file_change' || itemType === 'mcp_tool_call') {
          if (msg.type === 'item.started') {
            emit({
              type: 'tool_start',
              id,
              name: itemType === 'command_execution' ? 'shell' : itemType,
              input: item.command ?? item.changes ?? item.arguments
            });
          } else if (msg.type === 'item.completed') {
            emit({
              type: 'tool_end',
              id,
              output: stringifyToolOutput(item.aggregated_output ?? item.output ?? item.result),
              isError: typeof item.exit_code === 'number' ? item.exit_code !== 0 : item.status === 'failed'
            });
          }
        }
        return;
      }

      case 'turn.completed': {
        const raw = msg.usage ?? {};
        emit({
          type: 'usage',
          usage: {
            inputTokens: raw.input_tokens ?? 0,
            outputTokens: raw.output_tokens ?? 0,
            cacheReadTokens: raw.cached_input_tokens ?? 0,
            cacheWriteTokens: 0
          }
        });
        return;
      }

      case 'turn.failed':
      case 'error':
        emit({ type: 'error', message: msg.error?.message ?? msg.message ?? t('err.codex') });
        return;

      default:
        return;
    }
  };
}

/** Writes the shared MCP servers in the `--mcp-config` format and returns the file path. */
function writeClaudeMcpConfig(servers: Record<string, McpServerDef> | undefined): string | undefined {
  const entries = Object.entries(servers ?? {});
  if (!entries.length) {
    return undefined;
  }
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of entries) {
    const { disabled: _disabled, ...rest } = server;
    mcpServers[name] = 'url' in rest ? rest : { type: 'stdio', ...rest };
  }
  const file = path.join(os.tmpdir(), `polyagent-mcp-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return file;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlTable(values: Record<string, string>): string {
  return `{${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')}}`;
}

/** Shared MCP servers as `codex -c mcp_servers.<name>.<field>=<toml>` overrides. */
function codexMcpArgs(servers: Record<string, McpServerDef> | undefined): string[] {
  const args: string[] = [];
  for (const [name, server] of Object.entries(servers ?? {})) {
    const key = `mcp_servers.${name}`;
    if ('url' in server) {
      args.push('-c', `${key}.url=${tomlString(server.url)}`);
      if (server.headers && Object.keys(server.headers).length) {
        args.push('-c', `${key}.http_headers=${tomlTable(server.headers)}`);
      }
    } else {
      args.push('-c', `${key}.command=${tomlString(server.command)}`);
      args.push('-c', `${key}.args=[${(server.args ?? []).map(tomlString).join(', ')}]`);
      if (server.env && Object.keys(server.env).length) {
        args.push('-c', `${key}.env=${tomlTable(server.env)}`);
      }
    }
  }
  return args;
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.text ?? JSON.stringify(part)))
      .join('\n');
  }
  if (content == null) {
    return '';
  }
  return JSON.stringify(content, null, 2);
}
