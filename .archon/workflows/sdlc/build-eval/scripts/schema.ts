/**
 * Past-task dataset schema, strict loader, isolation boundary guard, and reflector view.
 *
 * A project's past-task set MUST live outside every tree an agent or builder can read
 * (default `/var/lib/factory-eval/past-task-set`, configurable via `--set-dir` or
 * `FACTORY_PAST_TASK_DIR`). Loading fails closed whenever the dataset path resolves
 * inside the target repository checkout, `.git`, or any builder worktree.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git } from '../../.shared/git.ts';
import { isObject } from '../../.shared/typed.ts';

/** Root-only default directory on the factory host, outside every agent-readable tree. */
export const DEFAULT_PAST_TASK_DIR = '/var/lib/factory-eval/past-task-set';
export const PAST_TASK_DIR_ENV = 'FACTORY_PAST_TASK_DIR';
export const PAST_TASK_BENCH_ID = 'build-past-tasks';

export const TASK_SPLITS = ['reflector', 'held_back'] as const;
export type TaskSplit = (typeof TASK_SPLITS)[number];

export const REFUSAL_CLASSES = ['prompt_injection', 'secret_in_code', 'judge_modification'] as const;
export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

/** Deterministic code command: either an explicit argv array or a shell command string. */
export type GraderCommand = string | readonly string[];

export interface MergedChangeTestSpec {
  /** Optional unified diff (inline diff text or external patch file path) applied before running commands. */
  readonly patch?: string;
  readonly commands: readonly GraderCommand[];
}

export interface CodeGraderSpec {
  readonly project_tests: readonly GraderCommand[];
  readonly merged_change_tests?: MergedChangeTestSpec;
  readonly scenarios?: readonly GraderCommand[];
}

export interface SolveTask {
  readonly id: string;
  readonly kind: 'solve';
  readonly project: string;
  readonly parent_commit: string;
  readonly work_order: string;
  readonly split: TaskSplit;
  readonly origin_trusted: boolean;
  readonly approved_scope_sha256?: string;
  readonly release_watch_passed: boolean;
  readonly grader: CodeGraderSpec;
}

export interface ExpectedRefusalSpec {
  readonly require_blocked_or_refused?: boolean;
  readonly forbid_secret_patterns?: readonly string[];
  readonly forbid_modified_paths?: readonly string[];
}

export interface MustRefuseTask {
  readonly id: string;
  readonly kind: 'must_refuse';
  readonly project: string;
  readonly parent_commit: string;
  readonly refusal_class: RefusalClass;
  readonly work_order: string;
  readonly split: TaskSplit;
  readonly expected_refusal: ExpectedRefusalSpec;
}

export type PastTask = SolveTask | MustRefuseTask;

export interface PastTaskSet {
  readonly bench: typeof PAST_TASK_BENCH_ID;
  readonly version: 1;
  readonly project: string;
  readonly tasks: readonly PastTask[];
}

export interface LoadedPastTaskSet extends PastTaskSet {
  readonly path: string;
}

export interface LoadSetOptions {
  /** Target repository checkout that must never contain the dataset. */
  readonly repoRoot: string;
  /** Additional builder worktree roots that must never contain the dataset. */
  readonly worktreeRoots?: readonly string[];
}

/** Raised when a past-task dataset path violates the agent-isolation boundary. */
export class IsolationBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolationBoundaryError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const FORBIDDEN_LLM_GRADER_KEYS = new Set([
  'llm',
  'llm_judge',
  'judge',
  'judge_prompt',
  'prompt',
  'model',
  'provider',
  'rubric',
]);

export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && SHA1_PATTERN.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/**
 * Resolve the configured past-task dataset directory: explicit `--set-dir` wins,
 * then `FACTORY_PAST_TASK_DIR`, then the root-only factory default.
 */
export function resolvePastTaskDir(
  explicitDir?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromArg = explicitDir?.trim();
  if (fromArg !== undefined && fromArg !== '') return resolve(fromArg);
  const fromEnv = env[PAST_TASK_DIR_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv);
  return DEFAULT_PAST_TASK_DIR;
}

/**
 * Resolve `targetPath` through `realpathSync.native` (falling back to `realpathSync`),
 * walking up to the nearest existing ancestor when the leaf does not exist yet so
 * symlinks and Windows 8.3 short paths are always resolved to one canonical form.
 */
export function resolveCanonicalPath(targetPath: string): string {
  const absolute = resolve(targetPath);
  const tail: string[] = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    tail.unshift(relative(parent, current));
    current = parent;
  }
  const realBase = typeof realpathSync.native === 'function'
    ? realpathSync.native(current)
    : realpathSync(current);
  return tail.length === 0 ? realBase : join(realBase, ...tail);
}

function normalizeForCompare(pathValue: string): string {
  return process.platform === 'win32' ? pathValue.toLowerCase() : pathValue;
}

/** Whether `candidate` equals or lies beneath `root` after canonicalization. */
export function isPathInside(candidate: string, root: string): boolean {
  const normCandidate = normalizeForCompare(resolveCanonicalPath(candidate));
  const normRoot = normalizeForCompare(resolveCanonicalPath(root));
  const rel = relative(normRoot, normCandidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hasGitSegment(pathValue: string): boolean {
  const segments = pathValue.split(/[\\/]+/);
  return segments.some(segment => segment.toLowerCase() === '.git');
}

function discoverRepoForbiddenRoots(repoRoot: string): string[] {
  const roots = [repoRoot];
  if (!existsSync(repoRoot)) return roots;
  const gitCommon = git('-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (gitCommon.code === 0 && gitCommon.stdout !== '') roots.push(gitCommon.stdout);
  const gitDir = git('-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-dir');
  if (gitDir.code === 0 && gitDir.stdout !== '') roots.push(gitDir.stdout);
  const worktrees = git('-C', repoRoot, 'worktree', 'list', '--porcelain');
  if (worktrees.code === 0) {
    for (const line of worktrees.stdout.split('\n')) {
      if (line.startsWith('worktree ')) roots.push(line.slice('worktree '.length).trim());
    }
  }
  return roots;
}

/**
 * Fail closed if `datasetPath` lives inside the target repo checkout, `.git`,
 * or any builder worktree. Uses `realpathSync` to defeat symlink escapes.
 */
export function assertOutsideAgentTrees(datasetPath: string, options: LoadSetOptions): void {
  const canonicalTarget = resolveCanonicalPath(datasetPath);
  if (hasGitSegment(datasetPath) || hasGitSegment(canonicalTarget)) {
    throw new IsolationBoundaryError(
      `past-task dataset ${datasetPath} lies inside a .git directory; move it outside every agent-readable tree`
    );
  }
  const forbidden = [
    ...discoverRepoForbiddenRoots(options.repoRoot),
    ...(options.worktreeRoots ?? []),
  ];
  for (const root of forbidden) {
    if (isPathInside(canonicalTarget, root)) {
      throw new IsolationBoundaryError(
        `past-task dataset ${datasetPath} (resolved: ${canonicalTarget}) lies inside forbidden agent/worktree root ${root}; keep past-task datasets outside every checkout and builder worktree`
      );
    }
  }
}

function isGraderCommand(value: unknown): value is GraderCommand {
  if (typeof value === 'string') return value.trim() !== '';
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(part => typeof part === 'string' && part.length > 0)
  );
}

function parseCommandList(
  value: unknown,
  field: string,
  where: string,
  problems: string[]
): GraderCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isGraderCommand)) {
    problems.push(`${where}: ${field} must be an array of non-empty commands`);
    return [];
  }
  return [...value];
}

function validateMergedChangeTests(
  raw: unknown,
  where: string,
  problems: string[]
): MergedChangeTestSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    problems.push(`${where}: grader.merged_change_tests must be an object`);
    return undefined;
  }
  const patch = raw.patch;
  if (patch !== undefined && (typeof patch !== 'string' || patch.trim() === '')) {
    problems.push(`${where}: grader.merged_change_tests.patch must be a non-empty string`);
  }
  const commands = parseCommandList(raw.commands, 'grader.merged_change_tests.commands', where, problems);
  if (commands.length === 0) {
    problems.push(`${where}: grader.merged_change_tests.commands must contain at least one command`);
  }
  return {
    ...(typeof patch === 'string' && patch.trim() !== '' ? { patch } : {}),
    commands,
  };
}

function validateGrader(raw: unknown, where: string, problems: string[]): CodeGraderSpec | undefined {
  if (!isObject(raw)) {
    problems.push(`${where}: grader must be an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_LLM_GRADER_KEYS.has(key)) {
      problems.push(`${where}: grader.${key} is forbidden (solve tasks use code-only grading, never LLM self-grading)`);
    }
  }
  const projectTests = parseCommandList(raw.project_tests, 'grader.project_tests', where, problems);
  const merged = validateMergedChangeTests(raw.merged_change_tests, where, problems);
  const scenarios = parseCommandList(raw.scenarios, 'grader.scenarios', where, problems);
  const totalCommands = projectTests.length + (merged?.commands.length ?? 0) + scenarios.length;
  if (totalCommands === 0) {
    problems.push(`${where}: grader must specify at least one code grading command`);
  }
  return {
    project_tests: projectTests,
    ...(merged !== undefined ? { merged_change_tests: merged } : {}),
    ...(scenarios.length > 0 ? { scenarios } : {}),
  };
}

function parseSplit(value: unknown, where: string, problems: string[], fallback?: TaskSplit): TaskSplit {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === 'reflector' || value === 'held_back') return value;
  problems.push(`${where}: split must be one of ${TASK_SPLITS.join(', ')}`);
  return 'held_back';
}

function validateCommonTaskFields(
  entry: Record<string, unknown>,
  where: string,
  problems: string[]
): { id: string; project: string; parent_commit: string; work_order: string } | undefined {
  const { id, project, parent_commit: parentCommit, work_order: workOrder } = entry;
  if (!isTaskId(id)) problems.push(`${where}: id must match ${ID_PATTERN.source}`);
  if (!isTaskId(project)) problems.push(`${where}: project must be a valid identifier`);
  if (!isCommitSha(parentCommit)) problems.push(`${where}: parent_commit must be a 40-hex commit SHA`);
  if (typeof workOrder !== 'string' || workOrder.trim() === '') {
    problems.push(`${where}: work_order must be non-empty text`);
  }
  if (!isTaskId(id) || !isTaskId(project) || !isCommitSha(parentCommit) || typeof workOrder !== 'string') {
    return undefined;
  }
  return { id, project, parent_commit: parentCommit, work_order: workOrder };
}

function validateSolveEntry(
  entry: Record<string, unknown>,
  common: { id: string; project: string; parent_commit: string; work_order: string },
  where: string,
  problems: string[]
): SolveTask | undefined {
  const split = parseSplit(entry.split, where, problems);
  if (typeof entry.origin_trusted !== 'boolean') {
    problems.push(`${where}: origin_trusted must be a boolean`);
  }
  if (typeof entry.release_watch_passed !== 'boolean') {
    problems.push(`${where}: release_watch_passed must be a boolean`);
  }
  if (entry.approved_scope_sha256 !== undefined && !isSha256Hex(entry.approved_scope_sha256)) {
    problems.push(`${where}: approved_scope_sha256 must be a 64-hex SHA-256 digest`);
  }
  const grader = validateGrader(entry.grader, where, problems);
  if (grader === undefined) return undefined;
  return {
    ...common,
    kind: 'solve',
    split,
    origin_trusted: entry.origin_trusted === true,
    ...(isSha256Hex(entry.approved_scope_sha256)
      ? { approved_scope_sha256: entry.approved_scope_sha256 }
      : {}),
    release_watch_passed: entry.release_watch_passed === true,
    grader,
  };
}

function validateExpectedRefusal(
  raw: unknown,
  where: string,
  problems: string[]
): ExpectedRefusalSpec {
  if (!isObject(raw)) {
    problems.push(`${where}: expected_refusal must be an object`);
    return { require_blocked_or_refused: true };
  }
  const requireBlocked = raw.require_blocked_or_refused;
  if (requireBlocked !== undefined && typeof requireBlocked !== 'boolean') {
    problems.push(`${where}: expected_refusal.require_blocked_or_refused must be a boolean`);
  }
  const checkTextArray = (field: string, value: unknown): readonly string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item !== '')) {
      problems.push(`${where}: expected_refusal.${field} must be an array of non-empty strings`);
      return undefined;
    }
    return [...value];
  };
  const forbidSecretPatterns = checkTextArray('forbid_secret_patterns', raw.forbid_secret_patterns);
  const forbidModifiedPaths = checkTextArray('forbid_modified_paths', raw.forbid_modified_paths);
  return {
    require_blocked_or_refused: requireBlocked !== false,
    ...(forbidSecretPatterns !== undefined ? { forbid_secret_patterns: forbidSecretPatterns } : {}),
    ...(forbidModifiedPaths !== undefined ? { forbid_modified_paths: forbidModifiedPaths } : {}),
  };
}

function validateMustRefuseEntry(
  entry: Record<string, unknown>,
  common: { id: string; project: string; parent_commit: string; work_order: string },
  where: string,
  problems: string[]
): MustRefuseTask | undefined {
  const refusalClass = entry.refusal_class;
  if (
    refusalClass !== 'prompt_injection' &&
    refusalClass !== 'secret_in_code' &&
    refusalClass !== 'judge_modification'
  ) {
    problems.push(`${where}: refusal_class must be one of ${REFUSAL_CLASSES.join(', ')}`);
    return undefined;
  }
  const split = parseSplit(entry.split, where, problems, 'held_back');
  const expectedRefusal = validateExpectedRefusal(entry.expected_refusal, where, problems);
  return {
    ...common,
    kind: 'must_refuse',
    refusal_class: refusalClass,
    split,
    expected_refusal: expectedRefusal,
  };
}

/** Validate a single task entry against the past-task schema. */
export function validateTask(entry: unknown, where: string, problems: string[]): PastTask | undefined {
  if (!isObject(entry)) {
    problems.push(`${where}: task must be an object`);
    return undefined;
  }
  const common = validateCommonTaskFields(entry, where, problems);
  if (common === undefined) return undefined;
  const label = `task ${common.id}`;
  if (entry.kind === 'solve') return validateSolveEntry(entry, common, label, problems);
  if (entry.kind === 'must_refuse') return validateMustRefuseEntry(entry, common, label, problems);
  problems.push(`${label}: kind must be "solve" or "must_refuse"`);
  return undefined;
}

/** Validate an in-memory parsed past-task dataset object, reporting every problem at once. */
export function validatePastTaskSet(raw: unknown, sourceLabel = '<dataset>'): PastTaskSet {
  if (!isObject(raw) || raw.bench !== PAST_TASK_BENCH_ID || !Array.isArray(raw.tasks)) {
    throw new Error(
      `${sourceLabel}: not a ${PAST_TASK_BENCH_ID} set (needs "bench": "${PAST_TASK_BENCH_ID}" and "tasks")`
    );
  }
  const problems: string[] = [];
  if (raw.version !== 1) problems.push('version must be 1');
  if (!isTaskId(raw.project)) problems.push('project must be a valid identifier');

  const seenIds = new Set<string>();
  const tasks: PastTask[] = [];
  for (const [index, entry] of raw.tasks.entries()) {
    const task = validateTask(entry, `tasks[${index}]`, problems);
    if (task === undefined) continue;
    if (seenIds.has(task.id)) problems.push(`task ${task.id}: duplicate task id`);
    seenIds.add(task.id);
    tasks.push(task);
  }
  if (problems.length > 0) throw new Error(`${sourceLabel}:\n  ${problems.join('\n  ')}`);
  return {
    bench: PAST_TASK_BENCH_ID,
    version: 1,
    project: raw.project as string,
    tasks,
  };
}

/**
 * Load and validate a past-task set from disk, enforcing the isolation boundary
 * BEFORE reading any bytes from `setPath`.
 */
export function loadPastTaskSet(setPath: string, options: LoadSetOptions): LoadedPastTaskSet {
  assertOutsideAgentTrees(setPath, options);
  const resolvedPath = resolveCanonicalPath(setPath);
  const raw: unknown = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  const validated = validatePastTaskSet(raw, resolvedPath);
  return { ...validated, path: resolvedPath };
}

/**
 * Return the reflector-safe view of a dataset: ONLY tasks in `split === "reflector"`.
 * Held-back tasks are strictly excluded so the reflector can never inspect or overfit them.
 */
export function reflectorView(dataset: PastTaskSet): PastTaskSet {
  return {
    bench: dataset.bench,
    version: dataset.version,
    project: dataset.project,
    tasks: dataset.tasks
      .filter(task => task.split === 'reflector')
      .map(task => structuredClone(task)),
  };
}

/** Normalize any OS path to forward slashes for deterministic matching. */
export function toPosixPath(pathValue: string): string {
  return pathValue.split(sep).join('/').replaceAll('\\', '/');
}
