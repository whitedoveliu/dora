import { BashBlockedError } from '@dora/core';

/**
 * bash content filters.
 *
 * Two classes are blocked outright:
 *   1. a shell-expandable $ that looks like an amount;
 *   2. multi-line quoted arguments — the caller must move the text to
 *      --<option>-stdin and pass it on stdin (a heredoc).
 */
export interface FilterVerdict {
  blocked: boolean;
  kind?: 'dollar_amount' | 'multiline_quote';
  message?: string;
  hint?: string;
}

const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?/;
const MULTILINE_QUOTE = /(['"])(?:[^'"\\]|\\.)*\n[\s\S]*?\1/;

export function inspectCommand(command: string): FilterVerdict {
  const amount = AMOUNT.exec(command);
  if (amount) {
    return {
      blocked: true,
      kind: 'dollar_amount',
      message: 'Blocked: the command contains a shell-expandable amount (' + amount[0] + '). Amounts must not travel through bash expansion.',
      hint: 'Quote the text, write it to a file and read it, or pass the value to a tool option on stdin.'
    };
  }
  const multiline = MULTILINE_QUOTE.exec(command);
  if (multiline) {
    return {
      blocked: true,
      kind: 'multiline_quote',
      message: 'Blocked: a multi-line quoted argument was passed inline.',
      hint: 'Use --<option>-stdin with a heredoc from stdin instead of an inline multi-line argument.'
    };
  }
  return { blocked: false };
}

export function assertCommandAllowed(command: string): void {
  const verdict = inspectCommand(command);
  if (verdict.blocked) {
    throw new BashBlockedError(verdict.message ?? 'command blocked', { kind: verdict.kind, hint: verdict.hint });
  }
}

/** True when the command writes stdout to a file, which loses tool attachments. */
export function redirectsStdoutToFile(command: string): boolean {
  return /(^|[^0-9>])>>?\s*[^\s&|]+/.test(command);
}

/** True when the command is (or pipes from) the tools CLI. */
export function invokesToolsCli(command: string): boolean {
  // Only a command position counts: start of line, after a separator, or inside $( ).
  return /(?:^|[;&|(]|\$\()\s*tools(?:\s|$)/.test(command);
}
