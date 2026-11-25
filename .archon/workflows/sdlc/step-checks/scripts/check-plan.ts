/**
 * Step check 2: Does the plan cover every acceptance check?
 *
 * Parses acceptance checks (`- [ ] ...`, numbered checks, and `Done when:` items)
 * from the work order and verifies every check is explicitly mapped to a concrete
 * plan step and a verification method in `plan.md`.
 *
 * Usable as an Archon workflow script node (`INPUTS_WORK_ORDER`, `INPUTS_PLAN`)
 * or standalone CLI:
 *   bun run check-plan.ts --work-order <text> --plan <text>
 *   bun run check-plan.ts --work-order-file <path> --plan-file <path>
 */

import { readFileSync } from 'node:fs';
import { emit, refuse, text } from '../../.shared/io.ts';

export interface PlanCheckResult {
  readonly passed: boolean;
  readonly total_checks: number;
  readonly covered: number;
  readonly uncovered: readonly string[];
}

interface PlanStep {
  readonly text: string;
  readonly tokens: ReadonlySet<string>;
  readonly lower: string;
  readonly hasVerification: boolean;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'their',
  'them',
  'there',
  'these',
  'this',
  'to',
  'was',
  'were',
  'when',
  'will',
  'with',
]);

const HEADING = /^#{1,6}\s+(.+)$/;
const ACCEPTANCE_HEADING = /^#{1,6}\s*(?:acceptance\s+(?:criteria|checks?)|done\s+when|verification|exit\s+criteria)\b/i;
const VERIFICATION_HEADING = /^#{1,6}\s*(?:verification|testing|tests|validation|quality\s+gates?)\b/i;
const CHECKBOX_ITEM = /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/;
const NUMBERED_ITEM = /^\s*\d+[.)]\s+(.+)$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.+)$/;
const DONE_WHEN_INLINE = /^\s*(?:\*\*)?done\s+when(?:\*\*)?\s*:\s*(.*)$/i;
const STEP_START = /^(?:#{2,6}\s+|\d+[.)]\s+|[-*+]\s+(?:\*\*)?(?:step\s+\d+|task\s+\d+)|\*\*step\s+\d+)/i;

const VERIFICATION_SIGNAL =
  /\b(?:verify|verified|verification|test|tests|tested|assert|asserts|assertion|check|checks|validate|validation|lint|type-check|typecheck|spec|integration|unit|e2e|curl|pytest|vitest|jest|bun\s+test|npm\s+test|expect|exit\s+code|status\s+code)\b/i;

const CHECK_ID_PATTERN = /\b(?:AC|CHECK|REQ|CRIT)[-_ ]?(\d+)\b/i;
const MATCH_THRESHOLD = 0.55;

function stripMarkdown(raw: string): string {
  return raw
    .replace(/`([^`]+)`/g, ' $1 ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function stemToken(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokenize(raw: string): string[] {
  const cleaned = stripMarkdown(raw).toLowerCase();
  const matches = cleaned.match(/[a-z0-9][a-z0-9_./:-]*/g) ?? [];
  return matches
    .filter(token => token.length > 1 && !STOPWORDS.has(token))
    .map(token => stemToken(token));
}

function extractBacktickEntities(raw: string): string[] {
  const entities: string[] = [];
  const pattern = /`([^`]+)`/g;
  for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
    const value = match[1].trim();
    if (value.length > 0) entities.push(value);
  }
  return entities;
}

function addUnique(target: string[], seen: Set<string>, item: string): void {
  const cleaned = item.trim();
  if (cleaned === '') return;
  const key = cleaned.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(cleaned);
}

function parseAcceptanceLine(
  line: string,
  inAcceptanceSection: boolean,
  checks: string[],
  seen: Set<string>
): boolean {
  const checkbox = CHECKBOX_ITEM.exec(line);
  if (checkbox !== null) {
    addUnique(checks, seen, checkbox[1]);
    return inAcceptanceSection;
  }

  const doneWhen = DONE_WHEN_INLINE.exec(line);
  if (doneWhen !== null) {
    const inlineBody = doneWhen[1].trim();
    if (inlineBody !== '') {
      for (const part of inlineBody.split(/;\s*/)) addUnique(checks, seen, part);
    }
    return true;
  }

  if (!inAcceptanceSection) return false;

  const numbered = NUMBERED_ITEM.exec(line);
  if (numbered !== null) {
    addUnique(checks, seen, numbered[1]);
    return true;
  }

  const bullet = BULLET_ITEM.exec(line);
  if (bullet !== null) {
    addUnique(checks, seen, bullet[1]);
    return true;
  }

  return true;
}

export function extractAcceptanceChecks(workOrder: string): readonly string[] {
  const checks: string[] = [];
  const seen = new Set<string>();
  let inAcceptanceSection = false;

  for (const rawLine of workOrder.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (HEADING.test(trimmed)) {
      inAcceptanceSection = ACCEPTANCE_HEADING.test(trimmed);
      continue;
    }
    inAcceptanceSection = parseAcceptanceLine(rawLine, inAcceptanceSection, checks, seen);
  }

  if (checks.length > 0) return checks;

  for (const rawLine of workOrder.split(/\r?\n/)) {
    const numbered = NUMBERED_ITEM.exec(rawLine);
    if (numbered !== null) addUnique(checks, seen, numbered[1]);
  }
  return checks;
}

function hasVerificationMethod(block: string): boolean {
  if (VERIFICATION_SIGNAL.test(block)) return true;
  return /`[^`]*(?:test|check|lint|verify|pytest|bun|npm|vitest|jest)[^`]*`/i.test(block);
}

function makePlanStep(lines: readonly string[], isVerificationSection: boolean): PlanStep {
  const block = lines.join('\n').trim();
  return {
    text: block,
    tokens: new Set(tokenize(block)),
    lower: block.toLowerCase(),
    hasVerification: isVerificationSection || hasVerificationMethod(block),
  };
}

function parsePlanSections(plan: string): {
  readonly steps: readonly PlanStep[];
  readonly verificationBlocks: readonly PlanStep[];
} {
  const steps: PlanStep[] = [];
  const verificationBlocks: PlanStep[] = [];
  let current: string[] = [];
  let inVerification = false;

  const flush = (): void => {
    if (current.length === 0) return;
    const step = makePlanStep(current, inVerification);
    if (inVerification) verificationBlocks.push(step);
    else steps.push(step);
    current = [];
  };

  for (const rawLine of plan.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (HEADING.test(trimmed)) {
      flush();
      inVerification = VERIFICATION_HEADING.test(trimmed);
      current.push(rawLine);
      continue;
    }
    if (STEP_START.test(trimmed)) {
      flush();
      current.push(rawLine);
      continue;
    }
    if (trimmed !== '' || current.length > 0) current.push(rawLine);
  }
  flush();

  return { steps, verificationBlocks };
}

function tokenMatches(token: string, pool: ReadonlySet<string>): boolean {
  if (pool.has(token)) return true;
  if (token.length < 4) return false;
  for (const candidate of pool) {
    if (candidate.startsWith(token) || token.startsWith(candidate)) return true;
  }
  return false;
}

function checkMatchesBlock(check: string, block: PlanStep): boolean {
  const checkId = CHECK_ID_PATTERN.exec(check);
  if (checkId !== null) {
    const explicitRef = new RegExp(`\\b(?:AC|CHECK|REQ|CRIT)[-_ ]?${checkId[1]}\\b`, 'i');
    if (explicitRef.test(block.text)) return true;
  }

  const entities = extractBacktickEntities(check);
  if (!entities.every(entity => block.lower.includes(entity.toLowerCase()))) return false;

  const checkTokens = [...new Set(tokenize(check))];
  if (checkTokens.length === 0) return false;

  const hits = checkTokens.filter(token => tokenMatches(token, block.tokens)).length;
  return hits / checkTokens.length >= MATCH_THRESHOLD;
}

function isCheckCovered(
  check: string,
  steps: readonly PlanStep[],
  verificationBlocks: readonly PlanStep[]
): boolean {
  const matchedSteps = steps.filter(step => checkMatchesBlock(check, step));
  if (matchedSteps.length === 0) return false;
  if (matchedSteps.some(step => step.hasVerification)) return true;
  return verificationBlocks.some(block => checkMatchesBlock(check, block));
}

export function checkPlan(workOrder: string, plan: string): PlanCheckResult {
  const checks = extractAcceptanceChecks(workOrder);
  if (checks.length === 0) {
    return {
      passed: false,
      total_checks: 0,
      covered: 0,
      uncovered: ['no acceptance checks found in work order'],
    };
  }

  const trimmedPlan = plan.trim();
  if (trimmedPlan === '') {
    return {
      passed: false,
      total_checks: checks.length,
      covered: 0,
      uncovered: [...checks],
    };
  }

  const { steps, verificationBlocks } = parsePlanSections(trimmedPlan);
  const uncovered = checks.filter(check => !isCheckCovered(check, steps, verificationBlocks));
  const covered = checks.length - uncovered.length;

  return {
    passed: uncovered.length === 0,
    total_checks: checks.length,
    covered,
    uncovered,
  };
}

function readInput(direct: string | undefined, filePath: string | undefined, envValue: string): string {
  if (filePath !== undefined && filePath !== '') return readFileSync(filePath, 'utf8');
  if (direct !== undefined) return direct;
  return envValue;
}

const CLI_FLAGS = new Set(['--work-order', '--work-order-file', '--plan', '--plan-file']);

function parseCliFlags(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      const flag = token.slice(0, eqIndex);
      if (!CLI_FLAGS.has(flag)) throw new Error(`unknown option: ${flag}`);
      parsed.set(flag, token.slice(eqIndex + 1));
      continue;
    }
    if (!CLI_FLAGS.has(token)) throw new Error(`unknown option: ${token}`);
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`missing value for option: ${token}`);
    parsed.set(token, next);
    i += 1;
  }
  return parsed;
}

function runCli(): void {
  const flags = parseCliFlags(Bun.argv.slice(2));
  const workOrder = readInput(
    flags.get('--work-order'),
    flags.get('--work-order-file'),
    text(process.env.INPUTS_WORK_ORDER)
  );
  const plan = readInput(
    flags.get('--plan'),
    flags.get('--plan-file'),
    text(process.env.INPUTS_PLAN)
  );

  emit(checkPlan(workOrder, plan));
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    refuse(`check-plan: ${error instanceof Error ? error.message : String(error)}`);
  }
}
