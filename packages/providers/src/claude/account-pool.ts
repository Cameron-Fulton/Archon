/**
 * Per-step Claude subscription account rotation.
 *
 * Off unless `ARCHON_CLAUDE_ACCOUNTS` names at least one account. Each named
 * account supplies an OAuth token (`claude setup-token`) in
 * `ARCHON_CLAUDE_ACCOUNT_<NAME>_TOKEN`:
 *
 *   ARCHON_CLAUDE_ACCOUNTS=max1,max2,team1,team2
 *   ARCHON_CLAUDE_ACCOUNT_MAX1_TOKEN=sk-ant-oat01-...
 *
 * Tokens, not per-account CLAUDE_CONFIG_DIRs: a session transcript lives in the
 * config dir that created it, so rotating the config dir would break resume, and
 * skills/settings would differ per account. One config dir, many tokens.
 *
 * Policy (ported from the dev-system scheduler, not its code):
 * - pick the least-recently-used account that is not blocked;
 * - usage-limit exhaustion blocks the account until its reset (the SDK's
 *   `rate_limit_event.resetsAt`, else the "resets ..." prose, else 60 minutes);
 * - an auth failure blocks on an escalating ladder that decays, because a failed
 *   token refresh is often transient;
 * - server overload is NOT an account problem and never blocks an account;
 * - when every account is blocked the step fails with one typed error naming the
 *   earliest reset, rather than waiting.
 *
 * State is shared across processes through one JSON file under the Archon home,
 * re-read on every pick and written atomically.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as archonPaths from '@archon/paths';

export interface PoolAccount {
  name: string;
  token: string;
}

interface AccountState {
  blockedUntil?: number;
  blockReason?: 'quota' | 'auth';
  lastUsed?: number;
  authFails?: number;
  authFailAt?: number;
}

type PoolState = Record<string, AccountState>;

export const QUOTA_FALLBACK_MS = 60 * 60 * 1000;
export const AUTH_BLOCK_STEPS_MS = [60_000, 120_000, 300_000, 600_000];
export const AUTH_FAIL_DECAY_MS = 30 * 60 * 1000;

const NAME_RE = /^[A-Za-z0-9_]+$/;

export function loadAccounts(env: NodeJS.ProcessEnv = process.env): PoolAccount[] {
  const names = (env.ARCHON_CLAUDE_ACCOUNTS ?? '')
    .split(',')
    .map(n => n.trim())
    .filter(n => n.length > 0);
  const accounts: PoolAccount[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const token = env[`ARCHON_CLAUDE_ACCOUNT_${name.toUpperCase()}_TOKEN`];
    if (!token) continue;
    seen.add(name);
    accounts.push({ name, token });
  }
  return accounts;
}

/**
 * The env for one attempt on one account: the pool token becomes the only
 * credential. The CLI prefers an API key over an OAuth token, so a host
 * ANTHROPIC_API_KEY left in place would bypass the pool and bill per token.
 */
export function envForAccount(env: NodeJS.ProcessEnv, account: PoolAccount): NodeJS.ProcessEnv {
  const kept = Object.entries(env).filter(
    ([k]) => k !== 'ANTHROPIC_API_KEY' && k !== 'CLAUDE_API_KEY'
  );
  return { ...Object.fromEntries(kept), CLAUDE_CODE_OAUTH_TOKEN: account.token };
}

/**
 * Drop the pool's own variables. Every host-run subprocess inherits the host
 * env, so without this every agent shell could read every pool token.
 */
export function withoutPoolSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => k !== 'ARCHON_CLAUDE_ACCOUNTS' && !k.startsWith('ARCHON_CLAUDE_ACCOUNT_')
    )
  );
}

/** A request that brings its own credential (per-user delivery) bypasses the pool. */
export function requestHasOwnCredential(requestEnv: Record<string, string> | undefined): boolean {
  if (!requestEnv) return false;
  return Boolean(
    requestEnv.CLAUDE_CODE_OAUTH_TOKEN || requestEnv.ANTHROPIC_API_KEY || requestEnv.CLAUDE_API_KEY
  );
}

// ─── Usage-limit detection and reset parsing ──────────────────────────────

const QUOTA_MARKERS = [
  "you've hit your limit",
  "you've hit your weekly limit",
  "you're out of extra usage",
  'out of usage',
  'usage limit reached',
];

export function isQuotaText(text: string): boolean {
  const lower = text.toLowerCase().replace(/’/g, "'");
  return QUOTA_MARKERS.some(m => lower.includes(m));
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const RESET_RE =
  /resets\s+(?:([A-Za-z]{3})\s+(\d{1,2}),\s*)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/** Offset of `timeZone` from UTC at instant `utcMs`, in ms (east positive). */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find(p => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `timeZone`. */
function wallTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string
): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // second pass settles a guess that landed on the other side of a DST change
  return guess - zoneOffsetMs(first, timeZone);
}

function wallDateIn(utcMs: number, timeZone: string): { y: number; mo: number; d: number } {
  const shifted = new Date(utcMs + zoneOffsetMs(utcMs, timeZone));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

/**
 * Parse a usage-limit reset out of message text. Returns epoch ms, or undefined
 * when the text carries no reset this can trust.
 *
 * - "resets 12pm (America/New_York)"          five-hour cap: next occurrence
 * - "resets Sep 21, 3am (America/New_York)"   weekly cap: explicit date
 * - "usage limit reached|1785636600"          legacy form: epoch seconds
 */
export function parseResetText(text: string, now: number = Date.now()): number | undefined {
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (legacy) return toMs(Number(legacy[1]));

  const m = RESET_RE.exec(text);
  if (!m) return undefined;
  const [, monStr, dayStr, hourStr, minStr, ampm, tzRaw] = m;
  let hour = Number(hourStr);
  const minute = Number(minStr ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
  const month = monStr ? MONTHS[monStr.toLowerCase()] : undefined;
  if (monStr && month === undefined) return undefined;

  let timeZone: string | undefined = tzRaw.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    timeZone = undefined;
  }

  if (!timeZone) {
    // An unresolvable zone on a time-only reset tells us nothing. On a DATED
    // reset the day is known; assume UTC-12, the latest the reset can be, so the
    // block over-waits by at most a day and never expires early.
    if (month === undefined) return undefined;
    const year = new Date(now).getUTCFullYear();
    let at = Date.UTC(year, month, Number(dayStr), hour + 12, minute);
    if (at < now - 86_400_000) at = Date.UTC(year + 1, month, Number(dayStr), hour + 12, minute);
    return at;
  }

  const today = wallDateIn(now, timeZone);
  if (month !== undefined) {
    let at = wallTimeToUtc(today.y, month, Number(dayStr), hour, minute, timeZone);
    if (at < now - 86_400_000)
      at = wallTimeToUtc(today.y + 1, month, Number(dayStr), hour, minute, timeZone);
    return at;
  }
  let at = wallTimeToUtc(today.y, today.mo, today.d, hour, minute, timeZone);
  if (at <= now) at = wallTimeToUtc(today.y, today.mo, today.d + 1, hour, minute, timeZone);
  return at;
}

function toMs(epoch: number): number {
  return epoch < 1e12 ? epoch * 1000 : epoch;
}

/** What one attempt learned from the stream's rate-limit events. */
export interface RateLimitSink {
  rejectedResetAt?: number;
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
}

/**
 * Pass events through unchanged, recording a rejected rate-limit reset. A
 * rejection that overage is covering is not exhaustion: the account still
 * serves, so it is not recorded (seen live: status 'rejected' with
 * overageStatus 'allowed' and isUsingOverage true).
 */
export async function* tapRateLimits<T>(
  events: AsyncGenerator<T>,
  sink: RateLimitSink
): AsyncGenerator<T> {
  for await (const event of events) {
    const e = event as { type?: string; rate_limit_info?: RateLimitInfo };
    const info = e?.type === 'rate_limit_event' ? e.rate_limit_info : undefined;
    const overageCovers =
      info?.isUsingOverage === true ||
      info?.overageStatus === 'allowed' ||
      info?.overageStatus === 'allowed_warning';
    if (info?.status === 'rejected' && !overageCovers) {
      const r = info.resetsAt;
      if (typeof r === 'number' && r > 0) sink.rejectedResetAt = toMs(r);
    }
    yield event;
  }
}

/**
 * What a failed attempt means for its account.
 * - 'quota': the account's usage is exhausted; block it until reset, rotate.
 * - 'auth':  the account's credential failed; block on the ladder, rotate.
 * - 'none':  not the account's fault (overload, crash, bad request); the
 *            provider's normal retry policy applies on the same account.
 */
export function accountFailureKind(
  errorClass: string,
  text: string,
  sink: RateLimitSink
): 'quota' | 'auth' | 'none' {
  if (errorClass === 'auth') return 'auth';
  if (errorClass === 'rate_limit' && (isQuotaText(text) || sink.rejectedResetAt !== undefined)) {
    return 'quota';
  }
  if (errorClass !== 'rate_limit' && isQuotaText(text)) return 'quota';
  return 'none';
}

// ─── The pool ────────────────────────────────────────────────────────────────

export class ClaudeAccountsExhaustedError extends Error {
  readonly earliestResetAt: number | undefined;

  constructor(
    total: number,
    earliest: { name: string; at: number } | undefined,
    earliestQuotaAt: number | undefined,
    cause?: Error
  ) {
    const when = earliest
      ? `; the earliest frees up at ${new Date(earliest.at).toISOString()} (${earliest.name})`
      : '';
    // The legacy CLI form is what the workflow executor already reads as quota
    // exhaustion with a reset instant, so `workflows.autoResumeOnQuotaReset`
    // can resume the run. It names the first QUOTA reset: a short auth block on
    // one account must not spend the resume budget before the limits lift.
    const marker =
      earliestQuotaAt !== undefined
        ? ` (Claude AI usage limit reached|${Math.ceil(earliestQuotaAt / 1000)})`
        : '';
    // the last failure's own text keeps the executor's classification (an auth
    // failure stays fatal)
    const last = cause ? `. Last failure: ${cause.message}` : '';
    super(
      `All ${total} Claude accounts in ARCHON_CLAUDE_ACCOUNTS are blocked${when}${marker}${last}`
    );
    this.name = 'ClaudeAccountsExhaustedError';
    this.earliestResetAt = earliest?.at;
    if (cause) this.cause = cause;
  }
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(archonPaths.getArchonHome(env), 'claude-account-pool.json');
}

export class AccountPool {
  constructor(
    readonly accounts: PoolAccount[],
    private readonly statePath: string,
    private readonly now: () => number = Date.now
  ) {}

  /** The pool configured in `env`, or undefined when rotation is off. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AccountPool | undefined {
    const accounts = loadAccounts(env);
    if (accounts.length === 0) return undefined;
    const statePath = env.ARCHON_CLAUDE_ACCOUNT_STATE || defaultStatePath(env);
    return new AccountPool(accounts, statePath);
  }

  get size(): number {
    return this.accounts.length;
  }

  /**
   * Least-recently-used unblocked account not in `exclude`, marked used.
   * ponytail: read-modify-write without a file lock, so two processes picking in
   * the same millisecond can land on one account; add a lock if that shows up.
   */
  pick(exclude: ReadonlySet<string> = new Set()): PoolAccount | undefined {
    const state = this.read();
    const now = this.now();
    const free = this.accounts.filter(
      a => !exclude.has(a.name) && (state[a.name]?.blockedUntil ?? 0) <= now
    );
    if (free.length === 0) return undefined;
    free.sort((a, b) => (state[a.name]?.lastUsed ?? 0) - (state[b.name]?.lastUsed ?? 0));
    const chosen = free[0];
    state[chosen.name] = { ...state[chosen.name], lastUsed: now };
    this.write(state);
    return chosen;
  }

  /** Block until `resetAt`, or an hour when unknown. Never shortens a block. */
  blockForQuota(name: string, resetAt: number | undefined): number {
    const state = this.read();
    const now = this.now();
    const until = resetAt !== undefined && resetAt > now ? resetAt : now + QUOTA_FALLBACK_MS;
    const cur = state[name] ?? {};
    const blockedUntil = Math.max(cur.blockedUntil ?? 0, until);
    state[name] = { ...cur, blockedUntil, blockReason: 'quota' };
    this.write(state);
    return blockedUntil;
  }

  /** Escalating block for consecutive auth failures; the streak decays after 30 min. */
  blockForAuth(name: string): number {
    const state = this.read();
    const now = this.now();
    const cur = state[name] ?? {};
    const streak =
      cur.authFailAt !== undefined && now - cur.authFailAt <= AUTH_FAIL_DECAY_MS
        ? (cur.authFails ?? 0)
        : 0;
    const fails = streak + 1;
    const step = AUTH_BLOCK_STEPS_MS[Math.min(fails - 1, AUTH_BLOCK_STEPS_MS.length - 1)];
    const blockedUntil = Math.max(cur.blockedUntil ?? 0, now + step);
    state[name] = { ...cur, blockedUntil, blockReason: 'auth', authFails: fails, authFailAt: now };
    this.write(state);
    return blockedUntil;
  }

  /** A successful step clears the account's auth-failure streak. */
  recordSuccess(name: string): void {
    const state = this.read();
    const cur = state[name];
    if (!cur?.authFails) return;
    state[name] = { ...cur, authFails: 0 };
    this.write(state);
  }

  exhausted(cause?: Error): ClaudeAccountsExhaustedError {
    const state = this.read();
    const now = this.now();
    let earliest: { name: string; at: number } | undefined;
    let earliestQuotaAt: number | undefined;
    for (const a of this.accounts) {
      const s = state[a.name];
      const at = s?.blockedUntil;
      if (at === undefined || at <= now) continue;
      if (s?.blockReason === 'quota' && (earliestQuotaAt === undefined || at < earliestQuotaAt)) {
        earliestQuotaAt = at;
      }
      if (earliest === undefined || at < earliest.at) earliest = { name: a.name, at };
    }
    return new ClaudeAccountsExhaustedError(this.size, earliest, earliestQuotaAt, cause);
  }

  private read(): PoolState {
    try {
      if (!existsSync(this.statePath)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as PoolState) : {};
    } catch {
      // a torn or hand-edited file costs rotation history, never a step
      return {};
    }
  }

  private write(state: PoolState): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      renameSync(tmp, this.statePath);
    } catch {
      // state is advisory: a failed write must not fail the step it describes
    }
  }
}
