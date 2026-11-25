/**
 * Weekly checker accuracy scorer for the factory's five allowlisted checkers.
 *
 * Reads a ledger of task outcomes (good vs bad ground truth plus per-checker
 * pass/block/skip verdicts), computes confusion-matrix metrics per checker
 * over the configured trailing window, and emits deterministic, free-text-free
 * JSON (`checker-scores.json`).
 *
 * Hard safety invariant: this scorer NEVER emits a drop, disable, or removal
 * action for any checker, required check, or safety floor. Low-accuracy
 * checkers emit a structured `maintainer_tasks` recommendation with
 * `auto_drop_allowed: false` for a maintainer session to review.
 *
 * Usable as an Archon workflow script node (`INPUTS_LEDGER_PATH`,
 * `INPUTS_LEDGER_JSON`, `INPUTS_OUTPUT_PATH`, `INPUTS_WINDOW_DAYS`,
 * `INPUTS_MIN_SAMPLES`, `INPUTS_MIN_ACCURACY`, `INPUTS_MIN_RECALL`,
 * `INPUTS_NOW`) or standalone CLI:
 *   bun run score.ts --ledger <path> [--out <path>] [--window-days 7]
 *                    [--min-samples 10] [--min-accuracy 0.8] [--min-recall 0.85]
 *                    [--now <iso>]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { emit, refuse, trimmed } from '../../.shared/io.ts';
import { isObject } from '../../.shared/typed.ts';

export const CHECKER_IDS = ['tests', 'coderabbit', 'chatgpt', 'claude', 'release-watch'] as const;
export type CheckerId = (typeof CHECKER_IDS)[number];

export const AUTO_DROP_ALLOWED = false as const;

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_MIN_SAMPLES = 10;
export const DEFAULT_MIN_ACCURACY = 0.8;
export const DEFAULT_MIN_RECALL = 0.85;

export type GroundTruth = 'good' | 'bad';
export type CheckerVerdict = 'pass' | 'block' | 'skip';
export type CheckerStatus = 'healthy' | 'low_accuracy' | 'insufficient_data';
export type MaintainerAction = 'review_checker_weight_and_prompt';
export type MaintainerTargetOwner = 'maintainer_session';
export type MaintainerReasonCode =
  | 'accuracy_below_threshold'
  | 'recall_below_threshold'
  | 'accuracy_and_recall_below_threshold';

export interface TaskOutcomeRecord {
  readonly task_id: string;
  readonly project: string;
  readonly completed_at: string;
  readonly ground_truth: GroundTruth;
  readonly verdicts: Readonly<Partial<Record<CheckerId, CheckerVerdict>>>;
}

export interface ScoreOptions {
  readonly window_days?: number;
  readonly min_samples?: number;
  readonly min_accuracy?: number;
  readonly min_recall?: number;
  readonly now?: string;
}

export interface CheckerScoreEntry {
  readonly checker_id: CheckerId;
  readonly samples: number;
  readonly skipped: number;
  readonly total_tasks: number;
  readonly true_positives: number;
  readonly true_negatives: number;
  readonly false_positives: number;
  readonly false_negatives: number;
  readonly accuracy: number | null;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly coverage: number | null;
  readonly status: CheckerStatus;
  readonly auto_drop_allowed: false;
}

export interface MaintainerTask {
  readonly checker_id: CheckerId;
  readonly action: MaintainerAction;
  readonly reason_code: MaintainerReasonCode;
  readonly samples: number;
  readonly accuracy: number | null;
  readonly recall: number | null;
  readonly min_accuracy: number;
  readonly min_recall: number;
  readonly auto_drop_allowed: false;
  readonly target_owner: MaintainerTargetOwner;
}

export interface CheckerScoresReport {
  readonly version: 1;
  readonly generated_at: string;
  readonly window_days: number;
  readonly min_samples: number;
  readonly thresholds: {
    readonly min_accuracy: number;
    readonly min_recall: number;
  };
  readonly auto_drop_allowed: false;
  readonly total_tasks: number;
  readonly checkers: readonly CheckerScoreEntry[];
  readonly maintainer_tasks: readonly MaintainerTask[];
}

interface ConfusionCounts {
  samples: number;
  skipped: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
}

const MS_PER_DAY = 86_400_000;
const VALID_GROUND_TRUTHS = new Set<string>(['good', 'bad']);
const VALID_VERDICTS = new Set<string>(['pass', 'block', 'skip']);

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round4(numerator / denominator);
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid ${label} timestamp: ${value}`);
  }
  return parsed;
}

function validateConfig(options: ScoreOptions): {
  readonly windowDays: number;
  readonly minSamples: number;
  readonly minAccuracy: number;
  readonly minRecall: number;
  readonly nowIso: string;
  readonly nowMs: number;
} {
  const windowDays = options.window_days ?? DEFAULT_WINDOW_DAYS;
  const minSamples = options.min_samples ?? DEFAULT_MIN_SAMPLES;
  const minAccuracy = options.min_accuracy ?? DEFAULT_MIN_ACCURACY;
  const minRecall = options.min_recall ?? DEFAULT_MIN_RECALL;

  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error(`window_days must be a positive integer, got ${String(windowDays)}`);
  }
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error(`min_samples must be a positive integer, got ${String(minSamples)}`);
  }
  if (!Number.isFinite(minAccuracy) || minAccuracy < 0 || minAccuracy > 1) {
    throw new Error(`min_accuracy must be within [0, 1], got ${String(minAccuracy)}`);
  }
  if (!Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1) {
    throw new Error(`min_recall must be within [0, 1], got ${String(minRecall)}`);
  }

  const nowIso = options.now !== undefined && options.now !== ''
    ? new Date(parseTimestamp(options.now, 'now')).toISOString()
    : new Date().toISOString();
  const nowMs = Date.parse(nowIso);

  return { windowDays, minSamples, minAccuracy, minRecall, nowIso, nowMs };
}

function parseRecordVerdicts(
  raw: unknown,
  index: number
): Readonly<Partial<Record<CheckerId, CheckerVerdict>>> {
  if (!isObject(raw)) {
    throw new Error(`ledger record[${String(index)}].verdicts must be an object`);
  }
  const verdicts: Partial<Record<CheckerId, CheckerVerdict>> = {};
  for (const checker of CHECKER_IDS) {
    const value = raw[checker];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !VALID_VERDICTS.has(value)) {
      throw new Error(
        `ledger record[${String(index)}].verdicts.${checker} must be pass, block, or skip`
      );
    }
    verdicts[checker] = value as CheckerVerdict;
  }
  return verdicts;
}

export function validateLedgerRecord(raw: unknown, index: number): TaskOutcomeRecord {
  if (!isObject(raw)) {
    throw new Error(`ledger record[${String(index)}] must be an object`);
  }
  if (typeof raw.task_id !== 'string' || raw.task_id.trim() === '') {
    throw new Error(`ledger record[${String(index)}].task_id must be a non-empty string`);
  }
  if (typeof raw.project !== 'string' || raw.project.trim() === '') {
    throw new Error(`ledger record[${String(index)}].project must be a non-empty string`);
  }
  if (typeof raw.completed_at !== 'string') {
    throw new Error(`ledger record[${String(index)}].completed_at must be an ISO string`);
  }
  parseTimestamp(raw.completed_at, `record[${String(index)}].completed_at`);

  if (typeof raw.ground_truth !== 'string' || !VALID_GROUND_TRUTHS.has(raw.ground_truth)) {
    throw new Error(`ledger record[${String(index)}].ground_truth must be good or bad`);
  }

  return {
    task_id: raw.task_id,
    project: raw.project,
    completed_at: raw.completed_at,
    ground_truth: raw.ground_truth as GroundTruth,
    verdicts: parseRecordVerdicts(raw.verdicts, index),
  };
}

export function parseLedgerText(rawText: string): readonly TaskOutcomeRecord[] {
  const content = rawText.trim();
  if (content === '') return [];

  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((entry, index) => validateLedgerRecord(entry, index));
    }
    if (isObject(parsed) && Array.isArray(parsed.records)) {
      return parsed.records.map((entry, index) => validateLedgerRecord(entry, index));
    }
    if (isObject(parsed)) {
      return [validateLedgerRecord(parsed, 0)];
    }
    throw new Error('JSON ledger must be an array, a record object, or an object with a records array');
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((line, index) => validateLedgerRecord(JSON.parse(line) as unknown, index));
}

function tallyChecker(
  checker: CheckerId,
  records: readonly TaskOutcomeRecord[]
): ConfusionCounts {
  const counts: ConfusionCounts = { samples: 0, skipped: 0, tp: 0, tn: 0, fp: 0, fn: 0 };

  for (const record of records) {
    const verdict = record.verdicts[checker] ?? 'skip';
    if (verdict === 'skip') {
      counts.skipped += 1;
      continue;
    }
    counts.samples += 1;
    if (record.ground_truth === 'bad' && verdict === 'block') counts.tp += 1;
    else if (record.ground_truth === 'good' && verdict === 'pass') counts.tn += 1;
    else if (record.ground_truth === 'good' && verdict === 'block') counts.fp += 1;
    else counts.fn += 1;
  }

  return counts;
}

function classifyChecker(
  samples: number,
  accuracy: number | null,
  recall: number | null,
  minSamples: number,
  minAccuracy: number,
  minRecall: number
): { readonly status: CheckerStatus; readonly reason: MaintainerReasonCode | null } {
  if (samples < minSamples) {
    return { status: 'insufficient_data', reason: null };
  }
  const lowAccuracy = accuracy !== null && accuracy < minAccuracy;
  const lowRecall = recall !== null && recall < minRecall;
  if (lowAccuracy && lowRecall) {
    return { status: 'low_accuracy', reason: 'accuracy_and_recall_below_threshold' };
  }
  if (lowAccuracy) {
    return { status: 'low_accuracy', reason: 'accuracy_below_threshold' };
  }
  if (lowRecall) {
    return { status: 'low_accuracy', reason: 'recall_below_threshold' };
  }
  return { status: 'healthy', reason: null };
}

export function scoreCheckers(
  records: readonly TaskOutcomeRecord[],
  options: ScoreOptions = {}
): CheckerScoresReport {
  const config = validateConfig(options);
  const windowStartMs = config.nowMs - config.windowDays * MS_PER_DAY;

  const validated = records.map((record, index) => validateLedgerRecord(record, index));
  const inWindow = validated.filter(record => {
    const ts = Date.parse(record.completed_at);
    return ts >= windowStartMs && ts <= config.nowMs;
  });

  const totalTasks = inWindow.length;
  const checkers: CheckerScoreEntry[] = [];
  const maintainerTasks: MaintainerTask[] = [];

  for (const checker of CHECKER_IDS) {
    const counts = tallyChecker(checker, inWindow);
    const accuracy = safeRatio(counts.tp + counts.tn, counts.samples);
    const precision = safeRatio(counts.tp, counts.tp + counts.fp);
    const recall = safeRatio(counts.tp, counts.tp + counts.fn);
    const coverage = safeRatio(counts.samples, totalTasks);
    const classification = classifyChecker(
      counts.samples,
      accuracy,
      recall,
      config.minSamples,
      config.minAccuracy,
      config.minRecall
    );

    checkers.push({
      checker_id: checker,
      samples: counts.samples,
      skipped: counts.skipped,
      total_tasks: totalTasks,
      true_positives: counts.tp,
      true_negatives: counts.tn,
      false_positives: counts.fp,
      false_negatives: counts.fn,
      accuracy,
      precision,
      recall,
      coverage,
      status: classification.status,
      auto_drop_allowed: AUTO_DROP_ALLOWED,
    });

    if (classification.status === 'low_accuracy' && classification.reason !== null) {
      maintainerTasks.push({
        checker_id: checker,
        action: 'review_checker_weight_and_prompt',
        reason_code: classification.reason,
        samples: counts.samples,
        accuracy,
        recall,
        min_accuracy: config.minAccuracy,
        min_recall: config.minRecall,
        auto_drop_allowed: AUTO_DROP_ALLOWED,
        target_owner: 'maintainer_session',
      });
    }
  }

  return {
    version: 1,
    generated_at: config.nowIso,
    window_days: config.windowDays,
    min_samples: config.minSamples,
    thresholds: {
      min_accuracy: config.minAccuracy,
      min_recall: config.minRecall,
    },
    auto_drop_allowed: AUTO_DROP_ALLOWED,
    total_tasks: totalTasks,
    checkers,
    maintainer_tasks: maintainerTasks,
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`expected integer, got ${value}`);
  }
  return parsed;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected number, got ${value}`);
  }
  return parsed;
}

function loadLedgerFromSources(
  cliLedgerPath: string | undefined,
  envLedgerPath: string,
  envLedgerJson: string
): readonly TaskOutcomeRecord[] {
  const path = cliLedgerPath ?? envLedgerPath;
  if (path !== '') {
    return parseLedgerText(readFileSync(path, 'utf8'));
  }
  if (envLedgerJson !== '') {
    return parseLedgerText(envLedgerJson);
  }
  throw new Error('missing ledger input (--ledger, INPUTS_LEDGER_PATH, or INPUTS_LEDGER_JSON)');
}

function runCli(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      ledger: { type: 'string' },
      out: { type: 'string' },
      'window-days': { type: 'string' },
      'min-samples': { type: 'string' },
      'min-accuracy': { type: 'string' },
      'min-recall': { type: 'string' },
      now: { type: 'string' },
    },
    strict: true,
  });

  const records = loadLedgerFromSources(
    values.ledger,
    trimmed(process.env.INPUTS_LEDGER_PATH),
    trimmed(process.env.INPUTS_LEDGER_JSON)
  );
  const report = scoreCheckers(records, {
    window_days: parseOptionalInt(values['window-days'] ?? trimmed(process.env.INPUTS_WINDOW_DAYS)),
    min_samples: parseOptionalInt(values['min-samples'] ?? trimmed(process.env.INPUTS_MIN_SAMPLES)),
    min_accuracy: parseOptionalNumber(
      values['min-accuracy'] ?? trimmed(process.env.INPUTS_MIN_ACCURACY)
    ),
    min_recall: parseOptionalNumber(values['min-recall'] ?? trimmed(process.env.INPUTS_MIN_RECALL)),
    now: values.now ?? trimmed(process.env.INPUTS_NOW),
  });

  const outPath = values.out ?? trimmed(process.env.INPUTS_OUTPUT_PATH);
  if (outPath !== '') {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  emit(report);
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    refuse(`score: ${error instanceof Error ? error.message : String(error)}`);
  }
}
