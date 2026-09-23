/**
 * ClaudeProvider with ARCHON_CLAUDE_ACCOUNTS set: per-step account rotation.
 * Own bun invocation, because it mocks @archon/paths and the SDK.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: () => '/nonexistent-archon-home',
}));

type MockQuery = (...args: Parameters<typeof sdkQuery>) => AsyncGenerator<unknown, void, unknown>;
const mockQuery = mock<MockQuery>(async function* () {});
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { ClaudeProvider } from './provider';
import { ClaudeAccountsExhaustedError } from './account-pool';

// verbatim shapes from claude CLI (see provider.test.ts #1797 block)
function synthetic(errorCode: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      model: '<synthetic>',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    error: errorCode,
    session_id: 'sid',
  };
}
function apiErrorResult(text: string): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: null,
    result: text,
    stop_reason: 'stop_sequence',
    terminal_reason: 'api_error',
    total_cost_usd: 0,
    session_id: 'sid',
  };
}
const ok = { type: 'result', session_id: 'sid-ok', usage: { input_tokens: 1, output_tokens: 1 } };
const QUOTA = "You've hit your limit · resets 12pm (America/New_York)";

const POOL_KEYS = [
  'ARCHON_CLAUDE_ACCOUNTS',
  'ARCHON_CLAUDE_ACCOUNT_A_TOKEN',
  'ARCHON_CLAUDE_ACCOUNT_B_TOKEN',
  'ARCHON_CLAUDE_ACCOUNT_STATE',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

const trackTempRoot = trackTempRoots();

describe('ClaudeProvider account pool', () => {
  let client: ClaudeProvider;
  let dir: string;
  let statePath: string;
  const saved: Record<string, string | undefined> = {};
  let tokensSeen: Array<string | undefined>;
  let apiKeysSeen: Array<string | undefined>;
  let poolVarsSeen: string[][];

  async function run(gen: AsyncIterable<Record<string, unknown>>) {
    const chunks: Array<Record<string, unknown>> = [];
    try {
      for await (const c of gen) chunks.push(c);
    } catch (e) {
      return { chunks, error: e as Error };
    }
    return { chunks, error: undefined };
  }

  /** Each call to query() runs the next scripted attempt. */
  function script(...attempts: Array<Array<Record<string, unknown>>>): void {
    let i = 0;
    mockQuery.mockImplementation(async function* (params) {
      const env = (params.options as Options).env ?? {};
      tokensSeen.push(env.CLAUDE_CODE_OAUTH_TOKEN);
      poolVarsSeen.push(Object.keys(env).filter(k => k.startsWith('ARCHON_CLAUDE_ACCOUNT')));
      apiKeysSeen.push(env.ANTHROPIC_API_KEY);
      const events = attempts[Math.min(i++, attempts.length - 1)];
      for (const e of events) yield e;
    });
  }

  function state(): Record<string, { blockedUntil?: number; blockReason?: string }> {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  }

  beforeEach(() => {
    for (const k of POOL_KEYS) saved[k] = process.env[k];
    dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'claude-pool-')));
    statePath = join(dir, 'pool.json');
    process.env.ARCHON_CLAUDE_ACCOUNTS = 'a,b';
    process.env.ARCHON_CLAUDE_ACCOUNT_A_TOKEN = 'tok-a';
    process.env.ARCHON_CLAUDE_ACCOUNT_B_TOKEN = 'tok-b';
    process.env.ARCHON_CLAUDE_ACCOUNT_STATE = statePath;
    process.env.ANTHROPIC_API_KEY = 'sk-host-api-key';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    client = new ClaudeProvider({ retryBaseDelayMs: 1 });
    mockQuery.mockClear();
    tokensSeen = [];
    apiKeysSeen = [];
    poolVarsSeen = [];
  });

  afterEach(() => {
    for (const k of POOL_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('usage limit on one account rotates to the next and the step succeeds', async () => {
    script([synthetic('rate_limit', QUOTA), apiErrorResult(QUOTA)], [ok]);

    const { chunks, error } = await run(client.sendQuery('p', '/workspace'));

    expect(error).toBeUndefined();
    expect(tokensSeen).toEqual(['tok-a', 'tok-b']);
    // the host API key would outrank the pool token, so it never reaches the CLI
    expect(apiKeysSeen).toEqual([undefined, undefined]);
    // no attempt can read the other accounts' tokens
    expect(poolVarsSeen).toEqual([[], []]);
    const note = chunks.find(
      c => c.type === 'system' && String(c.content).includes('continuing on b')
    );
    expect(note).toBeDefined();
    expect(String(note?.content)).not.toContain('tok-');
    expect(chunks.some(c => c.type === 'result')).toBe(true);
    expect(state().a?.blockReason).toBe('quota');
    expect(state().a?.blockedUntil).toBeGreaterThan(Date.now());
  });

  test('a structured rejected reset wins over the prose', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    script(
      [
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt, overageStatus: 'rejected' },
        },
        synthetic('rate_limit', QUOTA),
        apiErrorResult(QUOTA),
      ],
      [ok]
    );

    await run(client.sendQuery('p', '/workspace'));

    expect(state().a?.blockedUntil).toBe(resetsAt * 1000);
  });

  test('auth failure rotates too', async () => {
    const text = 'Not logged in · Please run /login';
    script([synthetic('authentication_failed', text), apiErrorResult(text)], [ok]);

    const { error } = await run(client.sendQuery('p', '/workspace'));

    expect(error).toBeUndefined();
    expect(tokensSeen).toEqual(['tok-a', 'tok-b']);
    expect(state().a?.blockReason).toBe('auth');
  });

  test('overload is not an account problem: same account, normal backoff', async () => {
    script([synthetic('overloaded', 'Overloaded'), apiErrorResult('Overloaded')], [ok]);

    const { error } = await run(client.sendQuery('p', '/workspace'));

    expect(error).toBeUndefined();
    expect(tokensSeen).toEqual(['tok-a', 'tok-a']);
    expect(state().a?.blockedUntil).toBeUndefined();
  });

  test('every account exhausted ends the step with one typed error', async () => {
    script([synthetic('rate_limit', QUOTA), apiErrorResult(QUOTA)]);

    const { error } = await run(client.sendQuery('p', '/workspace'));

    expect(error).toBeInstanceOf(ClaudeAccountsExhaustedError);
    expect(error?.message).toContain('All 2 Claude accounts');
    expect(tokensSeen).toEqual(['tok-a', 'tok-b']);
  });

  test('a fully blocked pool fails before spawning anything', async () => {
    script([ok]);
    await run(client.sendQuery('p', '/workspace')); // warm LRU
    process.env.ARCHON_CLAUDE_ACCOUNTS = 'a';
    script([synthetic('rate_limit', QUOTA), apiErrorResult(QUOTA)]);
    await run(client.sendQuery('p', '/workspace'));
    mockQuery.mockClear();

    const { error } = await run(client.sendQuery('p', '/workspace'));

    expect(error).toBeInstanceOf(ClaudeAccountsExhaustedError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a request that brings its own credential bypasses the pool', async () => {
    script([ok]);

    await run(
      client.sendQuery('p', '/workspace', undefined, {
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'per-user' },
      })
    );

    expect(tokensSeen).toEqual(['per-user']);
    expect(poolVarsSeen).toEqual([[]]);
  });

  test('pool off: credentials are exactly what they were', async () => {
    delete process.env.ARCHON_CLAUDE_ACCOUNTS;
    script([ok]);

    await run(client.sendQuery('p', '/workspace'));

    expect(tokensSeen).toEqual([undefined]);
    expect(apiKeysSeen).toEqual(['sk-host-api-key']);
    expect(existsSync(statePath)).toBe(false);
  });
});
