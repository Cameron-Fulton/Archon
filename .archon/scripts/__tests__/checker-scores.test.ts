/**
 * Tests for Step 8A: deterministic step-by-step checks and the weekly checker
 * accuracy scorer (`checker-scores.json`).
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from './temp-roots';
import { checkDescription } from '../../workflows/sdlc/step-checks/scripts/check-description.ts';
import { checkPlan } from '../../workflows/sdlc/step-checks/scripts/check-plan.ts';
import {
  buildTestCommandArgv,
  checkRedBeforeGreen,
} from '../../workflows/sdlc/step-checks/scripts/check-red-before-green.ts';
import {
  CHECKER_IDS,
  type CheckerId,
  type CheckerScoresReport,
  type CheckerVerdict,
  type TaskOutcomeRecord,
  scoreCheckers,
} from '../../workflows/sdlc/checker-eval/scripts/score.ts';

const track = trackTempRoots();

const STEP_CHECKS_DIR = join(import.meta.dir, '../../workflows/sdlc/step-checks/scripts');
const CHECKER_EVAL_DIR = join(import.meta.dir, '../../workflows/sdlc/checker-eval/scripts');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Test Author',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' }
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function writeRepoFile(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function commitAll(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

describe('step check 1: check-description', () => {
  const request = [
    '# Work Order',
    '- [ ] Add rate limiting middleware to `POST /api/login` capped at 5 attempts per minute',
    '- [ ] Return HTTP 429 with `Retry-After` header when limit is exceeded',
    '- [ ] Must not modify existing session cookie signing format',
    '',
    '## Out of scope',
    '- Rewriting OAuth token refresh flow',
  ].join('\n');

  it('passes when all acceptance criteria, entities, and negative constraints appear in the task description', () => {
    const taskDescription = [
      'Implement rate limiting middleware on `POST /api/login` with a 5 attempts per minute cap.',
      'When exceeded, return HTTP 429 including the `Retry-After` header.',
      'Must not modify the existing session cookie signing format.',
    ].join('\n');

    const result = checkDescription(request, taskDescription);
    expect(result.passed).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.scope_drift).toEqual([]);
    expect(result.coverage).toBe(1);
    expect(result.total_requirements).toBe(3);
    expect(result.matched_requirements).toBe(3);
  });

  it('catches a dropped requirement and reports reduced coverage', () => {
    const taskDescription = [
      'Implement rate limiting middleware on `POST /api/login` with a 5 attempts per minute cap.',
      'Must not modify the existing session cookie signing format.',
    ].join('\n');

    const result = checkDescription(request, taskDescription);
    expect(result.passed).toBe(false);
    expect(result.missing).toEqual([
      'Return HTTP 429 with `Retry-After` header when limit is exceeded',
    ]);
    expect(result.coverage).toBeCloseTo(2 / 3, 4);
  });

  it('flags scope drift when an out-of-scope item is affirmatively added', () => {
    const taskDescription = [
      'Implement rate limiting middleware on `POST /api/login` capped at 5 attempts per minute.',
      'Return HTTP 429 with `Retry-After` header when limit is exceeded.',
      'Must not modify existing session cookie signing format.',
      'Also rewrite OAuth token refresh flow for consistency.',
    ].join('\n');

    const result = checkDescription(request, taskDescription);
    expect(result.passed).toBe(false);
    expect(result.scope_drift).toEqual(['Rewriting OAuth token refresh flow']);
  });

  it('preserves negation on Must not: prefixed requirements and rejects affirmative violations', () => {
    const mustNotRequest = 'Must not: modify existing session cookie signing format';
    const violation = checkDescription(
      mustNotRequest,
      'Modify existing session cookie signing format to use SHA-512.'
    );
    expect(violation.passed).toBe(false);
    expect(violation.missing).toEqual(['Must not modify existing session cookie signing format']);

    const preserved = checkDescription(
      mustNotRequest,
      'Must not modify existing session cookie signing format.'
    );
    expect(preserved.passed).toBe(true);
    expect(preserved.missing).toEqual([]);
  });

  it('splits bulleted markdown on newlines so negation on one bullet cannot mask scope drift on the next', () => {
    const bulletRequest = [
      '- [ ] Must not touch billing ledger',
      '## Out of scope',
      '- Rewriting OAuth token refresh flow',
    ].join('\n');
    const bulletDescription = [
      '- Must not touch billing ledger',
      '- Rewrite OAuth token refresh flow',
    ].join('\n');

    const result = checkDescription(bulletRequest, bulletDescription);
    expect(result.passed).toBe(false);
    expect(result.scope_drift).toEqual(['Rewriting OAuth token refresh flow']);
  });

  it('does not allow short 2-3 char candidate tokens to prefix-match longer requirement words', () => {
    const shortBypass = checkDescription(
      '- [ ] Validate notification delivery pipeline',
      'no de pi'
    );
    expect(shortBypass.passed).toBe(false);
    expect(shortBypass.matched_requirements).toBe(0);
  });

  it('runs cleanly as a standalone CLI emitting JSON', () => {
    const proc = spawnSync(
      process.execPath,
      [
        join(STEP_CHECKS_DIR, 'check-description.ts'),
        '--request',
        '- [ ] Export `scoreCheckers` helper',
        '--task-description',
        'Export `scoreCheckers` helper for weekly accuracy scoring.',
      ],
      { encoding: 'utf8' }
    );
    expect(proc.status).toBe(0);
    const parsed = JSON.parse(proc.stdout) as { passed: boolean; coverage: number };
    expect(parsed.passed).toBe(true);
    expect(parsed.coverage).toBe(1);
  });
});

describe('step check 2: check-plan', () => {
  const workOrder = [
    '# Work Order',
    '## Acceptance checks',
    '- [ ] AC1: Validate `config.json` schema on startup',
    '- [ ] AC2: Emit structured JSON error when port is already bound',
    'Done when: Health endpoint `/healthz` returns 200 with uptime seconds',
  ].join('\n');

  it('passes when every acceptance check is mapped to a concrete plan step and verification method', () => {
    const plan = [
      '# Implementation Plan',
      '## Step 1: Startup config validation',
      'Parse and validate `config.json` schema during boot (AC1).',
      'Verify: run unit test `bun test config.test.ts` covering invalid schemas.',
      '',
      '## Step 2: Port conflict handling',
      'Catch EADDRINUSE and emit structured JSON error when port is already bound (AC2).',
      'Verify: integration test binding an occupied port asserts JSON error output.',
      '',
      '## Step 3: Health endpoint',
      'Expose `/healthz` returning HTTP 200 with uptime seconds.',
      'Verify: assert `GET /healthz` status code 200 and uptime field in route tests.',
    ].join('\n');

    const result = checkPlan(workOrder, plan);
    expect(result).toEqual({
      passed: true,
      total_checks: 3,
      covered: 3,
      uncovered: [],
    });
  });

  it('catches an uncovered acceptance check', () => {
    const plan = [
      '# Implementation Plan',
      '## Step 1: Startup config validation',
      'Validate `config.json` schema on startup (AC1). Verify with unit tests.',
      '',
      '## Step 2: Health endpoint',
      'Expose `/healthz` returning 200 with uptime seconds. Verify with integration test.',
    ].join('\n');

    const result = checkPlan(workOrder, plan);
    expect(result.passed).toBe(false);
    expect(result.total_checks).toBe(3);
    expect(result.covered).toBe(2);
    expect(result.uncovered).toEqual([
      'AC2: Emit structured JSON error when port is already bound',
    ]);
  });

  it('fails a check that appears in a plan step with no verification method', () => {
    const plan = [
      '# Implementation Plan',
      '## Step 1: Startup config validation',
      'Validate `config.json` schema on startup (AC1). Verify with unit test.',
      '',
      '## Step 2: Port conflict handling',
      'Emit structured JSON error when port is already bound (AC2).',
      '',
      '## Step 3: Health endpoint',
      'Expose `/healthz` returning 200 with uptime seconds. Verify with route test.',
    ].join('\n');

    const result = checkPlan(workOrder, plan);
    expect(result.passed).toBe(false);
    expect(result.covered).toBe(2);
    expect(result.uncovered).toEqual([
      'AC2: Emit structured JSON error when port is already bound',
    ]);
  });

  it('rejects cross-prefix ID collisions, lowercase prose "check N", and 2-3 char prefix matches', () => {
    const crossPrefix = checkPlan(
      '- [ ] AC1: Implement exponential backoff retry',
      '## Step 1: REQ1 unrelated logging tweak\nVerify with unit test.'
    );
    expect(crossPrefix.passed).toBe(false);
    expect(crossPrefix.covered).toBe(0);

    const proseCheck = checkPlan(
      '- [ ] Confirm check 1 returns valid OAuth signature',
      '## Step 1: Run check 1 on unrelated billing table\nVerify with unit test.'
    );
    expect(proseCheck.passed).toBe(false);
    expect(proseCheck.covered).toBe(0);

    const explicitCheckId = checkPlan(
      '- [ ] CHECK-1: Implement exponential backoff retry',
      '## Step 1: Deliver CHECK-1\nVerify with unit test.'
    );
    expect(explicitCheckId.passed).toBe(true);
    expect(explicitCheckId.covered).toBe(1);

    const shortTokenBypass = checkPlan(
      '- [ ] Validate notification delivery pipeline',
      '## Step 1: Handle no de pi\nVerify with unit test.'
    );
    expect(shortTokenBypass.passed).toBe(false);
    expect(shortTokenBypass.covered).toBe(0);
  });

  it('runs cleanly as a standalone CLI emitting JSON', () => {
    const proc = spawnSync(
      process.execPath,
      [
        join(STEP_CHECKS_DIR, 'check-plan.ts'),
        '--work-order',
        'Done when: `parseInput` rejects blank lines',
        '--plan',
        '1. Update `parseInput` to reject blank lines; verify with unit test.',
      ],
      { encoding: 'utf8' }
    );
    expect(proc.status).toBe(0);
    const parsed = JSON.parse(proc.stdout) as { passed: boolean; covered: number };
    expect(parsed.passed).toBe(true);
    expect(parsed.covered).toBe(1);
  });
});

describe('step check 3: check-red-before-green (real temp git repo)', () => {
  function initSampleRepo(): { repo: string; base: string } {
    const repo = track(mkdtempSync(join(tmpdir(), 'archon-red-green-fixture-')));
    git(repo, 'init', '-q', '-b', 'main');
    writeRepoFile(
      repo,
      'src/calc.ts',
      'export function add(a: number, b: number): number {\n  return a - b;\n}\n'
    );
    const base = commitAll(repo, 'base: buggy add implementation');
    return { repo, base };
  }

  it('passes when the new test fails on base (without the fix) and passes on head (with the fix)', () => {
    const { repo, base } = initSampleRepo();
    writeRepoFile(
      repo,
      'src/calc.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    writeRepoFile(
      repo,
      'src/calc.test.ts',
      [
        "import { expect, test } from 'bun:test';",
        "import { add } from './calc.ts';",
        "test('adds two numbers', () => {",
        '  expect(add(2, 3)).toBe(5);',
        '});',
      ].join('\n')
    );
    const head = commitAll(repo, 'fix: add returns sum and test proves it');

    const result = checkRedBeforeGreen({
      repo,
      base,
      head,
      testCommand: [process.execPath, 'test', 'src/calc.test.ts'],
    });

    expect(result).toEqual({
      passed: true,
      red_on_base: true,
      green_on_head: true,
      test_files: ['src/calc.test.ts'],
      reason: 'ok',
    });
    // Caller repository remains completely clean.
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('fails when a vacuous test passes on base without the implementation fix', () => {
    const { repo, base } = initSampleRepo();
    writeRepoFile(
      repo,
      'src/calc.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    writeRepoFile(
      repo,
      'src/vacuous.test.ts',
      [
        "import { expect, test } from 'bun:test';",
        "test('vacuous assertion passes on any commit', () => {",
        '  expect(1 + 1).toBe(2);',
        '});',
      ].join('\n')
    );
    const head = commitAll(repo, 'test: add vacuous test');

    const result = checkRedBeforeGreen({
      repo,
      base,
      head,
      testCommand: [process.execPath, 'test', 'src/vacuous.test.ts'],
    });

    expect(result).toEqual({
      passed: false,
      red_on_base: false,
      green_on_head: true,
      test_files: ['src/vacuous.test.ts'],
      reason: 'tests_passed_on_base_without_implementation',
    });
  });

  it('fails closed when no test files were added or modified', () => {
    const { repo, base } = initSampleRepo();
    writeRepoFile(
      repo,
      'src/calc.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    const head = commitAll(repo, 'fix: implementation without test');

    const result = checkRedBeforeGreen({
      repo,
      base,
      head,
      testCommand: [process.execPath, 'test'],
    });

    expect(result).toEqual({
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: [],
      reason: 'no_test_files_changed',
    });
  });

  it('rejects dash-prefixed refs to prevent git option injection', () => {
    const { repo, base } = initSampleRepo();
    const injectedBase = checkRedBeforeGreen({
      repo,
      base: '--output=/tmp/injected',
      head: base,
      testCommand: [process.execPath, 'test'],
    });
    expect(injectedBase).toEqual({
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: [],
      reason: 'git_error',
    });

    const injectedHead = checkRedBeforeGreen({
      repo,
      base,
      head: '--help',
      testCommand: [process.execPath, 'test'],
    });
    expect(injectedHead).toEqual({
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: [],
      reason: 'git_error',
    });
  });

  it('reports test_runner_error instead of red_on_base when the test runner fails to spawn or exits 127', () => {
    const { repo, base } = initSampleRepo();
    writeRepoFile(
      repo,
      'src/calc.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    writeRepoFile(
      repo,
      'src/calc.test.ts',
      "import { expect, test } from 'bun:test';\ntest('ok', () => expect(true).toBe(true));\n"
    );
    const head = commitAll(repo, 'test: add test');

    const missingBin = checkRedBeforeGreen({
      repo,
      base,
      head,
      testCommand: ['nonexistent-test-runner-binary-xyz'],
    });
    expect(missingBin).toEqual({
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: ['src/calc.test.ts'],
      reason: 'test_runner_error',
    });

    const exit127 = checkRedBeforeGreen({
      repo,
      base,
      head,
      testCommand: [process.execPath, '-e', 'process.exit(127)'],
    });
    expect(exit127).toEqual({
      passed: false,
      red_on_base: false,
      green_on_head: false,
      test_files: ['src/calc.test.ts'],
      reason: 'test_runner_error',
    });
  });

  it('runs both base and head in symmetric clean worktrees so untracked local files cannot cause false passes', () => {
    const { repo, base } = initSampleRepo();
    writeRepoFile(
      repo,
      'src/calc.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
    );
    writeRepoFile(
      repo,
      'src/env.test.ts',
      [
        "import { expect, test } from 'bun:test';",
        "import { existsSync } from 'node:fs';",
        "test('depends on untracked local file', () => {",
        "  expect(existsSync('local_untracked.marker')).toBe(true);",
        '});',
      ].join('\n')
    );
    const head = commitAll(repo, 'test: relies on untracked file');
    // Plant an untracked marker in the caller checkout ONLY.
    writeRepoFile(repo, 'local_untracked.marker', 'present\n');

    const result = checkRedBeforeGreen({
      repo,
      base,
      head,
      testCommand: [process.execPath, 'test', 'src/env.test.ts'],
    });

    expect(result.passed).toBe(false);
    expect(result.green_on_head).toBe(false);
    expect(result.reason).toBe('tests_failed_on_head');
  });

  it('routes single-quoted and CR-containing string commands through a shell instead of naive whitespace split', () => {
    const singleQuoted = buildTestCommandArgv("bun test 'src/my test.ts'");
    const expectedShell = process.platform === 'win32' ? ['cmd', '/d', '/s', '/c'] : ['sh', '-c'];
    expect(singleQuoted).toEqual([...expectedShell, "bun test 'src/my test.ts'"]);

    const withCarriageReturn = buildTestCommandArgv('bun test\r');
    expect(withCarriageReturn).toEqual(['bun', 'test']);
    const embeddedCr = buildTestCommandArgv('bun\rtest');
    expect(embeddedCr).toEqual([...expectedShell, 'bun\rtest']);
  });

  it('gates each archon-step-checks.yaml node on its required input for pre-implementation runs', () => {
    const yamlPath = join(STEP_CHECKS_DIR, '../archon-step-checks.yaml');
    const parsed = Bun.YAML.parse(readFileSync(yamlPath, 'utf8')) as {
      nodes: { id: string; when?: string }[];
    };
    const byId = new Map(parsed.nodes.map(node => [node.id, node.when]));
    expect(byId.get('check-description')).toBe("$INPUTS.request != ''");
    expect(byId.get('check-plan')).toBe("$INPUTS.work_order != ''");
    expect(byId.get('check-red-before-green')).toBe("$INPUTS.test_cmd != ''");
  });
});

describe('weekly checker accuracy scorer: checker-eval/scripts/score.ts', () => {
  const NOW = '2026-11-25T12:00:00.000Z';

  function makeRecord(
    index: number,
    groundTruth: 'good' | 'bad',
    verdicts: Partial<Record<CheckerId, CheckerVerdict>>,
    completedAt = '2026-11-24T12:00:00.000Z'
  ): TaskOutcomeRecord {
    return {
      task_id: `task-${String(index)}`,
      project: 'synthetic-app',
      completed_at: completedAt,
      ground_truth: groundTruth,
      verdicts,
    };
  }

  /**
   * 12 in-window tasks (6 good, 6 bad) + 1 out-of-window task (excluded):
   * - tests:          12 samples (6 TP, 6 TN, 0 FP, 0 FN) -> acc 1.0, prec 1.0, rec 1.0, cov 1.0 -> healthy
   * - coderabbit:     10 samples, 2 skips (3 TP, 4 TN, 1 FP, 2 FN) -> acc 0.7, prec 0.75, rec 0.6, cov 10/12 -> low_accuracy (both)
   * - chatgpt:        12 samples (4 TP, 6 TN, 0 FP, 2 FN) -> acc 10/12 (0.8333), prec 1.0, rec 4/6 (0.6667) -> low_accuracy (recall)
   * - claude:         12 samples (6 TP, 3 TN, 3 FP, 0 FN) -> acc 9/12 (0.75), prec 0.6667, rec 1.0 -> low_accuracy (accuracy)
   * - release-watch:   4 samples, 8 skips (2 TP, 2 TN, 0 FP, 0 FN) -> samples < 10 -> insufficient_data
   */
  function buildSyntheticLedger(): TaskOutcomeRecord[] {
    const records: TaskOutcomeRecord[] = [];

    // 6 bad tasks
    const badVerdicts: Partial<Record<CheckerId, CheckerVerdict>>[] = [
      { tests: 'block', coderabbit: 'block', chatgpt: 'block', claude: 'block', 'release-watch': 'block' },
      { tests: 'block', coderabbit: 'block', chatgpt: 'block', claude: 'block', 'release-watch': 'block' },
      { tests: 'block', coderabbit: 'block', chatgpt: 'block', claude: 'block', 'release-watch': 'skip' },
      { tests: 'block', coderabbit: 'pass', chatgpt: 'block', claude: 'block', 'release-watch': 'skip' },
      { tests: 'block', coderabbit: 'pass', chatgpt: 'pass', claude: 'block', 'release-watch': 'skip' },
      { tests: 'block', coderabbit: 'skip', chatgpt: 'pass', claude: 'block', 'release-watch': 'skip' },
    ];
    badVerdicts.forEach((verdicts, idx) => {
      records.push(makeRecord(idx + 1, 'bad', verdicts));
    });

    // 6 good tasks
    const goodVerdicts: Partial<Record<CheckerId, CheckerVerdict>>[] = [
      { tests: 'pass', coderabbit: 'pass', chatgpt: 'pass', claude: 'pass', 'release-watch': 'pass' },
      { tests: 'pass', coderabbit: 'pass', chatgpt: 'pass', claude: 'pass', 'release-watch': 'pass' },
      { tests: 'pass', coderabbit: 'pass', chatgpt: 'pass', claude: 'pass', 'release-watch': 'skip' },
      { tests: 'pass', coderabbit: 'pass', chatgpt: 'pass', claude: 'block', 'release-watch': 'skip' },
      { tests: 'pass', coderabbit: 'block', chatgpt: 'pass', claude: 'block', 'release-watch': 'skip' },
      { tests: 'pass', coderabbit: 'skip', chatgpt: 'pass', claude: 'block', 'release-watch': 'skip' },
    ];
    goodVerdicts.forEach((verdicts, idx) => {
      records.push(makeRecord(idx + 7, 'good', verdicts));
    });

    // 1 expired task outside the 7-day window (must be excluded)
    records.push(
      makeRecord(
        99,
        'bad',
        { tests: 'pass', coderabbit: 'pass', chatgpt: 'pass', claude: 'pass', 'release-watch': 'pass' },
        '2026-11-10T00:00:00.000Z'
      )
    );

    return records;
  }

  it('computes exact confusion matrices across all 5 checkers and filters by trailing window', () => {
    const report = scoreCheckers(buildSyntheticLedger(), { now: NOW });

    expect(report.version).toBe(1);
    expect(report.generated_at).toBe(NOW);
    expect(report.window_days).toBe(7);
    expect(report.min_samples).toBe(10);
    expect(report.thresholds).toEqual({ min_accuracy: 0.8, min_recall: 0.85 });
    expect(report.total_tasks).toBe(12);
    expect(report.checkers.map(c => c.checker_id)).toEqual([...CHECKER_IDS]);

    const byId = new Map(report.checkers.map(entry => [entry.checker_id, entry]));

    expect(byId.get('tests')).toEqual({
      checker_id: 'tests',
      samples: 12,
      skipped: 0,
      total_tasks: 12,
      true_positives: 6,
      true_negatives: 6,
      false_positives: 0,
      false_negatives: 0,
      accuracy: 1,
      precision: 1,
      recall: 1,
      coverage: 1,
      status: 'healthy',
      auto_drop_allowed: false,
    });

    expect(byId.get('coderabbit')).toEqual({
      checker_id: 'coderabbit',
      samples: 10,
      skipped: 2,
      total_tasks: 12,
      true_positives: 3,
      true_negatives: 4,
      false_positives: 1,
      false_negatives: 2,
      accuracy: 0.7,
      precision: 0.75,
      recall: 0.6,
      coverage: 0.8333,
      status: 'low_accuracy',
      auto_drop_allowed: false,
    });

    expect(byId.get('chatgpt')).toEqual({
      checker_id: 'chatgpt',
      samples: 12,
      skipped: 0,
      total_tasks: 12,
      true_positives: 4,
      true_negatives: 6,
      false_positives: 0,
      false_negatives: 2,
      accuracy: 0.8333,
      precision: 1,
      recall: 0.6667,
      coverage: 1,
      status: 'low_accuracy',
      auto_drop_allowed: false,
    });

    expect(byId.get('claude')).toEqual({
      checker_id: 'claude',
      samples: 12,
      skipped: 0,
      total_tasks: 12,
      true_positives: 6,
      true_negatives: 3,
      false_positives: 3,
      false_negatives: 0,
      accuracy: 0.75,
      precision: 0.6667,
      recall: 1,
      coverage: 1,
      status: 'low_accuracy',
      auto_drop_allowed: false,
    });

    expect(byId.get('release-watch')).toEqual({
      checker_id: 'release-watch',
      samples: 4,
      skipped: 8,
      total_tasks: 12,
      true_positives: 2,
      true_negatives: 2,
      false_positives: 0,
      false_negatives: 0,
      accuracy: 1,
      precision: 1,
      recall: 1,
      coverage: 0.3333,
      status: 'insufficient_data',
      auto_drop_allowed: false,
    });
  });

  it('emits structured maintainer_tasks for low_accuracy checkers and NEVER allows auto-dropping', () => {
    const report = scoreCheckers(buildSyntheticLedger(), { now: NOW });

    expect(report.auto_drop_allowed).toBe(false);
    for (const checker of report.checkers) {
      expect(checker.auto_drop_allowed).toBe(false);
    }

    expect(report.maintainer_tasks).toEqual([
      {
        checker_id: 'coderabbit',
        action: 'review_checker_weight_and_prompt',
        reason_code: 'accuracy_and_recall_below_threshold',
        samples: 10,
        accuracy: 0.7,
        recall: 0.6,
        min_accuracy: 0.8,
        min_recall: 0.85,
        auto_drop_allowed: false,
        target_owner: 'maintainer_session',
      },
      {
        checker_id: 'chatgpt',
        action: 'review_checker_weight_and_prompt',
        reason_code: 'recall_below_threshold',
        samples: 12,
        accuracy: 0.8333,
        recall: 0.6667,
        min_accuracy: 0.8,
        min_recall: 0.85,
        auto_drop_allowed: false,
        target_owner: 'maintainer_session',
      },
      {
        checker_id: 'claude',
        action: 'review_checker_weight_and_prompt',
        reason_code: 'accuracy_below_threshold',
        samples: 12,
        accuracy: 0.75,
        recall: 1,
        min_accuracy: 0.8,
        min_recall: 0.85,
        auto_drop_allowed: false,
        target_owner: 'maintainer_session',
      },
    ]);

    // Never recommends dropping or disabling any checker.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/disable_checker|drop_checker|remove_checker|rm\s+-rf/i);
  });

  it('contains zero free text anywhere in checker-scores.json', () => {
    const report = scoreCheckers(buildSyntheticLedger(), { now: NOW });
    const allowedTokens = new Set<string>([
      ...CHECKER_IDS,
      'healthy',
      'low_accuracy',
      'insufficient_data',
      'review_checker_weight_and_prompt',
      'maintainer_session',
      'accuracy_below_threshold',
      'recall_below_threshold',
      'accuracy_and_recall_below_threshold',
    ]);
    const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    const collectStrings = (value: unknown, out: string[]): void => {
      if (typeof value === 'string') {
        out.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, out);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const entry of Object.values(value)) collectStrings(entry, out);
      }
    };

    const leafStrings: string[] = [];
    collectStrings(report, leafStrings);
    expect(leafStrings.length).toBeGreaterThan(0);

    for (const token of leafStrings) {
      const valid = allowedTokens.has(token) || isoUtc.test(token);
      expect(valid).toBe(true);
    }
    // Task IDs and project names from the input ledger must never leak into checker-scores.json.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('synthetic-app');
    expect(serialized).not.toContain('task-1');
  });

  it('writes deterministic checker-scores.json via CLI', () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'archon-checker-scores-cli-')));
    const ledgerPath = join(dir, 'ledger.jsonl');
    const outPath = join(dir, 'checker-scores.json');
    const ledger = buildSyntheticLedger();
    writeFileSync(ledgerPath, `${ledger.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    const runCli = () =>
      spawnSync(
        process.execPath,
        [join(CHECKER_EVAL_DIR, 'score.ts'), '--ledger', ledgerPath, '--out', outPath, '--now', NOW],
        { encoding: 'utf8' }
      );

    const first = runCli();
    expect(first.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const firstFile = readFileSync(outPath, 'utf8');

    const second = runCli();
    expect(second.status).toBe(0);
    const secondFile = readFileSync(outPath, 'utf8');

    expect(firstFile).toBe(secondFile);
    const parsed = JSON.parse(firstFile) as CheckerScoresReport;
    expect(parsed.version).toBe(1);
    expect(parsed.auto_drop_allowed).toBe(false);
    expect(parsed.checkers).toHaveLength(5);
    expect(parsed.maintainer_tasks).toHaveLength(3);
  });
});
