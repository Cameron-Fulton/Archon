import { buildProviderSubprocessEnv } from '@archon/provider-contract';
import type { SendQueryOptions } from '../types';
import { ClassifiedProviderError } from '../shared/failure';

const OAUTH_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const HOST_MANAGED = 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST';

function deliveredClaudeCredential(options: SendQueryOptions | undefined): string | undefined {
  return [OAUTH_TOKEN, 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'].find(
    key => options?.userCredentialEnvKeys?.includes(key) && options.env?.[key]
  );
}

function factoryGrantToken(
  options: SendQueryOptions | undefined,
  env: NodeJS.ProcessEnv,
  delivered: string | undefined
): string | undefined {
  // Squeeze and the Factory launcher have already narrowed the pool to one login.
  const workOrderMode = (process.env.ARCHON_WORK_ORDER_MODE ?? '').trim().toLowerCase();
  if (['', '0', 'false'].includes(workOrderMode)) return;
  if (!['1', 'true'].includes(workOrderMode)) {
    throw new ClassifiedProviderError('misconfigured', 'Invalid host work-order mode');
  }
  const grantedAccounts = process.env.ARCHON_CLAUDE_ACCOUNTS;
  if (grantedAccounts === undefined) return;
  const account = grantedAccounts.trim();
  if (!/^[a-z0-9_]+$/i.test(account) || options?.execContext?.kind === 'container') {
    throw new ClassifiedProviderError('misconfigured', 'Expected one host Claude grant account');
  }
  if (delivered || env.ANTHROPIC_BASE_URL?.trim()) {
    throw new ClassifiedProviderError(
      'misconfigured',
      'Conflicting Claude grant credential or endpoint'
    );
  }
  const token = process.env[`ARCHON_CLAUDE_ACCOUNT_${account.toUpperCase()}_TOKEN`]?.trim();
  if (!token) {
    throw new ClassifiedProviderError(
      'misconfigured',
      'Claude grant account credential is missing'
    );
  }
  return token;
}

function bindCredential(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  for (const key of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_API_KEY',
    OAUTH_TOKEN,
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_API_KEY_HELPER_FD',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  ]) {
    delete env[key];
  }
  env[key === 'CLAUDE_API_KEY' ? 'ANTHROPIC_API_KEY' : key] = value;
  for (const key of [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_MANTLE',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  ]) {
    env[key] = '0';
  }
  // Native settings env otherwise overwrites the delivered identity.
  env[HOST_MANAGED] = '1';
}

export function buildClaudeSubprocessEnv(options: SendQueryOptions | undefined): NodeJS.ProcessEnv {
  const env = buildProviderSubprocessEnv(options);
  const delivered = deliveredClaudeCredential(options);
  const grantToken = factoryGrantToken(options, env, delivered);
  if (grantToken) {
    for (const key of Object.keys(env)) {
      if (key === 'ARCHON_CLAUDE_ACCOUNTS' || key.startsWith('ARCHON_CLAUDE_ACCOUNT_'))
        delete env[key];
    }
    bindCredential(env, OAUTH_TOKEN, grantToken);
  } else if (delivered) {
    bindCredential(env, delivered, options?.env?.[delivered]);
  } else if (env.CLAUDE_API_KEY && !env.ANTHROPIC_API_KEY && !env[OAUTH_TOKEN]) {
    env.ANTHROPIC_API_KEY = env.CLAUDE_API_KEY;
  }
  return env;
}

export function managedClaudeSettings(env: NodeJS.ProcessEnv): { apiKeyHelper: '' } | undefined {
  return env[HOST_MANAGED] === '1' ? { apiKeyHelper: '' } : undefined;
}
