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

const SHELL_METACHARS = /[|&;<>()$`\\"\n]/;
const CLEANUP_ATTEMPTS = 8;

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

function changedTestFiles(repo: string, base: string, head: string): string[] {
  const listed = runGit(repo, ['diff', '--name-only', '--diff-filter=AMCR', '-z', base, head]);
  if (listed.code !== 0) {
    throw new Error(`git diff failed: ${listed.stderr}`);
  }
  return listed.stdout
    .split('\0')
    .filter(entry => entry.length > 0 && isTestFile(entry))
    .sort();
}

function buildTestCommandArgv(command: string | readonly string[]): string[] {
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

function runTestCommand(cwd: string, argv: readonly string[]): boolean {
  const result = Bun.spawnSync([...argv], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0;
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

function canRunHeadInPlace(repo: string, head: string): boolean {
  const headSha = runGit(repo, ['rev-parse', head]);
  const currentSha = runGit(repo, ['rev-parse', 'HEAD']);
  if (headSha.code !== 0 || currentSha.code !== 0) return false;
  if (headSha.stdout.trim() !== currentSha.stdout.trim()) return false;
  const status = runGit(repo, ['status', '--porcelain']);
  return status.code === 0 && status.stdout.trim() === '';
}

function verdictReason(redOnBase: boolean, greenOnHead: boolean): string {
  if (redOnBase && greenOnHead) return 'ok';
  if (!redOnBase && greenOnHead) return 'tests_passed_on_base_without_implementation';
  if (redOnBase && !greenOnHead) return 'tests_failed_on_head';
  return 'tests_passed_on_base_and_failed_on_head';
}

function verifyHead(repo: string, head: string, scratchRoot: string, argv: readonly string[]): boolean {
  if (canRunHeadInPlace(repo, head)) {
    return runTestCommand(repo, argv);
  }
  const headWorktree = join(scratchRoot, 'head');
  const added = runGit(repo, ['worktree', 'add', '--detach', headWorktree, head]);
  if (added.code !== 0) {
    throw new Error(`git worktree add (head) failed: ${added.stderr}`);
  }
  try {
    return runTestCommand(headWorktree, argv);
  } finally {
    removeWorktree(repo, headWorktree);
  }
}

export function checkRedBeforeGreen(options: RedBeforeGreenOptions): RedBeforeGreenResult {
  const argv = buildTestCommandArgv(options.testCommand);
  let testFiles: string[];
  try {
    testFiles = changedTestFiles(options.repo, options.base, options.head);
  } catch {
    return {
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: [],
      reason: 'git_error',
    };
  }

  if (testFiles.length === 0) {
    return {
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: [],
      reason: 'no_test_files_changed',
    };
  }

  const diff = runGit(options.repo, ['diff', '--binary', options.base, options.head, '--', ...testFiles]);
  if (diff.code !== 0) {
    return {
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: testFiles,
      reason: 'git_error',
    };
  }

  const scratchRoot = mkdtempSync(join(tmpdir(), 'archon-red-before-green-'));
  const baseWorktree = join(scratchRoot, 'base');

  try {
    const added = runGit(options.repo, ['worktree', 'add', '--detach', baseWorktree, options.base]);
    if (added.code !== 0) {
      return {
        passed: false,
        red_on_base: false,
        green_on_head: false,
        test_files: testFiles,
        reason: 'git_error',
      };
    }

    const applied = runGit(baseWorktree, ['apply', '--whitespace=nowarn'], diff.bytes);
    if (applied.code !== 0) {
      return {
        passed: false,
        red_on_base: false,
        green_on_head: false,
        test_files: testFiles,
        reason: 'test_diff_apply_failed',
      };
    }

    const basePassed = runTestCommand(baseWorktree, argv);
    const redOnBase = !basePassed;
    const greenOnHead = verifyHead(options.repo, options.head, scratchRoot, argv);

    return {
      passed: redOnBase && greenOnHead,
      red_on_base: redOnBase,
      green_on_head: greenOnHead,
      test_files: testFiles,
      reason: verdictReason(redOnBase, greenOnHead),
    };
  } finally {
    removeWorktree(options.repo, baseWorktree);
    cleanupTree(scratchRoot);
  }
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
