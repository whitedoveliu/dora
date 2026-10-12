import type { AgentRole } from './types.ts';

/**
 * The capability model ("Your action space").
 *
 * Every action family declares the trait it belongs to. The trait — not the
 * action — decides what a role may do:
 *   direct      the role may invoke it
 *   partial     the role may invoke a reduced form of it
 *   delegated   the role must hand the work to a task agent
 *   unavailable the role may never invoke it
 */
export type CapabilityMode = 'direct' | 'partial' | 'delegated' | 'unavailable';

export type Trait =
  | 'channel.read'
  | 'channel.write'
  | 'task_agent.lifecycle'
  | 'task_agent.read'
  | 'todos.read'
  | 'todos.write'
  | 'work'
  | 'search'
  | 'orchestration'
  | 'resource.lifecycle'
  | 'browser.drive'
  | 'email.send'
  | 'invites'
  | 'wake.schedule'
  | 'wake.subscription';

export interface TraitRule {
  trait: Trait;
  main: CapabilityMode;
  task: CapabilityMode;
  note: string;
}

export const TRAIT_MATRIX: TraitRule[] = [
  { trait: 'channel.read', main: 'direct', task: 'direct', note: 'Both roles read channel context when the family exposes read tools.' },
  { trait: 'channel.write', main: 'direct', task: 'unavailable', note: 'Only the main agent writes to authenticated channels; a task agent reports proposed writes to its parent.' },
  { trait: 'task_agent.lifecycle', main: 'direct', task: 'unavailable', note: 'The main agent owns spawn/cleanup; a task agent exists only because its parent spawned it.' },
  { trait: 'task_agent.read', main: 'direct', task: 'partial', note: 'A task agent inspects only its siblings, never the whole fleet.' },
  { trait: 'todos.read', main: 'direct', task: 'direct', note: 'Durable outcome tracking is visible to both roles.' },
  { trait: 'todos.write', main: 'direct', task: 'unavailable', note: 'A task agent reports progress; the main agent mutates todos.' },
  { trait: 'work', main: 'delegated', task: 'direct', note: 'Integrations, files and web fetching are work; the main agent delegates it.' },
  { trait: 'search', main: 'direct', task: 'direct', note: 'Bounded first-pass grounding for the main agent; full research for a task agent.' },
  { trait: 'orchestration', main: 'direct', task: 'partial', note: 'The main agent schedules wakes and messages peers; a task agent may wake itself and message its parent.' },
  { trait: 'resource.lifecycle', main: 'partial', task: 'direct', note: 'The main agent coordinates the shared write lease; a task agent acquires and drives its own.' },
  { trait: 'browser.drive', main: 'unavailable', task: 'direct', note: 'Driving the rented browser is task-agent work.' },
  { trait: 'email.send', main: 'delegated', task: 'direct', note: 'Email is delegated work, governed by the Email permissions rules.' },
  { trait: 'invites', main: 'direct', task: 'unavailable', note: 'Early-access invites belong to the main agent alone.' },
  { trait: 'wake.schedule', main: 'direct', task: 'direct', note: 'Either role may schedule a wake for itself.' },
  { trait: 'wake.subscription', main: 'unavailable', task: 'direct', note: 'Event subscriptions belong to task agents; the supervisor_subscription_wakes flag adds the supervisor path.' }
];

const BY_TRAIT = new Map<Trait, TraitRule>(TRAIT_MATRIX.map((r) => [r.trait, r]));

export function traitRule(trait: Trait): TraitRule {
  const rule = BY_TRAIT.get(trait);
  if (!rule) throw new Error('unknown trait: ' + trait);
  return rule;
}

export function capabilityFor(role: AgentRole, trait: Trait): CapabilityMode {
  const rule = traitRule(trait);
  return role === 'main_agent' ? rule.main : rule.task;
}

export function canInvoke(role: AgentRole, trait: Trait): boolean {
  const mode = capabilityFor(role, trait);
  return mode === 'direct' || mode === 'partial';
}

/** The four-word action-space vocabulary. */
export function actionSpaceWord(mode: CapabilityMode): 'EXECUTABLE' | 'DELEGATED' | 'PARTIAL' | 'UNAVAILABLE' {
  switch (mode) {
    case 'direct':
      return 'EXECUTABLE';
    case 'delegated':
      return 'DELEGATED';
    case 'partial':
      return 'PARTIAL';
    case 'unavailable':
      return 'UNAVAILABLE';
  }
}

export interface DeniedReason {
  denied: true;
  mode: CapabilityMode;
  message: string;
}

export function denialFor(role: AgentRole, trait: Trait, actionPath: string): DeniedReason | null {
  const mode = capabilityFor(role, trait);
  const rule = traitRule(trait);
  if (mode === 'direct' || mode === 'partial') return null;
  const message =
    mode === 'delegated'
      ? `ACCESS delegated: \`${actionPath}\` is \`${actionSpaceWord(mode)}\` for ${role}. ${rule.note}\n` +
        'Do this through a task agent:\n' +
        "  tools tasks delegate --model-mode smart --task '<exactly what the task agent should do>'\n" +
        'The task agent starts with the tool contracts it needs already read, does the work, and reports back.'
      : `ACCESS unavailable: \`${actionPath}\` is \`${actionSpaceWord(mode)}\` for ${role}. ${rule.note}`;
  return { denied: true, mode, message };
}
