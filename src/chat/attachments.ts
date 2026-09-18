import * as fs from 'node:fs';
import * as path from 'node:path';
import { Attachment, AttachmentKind, ProviderDef } from '../types';
import { t } from '../i18n';

/** Image types every vision API here accepts. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

/** Text files larger than this are not inlined into an API request. */
const MAX_INLINE_TEXT = 256 * 1024;
const MAX_IMAGE_BYTES: Record<string, number> = { anthropic: 5 * 1024 * 1024, openai: 20 * 1024 * 1024 };
const MAX_PDF_BYTES = 32 * 1024 * 1024;
/** Copies of dropped files older than this are removed. */
const TEMP_MAX_AGE_MS = 14 * 86_400_000;

export type SupportLevel = 'ok' | 'warn' | 'block';

export interface Support {
  level: SupportLevel;
  /** Why the model cannot take the file as is, for the chip tooltip and the composer notice. */
  note?: string;
}

/** Reads type and size of a file on disk. Undefined for directories and missing files. */
export function describeFile(filePath: string, temp = false): Attachment | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) {
    return undefined;
  }
  const ext = path.extname(filePath).toLowerCase();
  let kind: AttachmentKind;
  let mime: string;
  if (IMAGE_MIME[ext]) {
    kind = 'image';
    mime = IMAGE_MIME[ext];
  } else if (ext === '.pdf') {
    kind = 'pdf';
    mime = 'application/pdf';
  } else if (looksLikeText(filePath)) {
    kind = 'text';
    mime = 'text/plain';
  } else {
    kind = 'other';
    mime = 'application/octet-stream';
  }
  return {
    id: `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    path: filePath,
    name: temp ? path.basename(filePath).replace(/^\d+-/, '') : path.basename(filePath),
    kind,
    mime,
    size: stat.size
  };
}

/** No NUL byte in the first 8 KB. */
function looksLikeText(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return !buffer.subarray(0, read).includes(0);
  } catch {
    return false;
  }
}

/** Writes a file dropped from outside VS Code (no path available) into `dir`. */
export function storeDroppedFile(dir: string, name: string, base64: string): string {
  fs.mkdirSync(dir, { recursive: true });
  pruneOld(dir);
  const safe = path.basename(name).replace(/[^\w.\- ]+/g, '_') || 'file';
  const target = path.join(dir, `${Date.now()}-${safe}`);
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return target;
}

function pruneOld(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > TEMP_MAX_AGE_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      /* already gone */
    }
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Whether the provider's model can take `file`, and how. */
export function attachmentSupport(def: ProviderDef | undefined, modelId: string | undefined, file: Attachment): Support {
  if (!def) {
    return { level: 'block', note: t('att.noProvider') };
  }
  const model = def.models?.find((m) => m.id === (modelId ?? def.defaultModel));
  const name = model?.label ?? modelId ?? def.label;
  const inputs = model?.inputs;
  const sees = (kind: 'image' | 'pdf') => (inputs ? inputs.includes(kind) : undefined);

  if (def.kind === 'cli') {
    const pathOnly = t('att.pathOnly');
    if (def.protocol === 'codex-jsonl') {
      if (file.kind === 'image') {
        return sees('image') === false ? { level: 'warn', note: t('att.noImages', { name, pathOnly }) } : { level: 'ok' };
      }
      if (file.kind === 'pdf') {
        return { level: 'warn', note: t('att.noPdfDirect', { name, pathOnly }) };
      }
    } else if (file.kind === 'image' || file.kind === 'pdf') {
      return sees(file.kind) === false ? { level: 'warn', note: t(file.kind === 'pdf' ? 'att.cantPdf' : 'att.cantImages', { name, pathOnly }) } : { level: 'ok' };
    }
    return file.kind === 'other' ? { level: 'warn', note: t('att.binary', { pathOnly }) } : { level: 'ok' };
  }

  const api = def.api === 'anthropic' ? 'anthropic' : 'openai';
  switch (file.kind) {
    case 'image': {
      const supported = sees('image') ?? api === 'anthropic';
      if (!supported) {
        return { level: 'block', note: t('att.noImagesBlock', { name }) };
      }
      return file.size > MAX_IMAGE_BYTES[api]
        ? { level: 'block', note: t('att.imageTooBig', { size: megabytes(MAX_IMAGE_BYTES[api]) }) }
        : { level: 'ok' };
    }
    case 'pdf': {
      const supported = sees('pdf') ?? api === 'anthropic';
      if (!supported) {
        return { level: 'block', note: t('att.noPdfBlock', { name }) };
      }
      return file.size > MAX_PDF_BYTES
        ? { level: 'block', note: t('att.pdfTooBig', { size: megabytes(MAX_PDF_BYTES) }) }
        : { level: 'ok' };
    }
    case 'text':
      return file.size > MAX_INLINE_TEXT
        ? { level: 'block', note: t('att.textTooBig', { size: MAX_INLINE_TEXT / 1024 }) }
        : { level: 'ok' };
    default:
      return { level: 'block', note: t('att.unsupported', { name }) };
  }
}

/** Plain-text list of attached paths, appended to a CLI agent's prompt. */
export function attachmentList(files: Attachment[]): string {
  if (!files.length) {
    return '';
  }
  return `\n\nAttached files:\n${files.map((f) => `- ${f.path}`).join('\n')}`;
}

/** A text attachment wrapped for inlining into an API request. */
export function inlineText(file: Attachment): string {
  return `<file name="${file.name}">\n${fs.readFileSync(file.path, 'utf8')}\n</file>`;
}

export function readBase64(file: Attachment): string {
  return fs.readFileSync(file.path).toString('base64');
}
