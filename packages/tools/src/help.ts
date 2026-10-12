import type { ActionContract } from './contract.ts';

/** Render one help page: DETAILS / USAGE / OPTIONS / OUTPUT JSON. */
export function renderHelpPage(contract: ActionContract): string {
  const lines: string[] = [];
  lines.push('===== tools help ' + contract.path + ' =====');
  lines.push(contract.summary);
  lines.push('');
  lines.push('DETAILS');
  for (const d of contract.details) lines.push(d);
  lines.push('');
  lines.push('USAGE');
  for (const u of contract.usage) lines.push(u);
  lines.push('');
  lines.push('OPTIONS');
  for (const o of contract.options) {
    const type = o.values ? o.type + ' Values: ' + o.values.join(', ') + '.' : o.type;
    const req = o.required ? ' (required)' : '';
    lines.push(o.flag + '   ' + type + ' ' + o.description + req);
  }
  lines.push('Value options also accept --<option>-stdin, which reads the value from stdin; at most one per command.');
  lines.push('');
  if (contract.outputJson) {
    lines.push('OUTPUT JSON');
    lines.push(contract.outputJson);
  } else {
    lines.push('OUTPUT JSON');
    lines.push('(this action has no separate return structure; the text output is the result)');
  }
  return lines.join('\n');
}

export function helpAttachmentName(target: string): string {
  return 'help:' + target;
}

export function renderStatusLine(connector: string): string {
  return 'STATUS unavailable: ' + connector + ' is not connected';
}

/** A short stub goes to stdout; the page itself travels as an attachment. */
export function renderHelpStub(targets: string[], attached: number, dropped: string[]): string {
  const parts: string[] = [];
  parts.push('help attached: ' + attached + ' page(s) for ' + targets.join(', '));
  if (dropped.length > 0) parts.push('not attached (too many pages): ' + dropped.join(', '));
  return parts.join('\n') + '\n';
}
