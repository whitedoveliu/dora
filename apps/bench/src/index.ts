import { join, resolve } from 'node:path';
import { runBench, renderReport } from './runner.ts';
import { TASKS } from './tasks.ts';

export * from './runner.ts';
export * from './tasks.ts';

/** dora bench — run the task suite and write a report next to the logs. */
export interface BenchCliOptions {
  only?: string[];
  difficulty?: string;
  dir?: string;
  mock?: boolean;
  list?: boolean;
  json?: boolean;
}

export function parseBenchArgs(argv: string[]): BenchCliOptions {
  const options: BenchCliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--only') options.only = (argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (token === '--difficulty') options.difficulty = argv[i + 1];
    else if (token === '--dir') options.dir = argv[i + 1];
    else if (token === '--mock') options.mock = true;
    else if (token === '--list') options.list = true;
    else if (token === '--json') options.json = true;
  }
  return options;
}

export async function benchMain(argv: string[]): Promise<number> {
  const options = parseBenchArgs(argv);
  if (options.list) {
    for (const task of TASKS) console.log(task.id.padEnd(20) + task.difficulty.padEnd(9) + task.title);
    return 0;
  }
  const benchDir = resolve(options.dir ?? join(process.cwd(), 'var', 'bench'));
  const report = await runBench({
    benchDir,
    only: options.only,
    difficulty: options.difficulty ?? 'all',
    mock: options.mock,
    onProgress: (line) => process.stdout.write(line + '\n')
  });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write('\n' + renderReport(report));
  process.stdout.write('report: ' + join(benchDir, 'report.md') + '\n');
  return report.totals.fail + report.totals.error === 0 ? 0 : 1;
}
