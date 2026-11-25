/**
 * Root-only auto-adder for appending newly fixed real failures to a project's past-task set.
 *
 * Fail-closed rules:
 * 1. The dataset path (and any external test patch path) MUST sit outside every repo checkout,
 *    `.git`, and builder worktree (`assertOutsideAgentTrees`).
 * 2. The task MUST be trusted (`origin_trusted === true`) OR carry a verified
 *    `approved_scope_sha256` matching SHA-256 of its approved `work_order`.
 * 3. Its 48-hour post-release watch MUST have passed (`release_watch_passed === true`).
 * 4. Candidate text, grader commands, and inline patches MUST contain zero secret patterns.
 * 5. Existing task IDs are NEVER overwritten.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findSecretMatches } from './bench.ts';
import {
  type LoadSetOptions,
  PAST_TASK_BENCH_ID,
  type PastTaskSet,
  type SolveTask,
  assertOutsideAgentTrees,
  isSha256Hex,
  loadPastTaskSet,
  resolveCanonicalPath,
  validatePastTaskSet,
  validateTask,
} from './schema.ts';

/** Raised when `addFixedFailureToSet` rejects a candidate task. */
export class IntakeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntakeRejectedError';
  }
}

export interface IntakeOptions extends LoadSetOptions {
  /** When set, `approved_scope_sha256` must also match this approved scope digest. */
  readonly expectedScopeSha256?: string;
  /** Create a new dataset file if `setPath` does not exist yet (default `false`). */
  readonly createIfMissing?: boolean;
}

export interface IntakeResult {
  readonly added: true;
  readonly path: string;
  readonly taskId: string;
  readonly totalTasks: number;
}

/** Compute lowercase hex SHA-256 of an approved work-order / scope text. */
export function computeScopeSha256(workOrder: string): string {
  return createHash('sha256').update(workOrder, 'utf8').digest('hex');
}

function assertTrustGate(candidate: SolveTask, expectedScopeSha256?: string): void {
  if (candidate.origin_trusted) return;
  const declared = candidate.approved_scope_sha256;
  if (declared === undefined || !isSha256Hex(declared)) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: untrusted task requires origin_trusted=true or a verified approved_scope_sha256`
    );
  }
  const actual = computeScopeSha256(candidate.work_order);
  if (declared.toLowerCase() !== actual) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: approved_scope_sha256 does not match work_order content`
    );
  }
  if (expectedScopeSha256 !== undefined && declared.toLowerCase() !== expectedScopeSha256.toLowerCase()) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: approved_scope_sha256 does not match expected approved scope`
    );
  }
}

function assertReleaseWatchPassed(candidate: SolveTask): void {
  if (!candidate.release_watch_passed) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: 48-hour release watch has not passed (release_watch_passed=false)`
    );
  }
}

function collectCandidateText(candidate: SolveTask): string {
  const parts: string[] = [candidate.work_order];
  const flattenCommand = (cmd: string | readonly string[]): string =>
    typeof cmd === 'string' ? cmd : cmd.join(' ');
  for (const cmd of candidate.grader.project_tests) parts.push(flattenCommand(cmd));
  for (const cmd of candidate.grader.scenarios ?? []) parts.push(flattenCommand(cmd));
  const merged = candidate.grader.merged_change_tests;
  if (merged !== undefined) {
    for (const cmd of merged.commands) parts.push(flattenCommand(cmd));
    if (merged.patch !== undefined) {
      const isInline = merged.patch.includes('\n');
      parts.push(isInline ? merged.patch : existsSync(merged.patch) ? readFileSync(merged.patch, 'utf8') : merged.patch);
    }
  }
  return parts.join('\n');
}

function assertNoSecretsInCandidate(candidate: SolveTask): void {
  const matches = findSecretMatches(collectCandidateText(candidate));
  if (matches.length > 0) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: contains potential secret (${matches[0]})`
    );
  }
}

function assertPatchOutsideAgentTrees(candidate: SolveTask, options: LoadSetOptions): void {
  const patch = candidate.grader.merged_change_tests?.patch;
  if (patch === undefined || patch.includes('\n')) return;
  assertOutsideAgentTrees(patch, options);
}

function validateCandidateSchema(candidate: SolveTask): SolveTask {
  const problems: string[] = [];
  const validated = validateTask(candidate, `candidate ${candidate.id}`, problems);
  if (problems.length > 0 || validated === undefined || validated.kind !== 'solve') {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} failed schema validation: ${problems.join('; ') || 'must be a solve task'}`
    );
  }
  return validated;
}

function loadOrInitializeSet(
  setPath: string,
  project: string,
  options: IntakeOptions
): PastTaskSet {
  const canonicalPath = resolveCanonicalPath(setPath);
  if (existsSync(canonicalPath)) {
    return loadPastTaskSet(setPath, options);
  }
  if (!options.createIfMissing) {
    throw new IntakeRejectedError(`past-task set does not exist at ${setPath}`);
  }
  return {
    bench: PAST_TASK_BENCH_ID,
    version: 1,
    project,
    tasks: [],
  };
}

/**
 * Append a newly fixed real failure to `setPath` atomically after enforcing all
 * isolation, trust, 48-hour watch, secret-scan, and no-overwrite gates.
 */
export function addFixedFailureToSet(
  setPath: string,
  candidate: SolveTask,
  options: IntakeOptions
): IntakeResult {
  assertOutsideAgentTrees(setPath, options);
  assertPatchOutsideAgentTrees(candidate, options);
  const validated = validateCandidateSchema(candidate);
  assertTrustGate(validated, options.expectedScopeSha256);
  assertReleaseWatchPassed(validated);
  assertNoSecretsInCandidate(validated);

  const existing = loadOrInitializeSet(setPath, validated.project, options);
  if (existing.project !== validated.project) {
    throw new IntakeRejectedError(
      `candidate ${validated.id} project "${validated.project}" does not match dataset project "${existing.project}"`
    );
  }
  if (existing.tasks.some(task => task.id === validated.id)) {
    throw new IntakeRejectedError(
      `candidate ${validated.id} already exists in ${setPath}; existing tasks are never overwritten`
    );
  }

  const nextSet = validatePastTaskSet(
    {
      bench: existing.bench,
      version: existing.version,
      project: existing.project,
      tasks: [...existing.tasks, validated],
    },
    setPath
  );

  const canonicalPath = resolveCanonicalPath(setPath);
  mkdirSync(dirname(canonicalPath), { recursive: true });
  const tempPath = `${canonicalPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(nextSet, null, 2)}\n`, 'utf8');
  renameSync(tempPath, canonicalPath);

  return {
    added: true,
    path: canonicalPath,
    taskId: validated.id,
    totalTasks: nextSet.tasks.length,
  };
}
