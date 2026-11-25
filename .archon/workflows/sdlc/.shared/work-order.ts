/**
 * Work-order mode switch and fail-closed guards for the SDLC pack.
 *
 * In work-order mode, builders work only from the pinned work order supplied by
 * the caller or factory loop. They never read or mutate the issue tracker, never
 * read issue comments or review threads, and never write issue references into
 * pull requests.
 *
 * Activated by either `ARCHON_WORK_ORDER_MODE` (`1` or `true`) in the run's
 * environment or the workflow input `work_order_mode` (`true` or `1`). When the
 * environment enables work-order mode, no workflow input can turn it off.
 */

const TRUTHY = new Set(['1', 'true']);
const FALSY = new Set(['', '0', 'false']);

function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (FALSY.has(normalized)) return false;
  if (TRUTHY.has(normalized)) return true;
  throw new Error(`${name} must be "true", "false", "1", or "0", not "${(raw ?? '').trim()}"`);
}

/**
 * Whether work-order mode is active for this node.
 *
 * Read env here rather than in each calling script: the unbound-env checker
 * scans a script's own text for `INPUTS_*` bindings and never follows imports.
 * Callers still read `process.env.INPUTS_WORK_ORDER_MODE` literally and pass
 * its value as `input`.
 */
export function isWorkOrderMode(
  input?: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const fromEnv = parseBooleanFlag('ARCHON_WORK_ORDER_MODE', env.ARCHON_WORK_ORDER_MODE);
  const fromInput = parseBooleanFlag('work_order_mode', input ?? env.INPUTS_WORK_ORDER_MODE);
  return fromEnv || fromInput;
}

/** Raised when a pack script attempts a forbidden tracker or PR-link action in work-order mode. */
export class WorkOrderModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkOrderModeError';
  }
}

/** Refuse any issue-tracker read or write when work-order mode is active. */
export function assertIssueTrackerAllowed(
  operation: string,
  input?: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (isWorkOrderMode(input, env)) {
    throw new WorkOrderModeError(
      `work-order mode refuses ${operation}: agents build only from the pinned work order and never access the issue tracker`
    );
  }
}

/** Refuse any pull request body mutation when work-order mode is active. */
export function assertPrBodyEditAllowed(
  input?: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (isWorkOrderMode(input, env)) {
    throw new WorkOrderModeError(
      'work-order mode forbids editing the pull request description; PR text belongs to the loop'
    );
  }
}

const ISSUE_LINK_PATTERNS: readonly RegExp[] = [
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/i,
  /https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/issues\/\d+\b/i,
  /(?:^|[^\w])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+\b/,
  /\bGH-\d+\b/i,
];

/** The first issue-tracker reference found in `content`, or null when clean. */
export function findIssueReference(content: string): string | null {
  for (const pattern of ISSUE_LINK_PATTERNS) {
    const match = pattern.exec(content);
    if (match !== null) return match[0].trim();
  }
  return null;
}

/** Whether `url` points at a forge issue tracker item (`/issues/<number>`). */
export function isIssueTrackerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/issues\/\d+(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Refuse agent-authored text carrying any issue reference or closing keyword in work-order mode. */
export function assertNoIssueReferences(surface: string, content: string): void {
  const found = findIssueReference(content);
  if (found !== null) {
    throw new WorkOrderModeError(
      `work-order mode forbids issue references in ${surface} (found "${found}"); PR text and issue links belong to the loop`
    );
  }
}
