/**
 * Feature flags.
 *
 * Flags are per-account and decide (a) which actions are usable and (b) which
 * skill body text survives compilation: skill bodies contain {{flag:...}}
 * placeholders that the server substitutes per account before the text reaches
 * the model.
 */

export interface FlagSpec {
  name: string;
  default: boolean;
  description: string;
}

export const FLAG_REGISTRY: FlagSpec[] = [
  { name: 'agent_chat', default: false, description: 'Web /agent chat surface. Off => "Agent chat feature not enabled"' },
  { name: 'whatsapp_channel', default: true, description: 'WhatsApp channel family' },
  { name: 'imessage_channel', default: true, description: 'iMessage/SMS channel family' },
  { name: 'agent_mail', default: true, description: 'Agent-owned mailbox (<handle>@mail.dora.ai)' },
  { name: 'cloud_browser', default: true, description: 'Rented cloud browser + lease scheduler' },
  { name: 'link_payments', default: false, description: 'Payment links family' },
  { name: 'streaming_execution', default: true, description: 'Stream assistant text as it is written' },
  { name: 'proactive_value_creation', default: true, description: 'Platform-owned recurring task agents' },
  { name: 'supervisor_readonly_tools', default: true, description: 'Read-only supervisor projection of running work' },
  { name: 'supervisor_projection', default: false, description: 'Supervisor can project into a live session' },
  { name: 'supervisor_subscription_wakes', default: true, description: 'Supervisor-subscribed wakes' },
  { name: 'granola', default: false, description: 'Meeting transcript connector' },
  { name: 'voice_channel', default: false, description: 'Realtime voice channel' }
];

export type FlagMap = Record<string, boolean>;

export function defaultFlags(): FlagMap {
  const out: FlagMap = {};
  for (const spec of FLAG_REGISTRY) out[spec.name] = spec.default;
  return out;
}

const BLOCK = /\{\{flag:([a-z0-9_]+)\}\}([\s\S]*?)\{\{\/flag\}\}/g;
const INLINE = /\{\{flag:([a-z0-9_]+)\?([^:}]*):([^}]*)\}\}/g;

/**
 * Compile a document that may contain flag placeholders against an account's flags.
 * Unknown flags resolve to false so an unregistered placeholder can never leak text.
 */
export function applyFlagPlaceholders(text: string, flags: FlagMap): string {
  let out = text.replace(BLOCK, (_m, name: string, body: string) => (flags[name] ? body : ''));
  out = out.replace(INLINE, (_m, name: string, on: string, off: string) => (flags[name] ? on : off));
  return out;
}

export function listFlagPlaceholders(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(BLOCK)) names.add(m[1]);
  for (const m of text.matchAll(INLINE)) names.add(m[1]);
  return [...names];
}
