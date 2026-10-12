import type { OptionSpec, ActionContract, ActionHandler } from '../contract.ts';
import type { Trait } from '@dora/core';

export interface ActionSpec {
  family: string;
  name: string;
  summary: string;
  details?: string[];
  options?: OptionSpec[];
  outputJson?: string | null;
  trait: Trait;
  connector?: string;
  usage?: string[];
  handler: ActionHandler;
}

export function opt(flag: string, type: OptionSpec['type'], description: string, extra: Partial<OptionSpec> = {}): OptionSpec {
  return { flag, type, description, ...extra };
}

/** USAGE is generated from the option list: --flag VALUE, --flag VALUE... for arrays, --[no-]flag for booleans. */
export function buildUsage(family: string, name: string, options: OptionSpec[], single = false): string[] {
  const parts: string[] = ['tools ' + (single ? family : family + ' ' + name)];
  for (const o of options) {
    const token =
      o.type === 'boolean'
        ? '--[no-]' + o.flag.replace(/^--/, '')
        : o.type === 'string[]'
          ? o.flag + ' VALUE...'
          : o.flag + ' VALUE';
    parts.push(o.required ? token : '[' + token + ']');
  }
  parts.push('[--json]');
  parts.push('[--timeout SECONDS]');
  return [parts.join(' ')];
}

export function define(spec: ActionSpec): ActionContract {
  const options = spec.options ?? [];
  return {
    path: spec.family + '.' + spec.name,
    family: spec.family,
    name: spec.name,
    summary: spec.summary,
    details: spec.details ?? [],
    usage: spec.usage ?? buildUsage(spec.family, spec.name, options),
    options,
    outputJson: spec.outputJson ?? null,
    trait: spec.trait,
    connector: spec.connector,
    handler: spec.handler
  };
}

export function str(args: Record<string, unknown>, flag: string): string | null {
  const v = args[flag];
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? v.join(' ') : String(v);
}

export function num(args: Record<string, unknown>, flag: string): number | null {
  const v = args[flag];
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

export function bool(args: Record<string, unknown>, flag: string): boolean {
  return args[flag] === true;
}

export function list(args: Record<string, unknown>, flag: string): string[] {
  const v = args[flag];
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

export function requireArg(args: Record<string, unknown>, flag: string): string {
  const v = str(args, flag);
  if (v === null || v === '') throw new Error('missing required option: ' + flag);
  return v;
}

export function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return '(none)\n';
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const head = columns.map((c, i) => c.padEnd(widths[i])).join('  ');
  const body = rows.map((r) => columns.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  '));
  return [head, '-'.repeat(head.length), ...body].join('\n') + '\n';
}
