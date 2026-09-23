import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

mock.module('@archon/paths', () => ({
  getArchonHome: () => '/nonexistent-archon-home',
}));

import {
  AccountPool,
  AUTH_BLOCK_STEPS_MS,
  AUTH_FAIL_DECAY_MS,
  QUOTA_FALLBACK_MS,
  ClaudeAccountsExhaustedError,
  accountFailureKind,
  envForAccount,
  isQuotaText,
  loadAccounts,
  parseResetText,
  requestHasOwnCredential,
  tapRateLimits,
  withoutPoolSecrets,
  type RateLimitSink,
} from './account-pool';

describe('loadAccounts', () => {
  test('is empty (pool off) without ARCHON_CLAUDE_ACCOUNTS', () => {
    expect(loadAccounts({})).toEqual([]);
  });

  test('reads names in order and skips names with no token, bad names and duplicates', () => {
    const accounts = loadAccounts({
      ARCHON_CLAUDE_ACCOUNTS: ' max1, team1 ,missing,bad-name,max1',
      ARCHON_CLAUDE_ACCOUNT_MAX1_TOKEN: 't-max1',
      ARCHON_CLAUDE_ACCOUNT_TEAM1_TOKEN: 't-team1',
      'ARCHON_CLAUDE_ACCOUNT_BAD-NAME_TOKEN': 't-bad',
    });
    expect(accounts).toEqual([
      { name: 'max1', token: 't-max1' },
      { name: 'team1', token: 't-team1' },
    ]);
  });
});

describe('envForAccount', () => {
  test('sets the OAuth token and strips API keys that would outrank it', () => {
    const env = envForAccount(
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'sk-api',
        CLAUDE_API_KEY: 'sk-api2',
        CLAUDE_CODE_OAUTH_TOKEN: 'old',
      },
      { name: 'a', token: 'tok-a' }
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-a');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  test('pool variables never reach a subprocess env', () => {
    const env = withoutPoolSecrets({
      PATH: '/bin',
      ARCHON_CLAUDE_ACCOUNTS: 'a',
      ARCHON_CLAUDE_ACCOUNT_A_TOKEN: 'secret',
      ARCHON_CLAUDE_ACCOUNT_STATE: '/x',
      ARCHON_HOME: '/h',
    });
    expect(env).toEqual({ PATH: '/bin', ARCHON_HOME: '/h' });
  });

  test('a request that brings its own credential is recognised', () => {
    expect(requestHasOwnCredential(undefined)).toBe(false);
    expect(requestHasOwnCredential({ FOO: 'x' })).toBe(false);
    expect(requestHasOwnCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'x' })).toBe(true);
    expect(requestHasOwnCredential({ ANTHROPIC_API_KEY: 'x' })).toBe(true);
  });
});

describe('usage-limit text', () => {
  // verbatim from claude CLI output in dev-system pipeline logs
  const fiveHour = "You've hit your limit · resets 12pm (America/New_York)";
  const weekly = "You've hit your weekly limit · resets Sep 21, 3am (America/New_York)";
  const extra = "You're out of extra usage · resets 6am (America/New_York)";

  test('recognises real exhaustion messages and not overload', () => {
    expect(isQuotaText(fiveHour)).toBe(true);
    expect(isQuotaText(weekly)).toBe(true);
    expect(isQuotaText(extra)).toBe(true);
    expect(isQuotaText('You’ve hit your limit')).toBe(true);
    expect(isQuotaText('Overloaded')).toBe(false);
    expect(isQuotaText('API Error: 400 due to tool use concurrency issues')).toBe(false);
  });

  test('time-only reset is the next occurrence in that zone', () => {
    // 2026-09-23 14:00 UTC = 10:00 EDT; "12pm" is 16:00 UTC the same day
    const now = Date.UTC(2026, 8, 23, 14, 0);
    expect(parseResetText(fiveHour, now)).toBe(Date.UTC(2026, 8, 23, 16, 0));
    // at 17:00 UTC (13:00 EDT) noon has passed, so it is tomorrow
    const later = Date.UTC(2026, 8, 23, 17, 0);
    expect(parseResetText(fiveHour, later)).toBe(Date.UTC(2026, 8, 24, 16, 0));
  });

  test('dated reset uses the explicit day', () => {
    const now = Date.UTC(2026, 8, 18, 12, 0);
    // Sep 21 03:00 EDT = 07:00 UTC
    expect(parseResetText(weekly, now)).toBe(Date.UTC(2026, 8, 21, 7, 0));
  });

  test('winter time uses standard offset', () => {
    const now = Date.UTC(2026, 0, 10, 12, 0);
    // Jan 12 03:00 EST = 08:00 UTC
    expect(parseResetText('resets Jan 12, 3am (America/New_York)', now)).toBe(
      Date.UTC(2026, 0, 12, 8, 0)
    );
  });

  test('unknown zone: time-only gives nothing, dated assumes the latest offset', () => {
    const now = Date.UTC(2026, 8, 18, 12, 0);
    expect(parseResetText('resets 3am (ET)', now)).toBeUndefined();
    expect(parseResetText('resets Sep 21, 3am (ET)', now)).toBe(Date.UTC(2026, 8, 21, 15, 0));
  });

  test('legacy pipe form carries epoch seconds', () => {
    expect(parseResetText('Claude AI usage limit reached|1785636600')).toBe(1785636600 * 1000);
  });

  test('no reset in the text', () => {
    expect(parseResetText('rate limit exceeded')).toBeUndefined();
    expect(parseResetText('resets 13pm (America/New_York)')).toBeUndefined();
  });
});

describe('tapRateLimits', () => {
  async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  async function* from<T>(items: T[]): AsyncGenerator<T> {
    for (const i of items) yield i;
  }

  test('records a rejected reset and passes every event through', async () => {
    const sink: RateLimitSink = {};
    const events = [
      { type: 'assistant' },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1785636600, overageStatus: 'rejected' },
      },
    ];
    expect(await drain(tapRateLimits(from(events), sink))).toEqual(events);
    expect(sink.rejectedResetAt).toBe(1785636600 * 1000);
  });

  test('ignores a rejection that overage is covering (verbatim live shape)', async () => {
    const sink: RateLimitSink = {};
    await drain(
      tapRateLimits(
        from([
          {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'rejected',
              resetsAt: 1785636600,
              rateLimitType: 'five_hour',
              overageStatus: 'allowed',
              overageResetsAt: 1788220800,
              isUsingOverage: true,
              overageInUse: true,
            },
          },
        ]),
        sink
      )
    );
    expect(sink.rejectedResetAt).toBeUndefined();
  });

  test('ignores allowed and warning statuses', async () => {
    const sink: RateLimitSink = {};
    await drain(
      tapRateLimits(
        from([
          { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 5 } },
        ]),
        sink
      )
    );
    expect(sink.rejectedResetAt).toBeUndefined();
  });
});

describe('accountFailureKind', () => {
  test('auth is always the account', () => {
    expect(accountFailureKind('auth', 'Not logged in', {})).toBe('auth');
  });

  test('rate_limit is quota only with exhaustion evidence', () => {
    expect(accountFailureKind('rate_limit', "You've hit your limit · resets 3am (UTC)", {})).toBe(
      'quota'
    );
    expect(accountFailureKind('rate_limit', 'rate limited', { rejectedResetAt: 1 })).toBe('quota');
    expect(accountFailureKind('rate_limit', 'Overloaded', {})).toBe('none');
    expect(accountFailureKind('rate_limit', 'tool use concurrency', {})).toBe('none');
  });

  test('exhaustion prose under another class still counts', () => {
    expect(
      accountFailureKind('unknown', "Claude API error (unknown): You've hit your limit", {})
    ).toBe('quota');
    expect(accountFailureKind('crash', 'exited with code 1', {})).toBe('none');
  });
});

const trackTempRoot = trackTempRoots();

describe('AccountPool', () => {
  let dir: string;
  let statePath: string;
  let clock: number;
  const accounts = [
    { name: 'a', token: 'ta' },
    { name: 'b', token: 'tb' },
    { name: 'c', token: 'tc' },
  ];
  const pool = (): AccountPool => new AccountPool(accounts, statePath, () => clock);

  beforeEach(() => {
    dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'account-pool-')));
    statePath = join(dir, 'state.json');
    clock = Date.UTC(2026, 8, 23, 12, 0);
  });

  test('fromEnv is undefined when the pool is off', () => {
    expect(AccountPool.fromEnv({})).toBeUndefined();
  });

  test('picks least recently used, across instances (shared state file)', () => {
    expect(pool().pick()?.name).toBe('a');
    clock += 1;
    expect(pool().pick()?.name).toBe('b');
    clock += 1;
    expect(pool().pick()?.name).toBe('c');
    clock += 1;
    expect(pool().pick()?.name).toBe('a');
  });

  test('skips excluded and blocked accounts', () => {
    const p = pool();
    p.blockForQuota('a', clock + 1000);
    expect(p.pick(new Set(['b']))?.name).toBe('c');
  });

  test('quota block uses the reset, falls back to an hour, never shortens', () => {
    const p = pool();
    expect(p.blockForQuota('a', clock + 5_000)).toBe(clock + 5_000);
    expect(p.blockForQuota('a', clock + 1_000)).toBe(clock + 5_000);
    expect(p.blockForQuota('b', undefined)).toBe(clock + QUOTA_FALLBACK_MS);
    expect(p.blockForQuota('c', clock - 1)).toBe(clock + QUOTA_FALLBACK_MS);
  });

  test('a block expires', () => {
    const p = pool();
    p.blockForQuota('a', clock + 1_000);
    p.blockForQuota('b', clock + 1_000);
    p.blockForQuota('c', clock + 1_000);
    expect(p.pick()).toBeUndefined();
    clock += 1_000;
    expect(p.pick()?.name).toBeDefined();
  });

  test('auth ladder escalates, caps, and decays', () => {
    const p = pool();
    const steps = [];
    for (let i = 0; i < 5; i++) {
      steps.push(p.blockForAuth('a') - clock);
      clock += 1_000;
    }
    // escalates step by step, then holds at the top step
    expect(steps).toEqual([...AUTH_BLOCK_STEPS_MS, AUTH_BLOCK_STEPS_MS[3]]);
    clock += AUTH_FAIL_DECAY_MS + 1;
    expect(p.blockForAuth('a') - clock).toBe(AUTH_BLOCK_STEPS_MS[0]);
  });

  test('success clears the auth streak', () => {
    const p = pool();
    p.blockForAuth('a');
    p.blockForAuth('a');
    p.recordSuccess('a');
    clock += AUTH_BLOCK_STEPS_MS[3];
    expect(p.blockForAuth('a') - clock).toBe(AUTH_BLOCK_STEPS_MS[0]);
  });

  test('exhausted names the earliest reset', () => {
    const p = pool();
    p.blockForQuota('a', clock + 9_000);
    p.blockForQuota('b', clock + 3_000);
    p.blockForQuota('c', clock + 6_000);
    const err = p.exhausted();
    expect(err).toBeInstanceOf(ClaudeAccountsExhaustedError);
    expect(err.earliestResetAt).toBe(clock + 3_000);
    expect(err.message).toContain('All 3 Claude accounts');
    expect(err.message).toContain('(b)');
    expect(err.message).not.toContain('tb');
  });

  test('exhausted by usage limits carries the form the workflow executor resumes on', () => {
    const p = pool();
    p.blockForQuota('a', clock + 90_000);
    p.blockForAuth('b');
    p.blockForQuota('c', clock + 120_000);
    // b's one-minute auth block is earliest, but the resume instant is a's quota reset
    const message = p.exhausted().message;
    expect(message).toContain('(b)');
    expect(message).toContain(`usage limit reached|${Math.ceil((clock + 90_000) / 1000)}`);
  });

  test('exhausted by auth failures alone is not called a usage limit', () => {
    const p = pool();
    for (const n of ['a', 'b', 'c']) p.blockForAuth(n);
    const message = p.exhausted(new Error('Claude API error (authentication_failed): 401')).message;
    expect(message).not.toContain('usage limit');
    // the cause's text keeps the workflow executor's fatal classification
    expect(message).toContain('authentication_failed');
  });

  test('a corrupt state file costs history, not the pick', () => {
    writeFileSync(statePath, '{not json');
    expect(pool().pick()?.name).toBe('a');
  });
});
