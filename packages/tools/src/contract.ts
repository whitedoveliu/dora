import type { AccountRef, Attachment, Db, DoraConfig, DoraServices, FlagMap, SessionRecord } from '@dora/core';
import type { Trait } from '@dora/core';

/**
 * The tool surface.
 *
 * Every action is one page with four sections — DETAILS, USAGE, OPTIONS, OUTPUT JSON —
 * and belongs to a trait of the capability matrix, which is what decides whether a role
 * may call it at all.
 */
export type OptionType = 'string' | 'string[]' | 'integer' | 'boolean' | 'json';

export interface OptionSpec {
  flag: string;
  type: OptionType;
  required?: boolean;
  description: string;
  values?: string[];
  min?: number;
  max?: number;
  default?: string;
}

export interface ActionContext {
  session: SessionRecord;
  account: AccountRef;
  flags: FlagMap;
  services: DoraServices;
  config: DoraConfig;
  db: Db;
  json: boolean;
  /** Workspace root of the calling session, when the call came from a sandbox. */
  workspace?: string;
}

export interface ActionResult {
  stdout?: string;
  json?: unknown;
  attachments?: Attachment[];
  exitCode?: number;
}

export type ActionHandler = (ctx: ActionContext, args: Record<string, unknown>) => Promise<ActionResult>;

export interface ActionContract {
  path: string;
  family: string;
  name: string;
  summary: string;
  details: string[];
  usage: string[];
  options: OptionSpec[];
  outputJson: string | null;
  trait: Trait;
  /** Connector that must be connected for this page to carry a contract. */
  connector?: string;
  builtin?: boolean;
  handler: ActionHandler;
}

export interface FamilyContract {
  name: string;
  title: string;
  description: string;
  connector?: string;
  declaredActions?: number;
}

export function defineAction(contract: ActionContract): ActionContract {
  return contract;
}
