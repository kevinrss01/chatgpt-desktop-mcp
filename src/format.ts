import { asArray, asString, isRecord, toIsoTime, truncate } from './util.js';

export interface FormatOptions {
  includeToolCalls: boolean;
  includeToolOutputs: boolean;
  includeReasoning: boolean;
  maxCharsPerItem: number;
}

export interface FormattedItem {
  type: string;
  text?: string;
  status?: string;
  detail?: string;
}

export interface FormattedTurn {
  id: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  items: FormattedItem[];
}

function userText(content: unknown): string {
  const parts: string[] = [];
  for (const entry of asArray(content)) {
    if (!isRecord(entry)) continue;
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text);
    else if (entry.type === 'image' || entry.type === 'localImage') parts.push('[image]');
    else if (entry.type === 'mention' || entry.type === 'skill') parts.push(`[${String(entry.type)}: ${asString(entry.name) ?? asString(entry.path) ?? ''}]`);
  }
  return parts.join('\n');
}

function reasoningText(item: Record<string, unknown>): string {
  const summary = asArray(item.summary).filter((part): part is string => typeof part === 'string');
  return summary.join('\n');
}

function fileChangeDetail(item: Record<string, unknown>): string {
  return asArray(item.changes)
    .filter(isRecord)
    .map((change) => {
      const kind = isRecord(change.kind) ? asString(change.kind.type) : asString(change.kind);
      return `${kind ?? 'change'} ${asString(change.path) ?? '?'}`;
    })
    .join(', ');
}

export function formatItem(item: unknown, options: FormatOptions): FormattedItem | null {
  if (!isRecord(item)) return null;
  const type = asString(item.type) ?? 'unknown';
  const max = options.maxCharsPerItem;
  switch (type) {
    case 'userMessage':
      return { type, text: truncate(userText(item.content), max) };
    case 'agentMessage':
      return { type, text: truncate(asString(item.text) ?? '', max) };
    case 'plan':
      return { type, text: truncate(asString(item.text) ?? '', max) };
    case 'reasoning':
      return options.includeReasoning ? { type, text: truncate(reasoningText(item), max) } : null;
    case 'commandExecution': {
      if (!options.includeToolCalls) return null;
      const exit = typeof item.exitCode === 'number' ? ` (exit ${item.exitCode})` : '';
      const formatted: FormattedItem = {
        type,
        status: asString(item.status) ?? undefined,
        detail: truncate(`$ ${asString(item.command) ?? ''}${exit}`, max),
      };
      if (options.includeToolOutputs && typeof item.aggregatedOutput === 'string') {
        formatted.text = truncate(item.aggregatedOutput, max);
      }
      return formatted;
    }
    case 'fileChange':
      return options.includeToolCalls ? { type, status: asString(item.status) ?? undefined, detail: truncate(fileChangeDetail(item), max) } : null;
    case 'mcpToolCall': {
      if (!options.includeToolCalls) return null;
      const formatted: FormattedItem = {
        type,
        status: asString(item.status) ?? undefined,
        detail: `${asString(item.server) ?? '?'}.${asString(item.tool) ?? '?'}`,
      };
      if (options.includeToolOutputs && item.result !== undefined) formatted.text = truncate(JSON.stringify(item.result), max);
      return formatted;
    }
    case 'dynamicToolCall':
      return options.includeToolCalls
        ? { type, status: asString(item.status) ?? undefined, detail: `${asString(item.namespace) ?? ''}${item.namespace ? '.' : ''}${asString(item.tool) ?? '?'}` }
        : null;
    case 'webSearch':
      return options.includeToolCalls ? { type, detail: truncate(asString(item.query) ?? '', max) } : null;
    case 'collabAgentToolCall':
      return options.includeToolCalls ? { type, status: asString(item.status) ?? undefined, detail: asString(item.tool) ?? undefined } : null;
    case 'contextCompaction':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { type };
    default:
      return options.includeToolCalls ? { type } : null;
  }
}

export function formatTurn(turn: unknown, options: FormatOptions): FormattedTurn | null {
  if (!isRecord(turn)) return null;
  const error = isRecord(turn.error) ? asString(turn.error.message) : asString(turn.error);
  return {
    id: asString(turn.id) ?? 'unknown',
    status: asString(turn.status) ?? 'unknown',
    startedAt: toIsoTime(turn.startedAt),
    completedAt: toIsoTime(turn.completedAt),
    error,
    items: asArray(turn.items)
      .map((item) => formatItem(item, options))
      .filter((item): item is FormattedItem => item !== null),
  };
}

export function lastAgentMessage(turns: FormattedTurn[]): string | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type === 'agentMessage' && item.text) return item.text;
    }
  }
  return null;
}

export interface ChatSummary {
  id: string;
  title: string;
  preview: string;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  source: string;
  createdAt: string | null;
  updatedAt: string | null;
  archived?: boolean;
}

export function sourceKind(source: unknown): string {
  if (typeof source === 'string') return source;
  if (isRecord(source)) {
    const key = Object.keys(source)[0];
    return key ?? 'unknown';
  }
  return 'unknown';
}

export function summarizeThread(thread: unknown): ChatSummary | null {
  if (!isRecord(thread)) return null;
  const id = asString(thread.id);
  if (!id) return null;
  const preview = asString(thread.preview) ?? '';
  return {
    id,
    title: asString(thread.name) ?? truncate(preview.replace(/\s+/g, ' ').trim(), 80),
    preview: truncate(preview.replace(/\s+/g, ' ').trim(), 240),
    cwd: asString(thread.cwd),
    model: asString(thread.model),
    reasoningEffort: asString(thread.reasoningEffort),
    source: sourceKind(thread.source),
    createdAt: toIsoTime(thread.createdAt),
    updatedAt: toIsoTime(thread.updatedAt),
  };
}
