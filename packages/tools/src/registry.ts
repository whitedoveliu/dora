import type { ActionContract, FamilyContract } from './contract.ts';

export interface FamilyIndexEntry {
  name: string;
  title: string;
  actions: number;
  connected: boolean;
  implemented: number;
  /** Traits of the actions actually routed in this family. */
  traits: string[];
}

export interface ToolIndex {
  families: FamilyIndexEntry[];
  singles: string[];
  totalActions: number;
  declaredTotal: number;
}

export class ToolRegistry {
  private readonly actions = new Map<string, ActionContract>();
  private readonly families = new Map<string, FamilyContract>();

  registerFamily(family: FamilyContract): void {
    this.families.set(family.name, family);
  }

  register(action: ActionContract): void {
    if (this.actions.has(action.path)) throw new Error('duplicate action path: ' + action.path);
    this.actions.set(action.path, action);
  }

  get(path: string): ActionContract | null {
    return this.actions.get(path) ?? null;
  }

  family(name: string): FamilyContract | null {
    return this.families.get(name) ?? null;
  }

  hasFamily(name: string): boolean {
    return this.families.has(name);
  }

  /** Actions of a family, in declaration order (Map preserves insertion order). */
  familyActions(family: string): ActionContract[] {
    return [...this.actions.values()].filter((a) => a.family === family);
  }

  list(): ActionContract[] {
    return [...this.actions.values()];
  }

  listFamilies(): FamilyContract[] {
    return [...this.families.values()];
  }

  /**
   * The index a fresh session sees. The declared count is the surface a family advertises;
   * the implemented count is what this build actually routes.
   */
  index(isConnected: (connector: string) => boolean): ToolIndex {
    const families: FamilyIndexEntry[] = this.listFamilies().map((f) => {
      const actions = this.familyActions(f.name);
      const connected = f.connector ? isConnected(f.connector) : true;
      return {
        name: f.name,
        title: f.title,
        actions: f.declaredActions ?? actions.length,
        implemented: actions.length,
        connected,
        traits: [...new Set(actions.map((a) => a.trait))]
      };
    });
    const singles = [...this.actions.values()].filter((a) => !this.families.has(a.family)).map((a) => a.path);
    const totalActions = this.list().length;
    const declaredTotal = families.reduce((acc, f) => acc + f.actions, 0) + singles.length;
    return { families, singles, totalActions, declaredTotal };
  }
}

export interface ToolIndexRenderOptions {
  /** When set,每 family is marked with what this role may do directly. */
  role?: 'main_agent' | 'task_agent';
  modeForTrait?: (trait: string) => 'direct' | 'partial' | 'delegated' | 'unavailable';
}

export function renderToolIndex(index: ToolIndex, options: ToolIndexRenderOptions = {}): string {
  const lines: string[] = [];
  lines.push('Dora tools — action index');
  lines.push('families: ' + index.families.length + '  actions routed: ' + index.totalActions + '  catalogue: ' + index.declaredTotal);
  lines.push('');
  const width = Math.max(...index.families.map((f) => f.name.length), 8);
  for (const f of index.families) {
    const status = f.connected ? '' : '  [connector not connected: names only]';
    let marker = '';
    if (options.role && options.modeForTrait && f.traits.length > 0) {
      const modes = f.traits.map((t) => options.modeForTrait!(t));
      const usable = modes.filter((m) => m === 'direct' || m === 'partial').length;
      if (usable === 0) {
        marker = modes.includes('delegated') ? '  [delegate to a task agent]' : '  [not available to this role]';
      } else if (usable < modes.length) {
        marker = '  [partly delegable]';
      }
    }
    lines.push('  ' + f.name.padEnd(width) + '  ' + String(f.implemented).padStart(3) + '/' + String(f.actions).padEnd(4) + ' ' + f.title + marker + status);
  }
  if (index.singles.length > 0) {
    lines.push('');
    lines.push('single actions: ' + index.singles.join(', '));
  }
  void options;
  return lines.join('\n') + '\n';
}
