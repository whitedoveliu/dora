import type { ActionContract, OptionSpec } from './contract.ts';

export interface ParseIssue {
  kind: 'unknown_option' | 'unexpected_argument' | 'missing_value' | 'missing_required' | 'invalid_value' | 'unknown_action';
  message: string;
  hint?: string;
}

export interface ParsedInvocation {
  action: ActionContract | null;
  rawPath: string | null;
  args: Record<string, unknown>;
  json: boolean;
  timeoutSeconds: number | null;
  issues: ParseIssue[];
  stdinOption: string | null;
}

function coerce(spec: OptionSpec, raw: string[]): { value: unknown; issue?: ParseIssue } {
  const single = raw.length === 1 ? raw[0] : raw.join(' ');
  switch (spec.type) {
    case 'string':
      return { value: raw.length > 1 ? raw : single };
    case 'string[]':
      return { value: raw };
    case 'integer': {
      const n = Number.parseInt(single, 10);
      if (!Number.isFinite(n)) return { value: null, issue: { kind: 'invalid_value', message: spec.flag + ' expects an integer' } };
      if (spec.min !== undefined && n < spec.min) return { value: null, issue: { kind: 'invalid_value', message: spec.flag + ' must be >= ' + spec.min } };
      if (spec.max !== undefined && n > spec.max) return { value: null, issue: { kind: 'invalid_value', message: spec.flag + ' must be <= ' + spec.max } };
      return { value: n };
    }
    case 'boolean': {
      if (raw.length === 0) return { value: true };
      if (single === 'true') return { value: true };
      if (single === 'false') return { value: false };
      return { value: null, issue: { kind: 'invalid_value', message: spec.flag + ' expects true or false' } };
    }
    case 'json': {
      try {
        return { value: JSON.parse(single) };
      } catch {
        return { value: null, issue: { kind: 'invalid_value', message: spec.flag + ' expects JSON' } };
      }
    }
  }
}

/**
 * Parse "tools <family> <action> [--option value]" plus the two universal options that
 * every page declares: --json and --timeout.
 */
export function parseInvocation(argv: string[], action: ActionContract | null): ParsedInvocation {
  const issues: ParseIssue[] = [];
  const args: Record<string, unknown> = {};
  let json = false;
  let timeoutSeconds: number | null = null;
  let stdinOption: string | null = null;

  const specs = new Map<string, OptionSpec>();
  for (const o of action?.options ?? []) specs.set(o.flag, o);
  const seen = new Set<string>();

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      issues.push({ kind: 'unexpected_argument', message: 'unexpected argument: ' + token });
      i += 1;
      continue;
    }
    let name = token;
    let inlineValue: string | null = null;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      name = token.slice(0, eq);
      inlineValue = token.slice(eq + 1);
    }

    if (name === '--json') {
      json = true;
      i += 1;
      continue;
    }
    if (name === '--timeout') {
      const value = inlineValue ?? argv[i + 1];
      const n = Number.parseInt(value ?? '', 10);
      if (!Number.isFinite(n)) issues.push({ kind: 'missing_value', message: '--timeout expects seconds' });
      else timeoutSeconds = n;
      i += inlineValue !== null ? 1 : 2;
      continue;
    }
    if (name.endsWith('-stdin')) {
      const base = name.slice(0, -'-stdin'.length);
      const spec = specs.get(base) ?? (base === '--body' ? undefined : undefined);
      if (!spec) {
        issues.push({ kind: 'unknown_option', message: 'unknown option: ' + name });
        i += 1;
        continue;
      }
      if (stdinOption) issues.push({ kind: 'invalid_value', message: 'at most one --<option>-stdin per command' });
      stdinOption = base;
      seen.add(base);
      i += 1;
      continue;
    }
    if (name.startsWith('--no-')) {
      const base = '--' + name.slice('--no-'.length);
      const spec = specs.get(base);
      if (!spec || spec.type !== 'boolean') {
        issues.push({ kind: 'unknown_option', message: 'unknown option: ' + name });
        i += 1;
        continue;
      }
      args[base] = false;
      seen.add(base);
      i += 1;
      continue;
    }

    const spec = specs.get(name);
    if (!spec) {
      issues.push({ kind: 'unknown_option', message: 'unknown option: ' + name });
      i += 1;
      continue;
    }

    if (spec.type === 'boolean') {
      args[name] = true;
      seen.add(name);
      i += 1;
      continue;
    }

    if (inlineValue !== null) {
      const { value, issue } = coerce(spec, [inlineValue]);
      if (issue) issues.push(issue);
      else {
        if (spec.type === 'string[]' && Array.isArray(args[name])) (args[name] as string[]).push(...(value as string[]));
        else args[name] = value;
      }
      seen.add(name);
      i += 1;
      continue;
    }

    // consume one or more values until the next option
    const values: string[] = [];
    let j = i + 1;
    while (j < argv.length && !argv[j].startsWith('--')) {
      values.push(argv[j]);
      j += 1;
      // A scalar option takes exactly one value; a list keeps consuming.
      if (spec.type !== 'string[]') break;
    }
    if (values.length === 0) {
      issues.push({ kind: 'missing_value', message: name + ' expects a value' });
      i += 1;
      continue;
    }
    const { value, issue } = coerce(spec, values);
    if (issue) issues.push(issue);
    else {
      if (spec.type === 'string[]') {
        const existing = Array.isArray(args[name]) ? (args[name] as string[]) : [];
        args[name] = [...existing, ...(value as string[])];
      } else args[name] = value;
    }
    seen.add(name);
    i = j;
  }

  for (const spec of specs.values()) {
    if (spec.required && !seen.has(spec.flag)) {
      issues.push({ kind: 'missing_required', message: 'missing required option: ' + spec.flag });
    }
  }

  return {
    action,
    rawPath: action ? action.path : null,
    args,
    json,
    timeoutSeconds,
    issues,
    stdinOption
  };
}

/** Render a parse failure short, with a usage pointer. */
export function renderIssues(issues: ParseIssue[], action: ActionContract | null): string {
  const lines = issues.map((i) => 'error: ' + i.message);
  if (action) {
    lines.push('');
    lines.push('USAGE');
    for (const u of action.usage) lines.push(u);
    lines.push('Read the contract first: tools help ' + action.path);
  }
  return lines.join('\n') + '\n';
}
