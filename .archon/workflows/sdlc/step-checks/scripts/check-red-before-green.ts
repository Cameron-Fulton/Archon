/**
 * Step check 3: Do the new tests fail without the change?
 *
 * Given a git repository checkout (`base` vs `head`) and a test command:
 * 1. Identifies newly added or modified test files between `base` and `head`.
 * 2. Applies ONLY the test-file diff onto a clean temporary worktree at `base`
 *    (without the implementation diff) and runs the test command to confirm
 *    the new tests fail (`red_on_base: true`).
 * 3. Runs the test command against `head` (with the implementation) to confirm
 *    the tests pass (`green_on_head: true`).
 *
 * Usable as an Archon workflow script node (`INPUTS_BASE_REF`,
 * `INPUTS_HEAD_REF`, `INPUTS_TEST_CMD`) or standalone CLI:
 *   bun run check-red-before-green.ts --repo <dir> --base <ref> --head <ref> --test-cmd "<cmd>"
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { emit, refuse, trimmed } from '../../.shared/io.ts';

export interface RedBeforeGreenOptions {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly testCommand: string | readonly string[];
}

export interface RedBeforeGreenResult {
  readonly passed: boolean;
  readonly red_on_base: boolean;
  readonly green_on_head: boolean;
  readonly test_files: readonly string[];
  readonly reason: string;
}

const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)__tests__\//,
  /(?:^|\/)tests?\//,
  /\.(?:test|spec)\.[^./]+$/i,
  /_test\.[^./]+$/i,
  /(?:^|\/)test_[^/]+$/i,
];

const SHELL_METACHARS = /[|&;<>()$`\\'"\r\n]/;
const CLEANUP_ATTEMPTS = 8;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

type TestRunOutcome = 'pass' | 'fail' | 'runner_error';

export function isTestFile(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(normalized));
}

function runGit(
  cwd: string,
  args: readonly string[],
  input?: Uint8Array
): { readonly code: number; readonly stdout: string; readonly stderr: string; readonly bytes: Uint8Array } {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: input,
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8').trim(),
    bytes: result.stdout,
  };
}

function resolveCommitRef(repo: string, rawRef: string): string | null {
  const ref = rawRef.trim();
  if (ref === '' || ref.startsWith('-')) return null;
  const resolved = runGit(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (resolved.code !== 0) return null;
  const sha = resolved.stdout.trim();
  return COMMIT_SHA_PATTERN.test(sha) ? sha : null;
}

function changedTestFiles(repo: string, baseSha: string, headSha: string): string[] {
  const listed = runGit(repo, ['diff', '--name-only', '--diff-filter=AMCR', '-z', baseSha, headSha]);
  if (listed.code !== 0) {
    throw new Error(`git diff failed: ${listed.stderr}`);
  }
  return listed.stdout
    .split('\0')
    .filter(entry => entry.length > 0 && isTestFile(entry))
    .sort();
}

export function buildTestCommandArgv(command: string | readonly string[]): string[] {
  if (Array.isArray(command)) {
    const argv = command.map(part => part.trim()).filter(part => part.length > 0);
    if (argv.length === 0) throw new Error('test command is empty');
    return argv;
  }
  const raw = String(command).trim();
  if (raw === '') throw new Error('test command is empty');
  if (SHELL_METACHARS.test(raw)) {
    return process.platform === 'win32' ? ['cmd', '/d', '/s', '/c', raw] : ['sh', '-c', raw];
  }
  return raw.split(/\s+/);
}

function runTestCommand(cwd: string, argv: readonly string[]): TestRunOutcome {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync([...argv], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return 'runner_error';
  }
  if (
    (result.signalCode !== undefined && result.signalCode !== null) ||
    result.exitCode === undefined ||
    result.exitCode === null ||
    result.exitCode === 126 ||
    result.exitCode === 127
  ) {
    return 'runner_error';
  }
  return result.exitCode === 0 ? 'pass' : 'fail';
}

function cleanupTree(path: string): void {
  if (!existsSync(path)) return;
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === CLEANUP_ATTEMPTS) return;
      Bun.sleepSync(40);
    }
  }
}

function removeWorktree(repo: string, worktreePath: string): void {
  runGit(repo, ['worktree', 'remove', '--force', worktreePath]);
  cleanupTree(worktreePath);
}

function verdictReason(redOnBase: boolean, greenOnHead: boolean): string {
  if (redOnBase && greenOnHead) return 'ok';
  if (!redOnBase && greenOnHead) return 'tests_passed_on_base_without_implementation';
  if (redOnBase && !greenOnHead) return 'tests_failed_on_head';
  return 'tests_passed_on_base_and_failed_on_head';
}

function failResult(testFiles: readonly string[], reason: string): RedBeforeGreenResult {
  return {
    passed: false,
    red_on_base: false,
    green_on_head: false,
    test_files: testFiles,
    reason,
  };
}

function runInSymmetricWorktrees(
  repo: string,
  baseSha: string,
  headSha: string,
  testFiles: readonly string[],
  diffBytes: Uint8Array,
  argv: readonly string[]
): RedBeforeGreenResult {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'archon-red-before-green-'));
  const baseWorktree = join(scratchRoot, 'base');
  const headWorktree = join(scratchRoot, 'head');

  try {
    const addedBase = runGit(repo, ['worktree', 'add', '--detach', baseWorktree, baseSha]);
    if (addedBase.code !== 0) return failResult(testFiles, 'git_error');

    const applied = runGit(baseWorktree, ['apply', '--whitespace=nowarn'], diffBytes);
    if (applied.code !== 0) return failResult(testFiles, 'test_diff_apply_failed');

    const addedHead = runGit(repo, ['worktree', 'add', '--detach', headWorktree, headSha]);
    if (addedHead.code !== 0) return failResult(testFiles, 'git_error');

    const baseOutcome = runTestCommand(baseWorktree, argv);
    if (baseOutcome === 'runner_error') return failResult(testFiles, 'test_runner_error');

    const headOutcome = runTestCommand(headWorktree, argv);
    if (headOutcome === 'runner_error') return failResult(testFiles, 'test_runner_error');

    const redOnBase = baseOutcome === 'fail';
    const greenOnHead = headOutcome === 'pass';
    return {
      passed: redOnBase && greenOnHead,
      red_on_base: redOnBase,
      green_on_head: greenOnHead,
      test_files: testFiles,
      reason: verdictReason(redOnBase, greenOnHead),
    };
  } finally {
    removeWorktree(repo, baseWorktree);
    removeWorktree(repo, headWorktree);
    cleanupTree(scratchRoot);
  }
}

export function checkRedBeforeGreen(options: RedBeforeGreenOptions): RedBeforeGreenResult {
  const argv = buildTestCommandArgv(options.testCommand);
  const baseSha = resolveCommitRef(options.repo, options.base);
  const headSha = resolveCommitRef(options.repo, options.head);
  if (baseSha === null || headSha === null) {
    return failResult([], 'git_error');
  }

  let testFiles: string[];
  try {
    testFiles = changedTestFiles(options.repo, baseSha, headSha);
  } catch {
    return failResult([], 'git_error');
  }

  if (testFiles.length === 0) {
    return failResult([], 'no_test_files_changed');
  }

  const diff = runGit(options.repo, ['diff', '--binary', baseSha, headSha, '--', ...testFiles]);
  if (diff.code !== 0) {
    return failResult(testFiles, 'git_error');
  }

  return runInSymmetricWorktrees(options.repo, baseSha, headSha, testFiles, diff.bytes, argv);
}

function runCli(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      'test-cmd': { type: 'string' },
    },
    strict: true,
  });

  const repo = values.repo ?? process.cwd();
  const base = values.base ?? (trimmed(process.env.INPUTS_BASE_REF) || 'HEAD~1');
  const head = values.head ?? (trimmed(process.env.INPUTS_HEAD_REF) || 'HEAD');
  const testCommand = values['test-cmd'] ?? trimmed(process.env.INPUTS_TEST_CMD);

  if (testCommand === '') {
    throw new Error('missing required test command (--test-cmd or INPUTS_TEST_CMD)');
  }

  emit(checkRedBeforeGreen({ repo, base, head, testCommand }));
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    refuse(`check-red-before-green: ${error instanceof Error ? error.message : String(error)}`);
  }
}
