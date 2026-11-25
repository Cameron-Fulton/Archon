/**
 * Root-only auto-adder for appending newly fixed real failures to a project's past-task set.
 *
 * Fail-closed rules:
 * 1. The dataset path (and any external test patch path) MUST sit outside every repo checkout,
 *    `.git`, and builder worktree (`assertOutsideAgentTrees`), and external patch files MUST exist.
 * 2. The task MUST be trusted (`origin_trusted === true`) OR match an externally supplied
 *    `options.expectedScopeSha256` (self-attested `approved_scope_sha256` is NEVER accepted).
 * 3. Its 48-hour post-release watch MUST have passed (`release_watch_passed === true`).
 * 4. Candidate text, grader commands, and patches MUST contain zero secret patterns.
 * 5. Existing task IDs are NEVER overwritten, and writes use exclusive 0600 temp files.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findSecretMatches } from './bench.ts';
import {
  type LoadSetOptions,
  PAST_TASK_BENCH_ID,
  type PastTaskSet,
  type SolveTask,
  assertOutsideAgentTrees,
  isInlinePatch,
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
  /**
   * Required when `candidate.origin_trusted !== true`: the externally approved
   * 64-hex SHA-256 scope digest that `candidate.approved_scope_sha256` and
   * `sha256(candidate.work_order)` must both match.
   */
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
  if (expectedScopeSha256 === undefined || !isSha256Hex(expectedScopeSha256)) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: untrusted task requires an externally verified expectedScopeSha256 (self-attested approved_scope_sha256 is refused)`
    );
  }
  const declared = candidate.approved_scope_sha256;
  if (declared === undefined || !isSha256Hex(declared)) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: untrusted task is missing a valid 64-hex approved_scope_sha256`
    );
  }
  const expected = expectedScopeSha256.toLowerCase();
  if (declared.toLowerCase() !== expected) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: approved_scope_sha256 does not match expected approved scope`
    );
  }
  if (computeScopeSha256(candidate.work_order) !== expected) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: work_order digest does not match expected approved scope`
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

function assertExternalPatchValid(candidate: SolveTask, options: LoadSetOptions): void {
  const patch = candidate.grader.merged_change_tests?.patch;
  if (patch === undefined || isInlinePatch(patch)) return;
  assertOutsideAgentTrees(patch, options);
  const canonicalPatch = resolveCanonicalPath(patch);
  if (!existsSync(canonicalPatch) || !lstatSync(canonicalPatch).isFile()) {
    throw new IntakeRejectedError(
      `candidate ${candidate.id} rejected: external merged_change_tests patch does not exist or is not a regular file (${patch})`
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
      parts.push(
        isInlinePatch(merged.patch)
          ? merged.patch
          : readFileSync(resolveCanonicalPath(merged.patch), 'utf8')
      );
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

function writeAtomically(canonicalPath: string, nextSet: PastTaskSet): void {
  mkdirSync(dirname(canonicalPath), { recursive: true });
  const tempPath = `${canonicalPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(nextSet, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(tempPath, canonicalPath);
  } catch (error) {
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
    throw error;
  }
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
  const validated = validateCandidateSchema(candidate);
  assertExternalPatchValid(validated, options);
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
  writeAtomically(canonicalPath, nextSet);

  return {
    added: true,
    path: canonicalPath,
    taskId: validated.id,
    totalTasks: nextSet.tasks.length,
  };
}
