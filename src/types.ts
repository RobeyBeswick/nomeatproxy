export interface Finding {
  rule: string;
  summary: string;
  targets: string[];
  evidence: string[];
  nextStep: string;
}

export interface CheckRequest {
  command: string;
  cwd: string;
  /** A stable session/worktree boundary, independent of shell `cd` commands. */
  workspace?: string;
  home?: string;
  /** Additional sensitive paths; no wildcard or ignore semantics. */
  protectedPaths?: string[];
}

export interface CheckResult {
  decision: 'pass' | 'deny';
  findings: Finding[];
  /** A pass means no configured rule blocked; gaps are never a safety certificate. */
  limitations: string[];
  elapsedMs: number;
}

export interface Command {
  argv: string[];
  dynamic: boolean[];
  glob: boolean[];
  cwd: string;
  contextUnknown: boolean;
}

export type InspectGit = (cwd: string, args: string[], timeoutMs?: number) => {
  ok: boolean;
  stdout: string;
  error?: string;
};
