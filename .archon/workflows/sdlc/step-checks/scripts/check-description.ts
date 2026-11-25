/**
 * Step check 1: Does the task description match the request?
 *
 * Extracts required acceptance criteria, constraints, and key entities from the
 * original request or approved work order and verifies they appear in the task
 * description, flagging dropped requirements and scope drift against explicit
 * negative constraints.
 *
 * Usable as an Archon workflow script node (`INPUTS_REQUEST`,
 * `INPUTS_TASK_DESCRIPTION`) or standalone CLI:
 *   bun run check-description.ts --request <text> --task-description <text>
 *   bun run check-description.ts --request-file <path> --task-description-file <path>
 */

import { readFileSync } from 'node:fs';
import { emit, refuse, text } from '../../.shared/io.ts';

export interface DescriptionCheckResult {
  readonly passed: boolean;
  readonly missing: readonly string[];
  readonly coverage: number;
  readonly total_requirements: number;
  readonly matched_requirements: number;
  readonly scope_drift: readonly string[];
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
  'will',
  'with',
]);

const NEGATION_PATTERN =
  /\b(?:must\s+not|should\s+not|do\s+not|don't|cannot|can't|never|avoid|without|forbid|forbidden|prohibit|prohibited|out\s+of\s+scope|non-goal)\b/i;

const STRUCTURED_LINE =
  /^\s*(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|(?:done\s+when|acceptance\s+(?:criteria|checks?)|must(?:\s+not)?|constraint|requirement|scope|out\s+of\s+scope|non-goals?)\s*:\s*)(.+)$/i;

const OUT_OF_SCOPE_HEADING = /^#{1,6}\s*(?:out\s+of\s+scope|non-goals?|constraints?\s*-\s*do\s+not)\b/i;
const HEADING_LINE = /^#{1,6}\s+(.+)$/;
const MATCH_THRESHOLD = 0.6;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

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

function extractStructuredRequirements(request: string): {
  requirements: string[];
  exclusions: string[];
} {
  const requirements: string[] = [];
  const exclusions: string[] = [];
  let inExclusionSection = false;

  for (const rawLine of request.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (HEADING_LINE.test(line)) {
      inExclusionSection = OUT_OF_SCOPE_HEADING.test(line);
      continue;
    }
    const structured = STRUCTURED_LINE.exec(line);
    if (structured === null) continue;
    const body = structured[1].trim();
    if (body === '') continue;
    if (inExclusionSection || /^(?:out\s+of\s+scope|non-goals?)\s*:/i.test(line)) {
      exclusions.push(body);
    } else {
      requirements.push(body);
    }
  }
  return { requirements, exclusions };
}

function extractFallbackSentences(request: string): string[] {
  return request
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !HEADING_LINE.test(line))
    .flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(sentence => sentence.trim())
    .filter(sentence => tokenize(sentence).length > 0);
}

export function extractRequirements(request: string): {
  readonly requirements: readonly string[];
  readonly exclusions: readonly string[];
} {
  const structured = extractStructuredRequirements(request);
  if (structured.requirements.length > 0 || structured.exclusions.length > 0) {
    return structured;
  }
  return { requirements: extractFallbackSentences(request), exclusions: [] };
}

function tokenPresent(token: string, descriptionTokens: ReadonlySet<string>): boolean {
  if (descriptionTokens.has(token)) return true;
  if (token.length < 4) return false;
  for (const candidate of descriptionTokens) {
    if (candidate.startsWith(token) || token.startsWith(candidate)) return true;
  }
  return false;
}

function entitiesCovered(entities: readonly string[], descriptionLower: string): boolean {
  return entities.every(entity => descriptionLower.includes(entity.toLowerCase()));
}

function requirementMatched(
  requirement: string,
  description: string,
  descriptionLower: string,
  descriptionTokens: ReadonlySet<string>
): boolean {
  const entities = extractBacktickEntities(requirement);
  if (!entitiesCovered(entities, descriptionLower)) return false;

  const tokens = [...new Set(tokenize(requirement))];
  if (tokens.length === 0) return true;

  const hits = tokens.filter(token => tokenPresent(token, descriptionTokens)).length;
  if (hits / tokens.length < MATCH_THRESHOLD) return false;

  if (NEGATION_PATTERN.test(requirement)) {
    return negationPreserved(requirement, description);
  }
  return true;
}

function negationPreserved(requirement: string, description: string): boolean {
  const targetTokens = tokenize(requirement).filter(
    token => !['not', 'never', 'must', 'should', 'without', 'avoid'].includes(token)
  );
  const sentences = description.split(/(?<=[.!?\n])\s+/);
  for (const sentence of sentences) {
    if (!NEGATION_PATTERN.test(sentence)) continue;
    const sentenceTokens = new Set(tokenize(sentence));
    const overlap = targetTokens.filter(token => tokenPresent(token, sentenceTokens)).length;
    if (targetTokens.length === 0 || overlap / targetTokens.length >= 0.4) return true;
  }
  return false;
}

function detectScopeDrift(
  exclusions: readonly string[],
  description: string
): readonly string[] {
  const drift: string[] = [];
  const sentences = description.split(/(?<=[.!?\n])\s+/).filter(item => item.trim() !== '');

  for (const exclusion of exclusions) {
    const targetTokens = [...new Set(tokenize(exclusion))];
    if (targetTokens.length === 0) continue;
    const affirmativeMatch = sentences.some(sentence => {
      if (NEGATION_PATTERN.test(sentence)) return false;
      const sentenceTokens = new Set(tokenize(sentence));
      const hits = targetTokens.filter(token => tokenPresent(token, sentenceTokens)).length;
      return hits / targetTokens.length >= MATCH_THRESHOLD;
    });
    if (affirmativeMatch) drift.push(exclusion);
  }
  return drift;
}

export function checkDescription(
  request: string,
  taskDescription: string
): DescriptionCheckResult {
  const trimmedRequest = request.trim();
  const trimmedDescription = taskDescription.trim();

  if (trimmedRequest === '') {
    return {
      passed: false,
      missing: ['request is empty'],
      coverage: 0,
      total_requirements: 0,
      matched_requirements: 0,
      scope_drift: [],
    };
  }

  const { requirements, exclusions } = extractRequirements(trimmedRequest);
  const allChecks = requirements.length > 0 ? requirements : exclusions;

  if (allChecks.length === 0) {
    return {
      passed: false,
      missing: ['no verifiable requirements found in request'],
      coverage: 0,
      total_requirements: 0,
      matched_requirements: 0,
      scope_drift: [],
    };
  }

  if (trimmedDescription === '') {
    return {
      passed: false,
      missing: [...allChecks],
      coverage: 0,
      total_requirements: allChecks.length,
      matched_requirements: 0,
      scope_drift: [],
    };
  }

  const descriptionLower = trimmedDescription.toLowerCase();
  const descriptionTokens = new Set(tokenize(trimmedDescription));
  const missing = requirements.filter(
    item => !requirementMatched(item, trimmedDescription, descriptionLower, descriptionTokens)
  );
  const scopeDrift = detectScopeDrift(exclusions, trimmedDescription);
  const total = requirements.length;
  const matched = total - missing.length;
  const coverage = total > 0 ? round4(matched / total) : 1;

  return {
    passed: missing.length === 0 && scopeDrift.length === 0,
    missing,
    coverage,
    total_requirements: total,
    matched_requirements: matched,
    scope_drift: scopeDrift,
  };
}

function readInput(direct: string | undefined, filePath: string | undefined, envValue: string): string {
  if (filePath !== undefined && filePath !== '') return readFileSync(filePath, 'utf8');
  if (direct !== undefined) return direct;
  return envValue;
}

const CLI_FLAGS = new Set([
  '--request',
  '--request-file',
  '--task-description',
  '--task-description-file',
]);

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
  const request = readInput(
    flags.get('--request'),
    flags.get('--request-file'),
    text(process.env.INPUTS_REQUEST)
  );
  const taskDescription = readInput(
    flags.get('--task-description'),
    flags.get('--task-description-file'),
    text(process.env.INPUTS_TASK_DESCRIPTION)
  );

  emit(checkDescription(request, taskDescription));
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    refuse(`check-description: ${error instanceof Error ? error.message : String(error)}`);
  }
}
