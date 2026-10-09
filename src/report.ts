import type { CheckResult } from './types.js';

export function report(result: CheckResult, gaps = true): string {
  const lines = result.decision === 'deny'
    ? ['NoMeatProxy stopped this tool call.', ...result.findings.flatMap(f => [
      '', `[${f.rule}] ${f.summary}`,
      ...f.targets.map(t => `  Target: ${JSON.stringify(t)}`),
      ...f.evidence.map(e => `  Evidence: ${JSON.stringify(e)}`),
      `  Next: ${f.nextStep}`,
    ])]
    : ['NoMeatProxy found no blocking rule for this command. This is not a guarantee of safety.'];
  if (gaps && result.limitations.length) {
    lines.push('', 'Inspection gaps:', ...result.limitations.map(l => `  - ${l}`));
  }
  return lines.join('\n');
}
