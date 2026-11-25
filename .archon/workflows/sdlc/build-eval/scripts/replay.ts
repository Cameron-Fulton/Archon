/**
 * History-less `git archive` replay sandbox and isolated execution environment.
 *
 * Every past-task replay starts from `git archive <parent_commit>` extracted into a
 * fresh directory with ZERO git history, ZERO later commits, and ZERO remotes.
 * When a build tool or diff grader needs a git root, an optional single parentless
 * snapshot commit is created with fixed identity and timestamp so builders can never
 * look up the real merged answer or infer anything from commit history.
 *
 * The replay environment always forces `ARCHON_WORK_ORDER_MODE=1`, strips forge and
 * cloud tokens, strips inherited proxies, and enforces the `no_network_except_model_api`
 * allowlist policy.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, gitOrThrow } from '../../.shared/git.ts';
import { assertOutsideAgentTrees, isCommitSha, toPosixPath } from './schema.ts';

export const NETWORK_POLICY_MODE = 'no_network_except_model_api' as const;

/** Default model API host allowlist for isolated replays. */
export const DEFAULT_MODEL_API_ALLOWLIST: readonly string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  '127.0.0.1',
  'localhost',
];

/** Outbound hosts that must never be allowlisted in replay mode (forges, registries). */
const FORBIDDEN_ALLOWLIST_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'registry.npmjs.org',
  'pypi.org',
  '0.0.0.0',
  '*',
]);

const SNAPSHOT_AUTHOR = {
  name: 'Developer',
  email: 'developer@example.com',
  date: '2026-01-01T00:00:00Z',
};

const STRIPPED_EXACT_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'GITEA_TOKEN',
  'FORGE_TOKEN',
  'ARCHON_FORGE_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUDSDK_AUTH_ACCESS_TOKEN',
  'AZURE_CLIENT_SECRET',
  'CLOUDFLARE_API_TOKEN',
]);

const STRIPPED_PREFIXES = ['GH_TOKEN_', 'GITHUB_TOKEN_', 'GITLAB_TOKEN_', 'GITEA_TOKEN_'];
const PROXY_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY', 'NO_PROXY']);
const WORK_ORDER_ENV_KEYS = new Set(['ARCHON_WORK_ORDER_MODE', 'INPUTS_WORK_ORDER_MODE']);
const TRUTHY_WORK_ORDER = new Set(['1', 'true']);

/** Raised when a replay environment violates the network isolation policy. */
export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

/** Raised when a replay sandbox fails its history-less seal verification. */
export class ReplaySealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplaySealError';
  }
}

export interface NetworkIsolationConfig {
  readonly mode: typeof NETWORK_POLICY_MODE;
  readonly allowedHosts: readonly string[];
  /** Optional local allowlisting HTTP proxy URL (must itself resolve to an allowed host). */
  readonly proxyUrl?: string;
}

export interface PrepareReplayOptions {
  readonly repoRoot: string;
  readonly parentCommit: string;
  /** Parent directory where the sandbox folder is created; defaults to OS tmpdir. */
  readonly outDir?: string;
  /**
   * When true (default), initializes a single parentless snapshot commit with fixed
   * identity/date and ZERO remotes so diff-based tools and graders work without leaking history.
   * When false, leaves the extracted archive with NO `.git` directory at all.
   */
  readonly initSnapshotGit?: boolean;
  readonly snapshotBranch?: string;
  readonly fixedDate?: string;
}

export interface ReplaySandbox {
  readonly dir: string;
  readonly parentCommit: string;
  readonly hasSnapshotGit: boolean;
  readonly snapshotCommit: string | null;
  /** Pre-builder snapshot of every file/symlink in `dir` (excluding top-level `.git`). */
  readonly initialFiles: ReadonlyMap<string, string>;
}

export interface ReplayEnvOptions {
  readonly network?: NetworkIsolationConfig;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function normalizeHost(hostOrUrl: string): string {
  const trimmed = hostOrUrl.trim();
  if (trimmed === '' || trimmed.includes('@') || trimmed.includes('\\') || /\s/.test(trimmed)) {
    return '';
  }
  const hasScheme = trimmed.includes('://');
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username !== '' || parsed.password !== '') return '';
  if (!hasScheme && (parsed.search !== '' || parsed.hash !== '' || (parsed.pathname !== '' && parsed.pathname !== '/'))) {
    return '';
  }
  return parsed.hostname.toLowerCase();
}

/**
 * Validate a replay network-isolation config. Fails closed on wildcards, empty
 * allowlists, unsupported modes, or forbidden forge/registry hosts.
 */
export function validateNetworkPolicy(config: NetworkIsolationConfig): NetworkIsolationConfig {
  if (config.mode !== NETWORK_POLICY_MODE) {
    throw new NetworkPolicyError(
      `unsupported replay network mode "${String(config.mode)}"; must be "${NETWORK_POLICY_MODE}"`
    );
  }
  if (config.allowedHosts.length === 0) {
    throw new NetworkPolicyError('replay network allowlist must name at least one model API host');
  }
  const normalized: string[] = [];
  for (const rawHost of config.allowedHosts) {
    const host = normalizeHost(rawHost);
    if (host === '' || host.includes('*') || FORBIDDEN_ALLOWLIST_HOSTS.has(host)) {
      throw new NetworkPolicyError(
        `replay network allowlist forbids host "${rawHost}" (only explicit model API hosts are permitted)`
      );
    }
    normalized.push(host);
  }
  if (config.proxyUrl !== undefined) {
    const proxyHost = normalizeHost(config.proxyUrl);
    if (proxyHost === '' || !normalized.includes(proxyHost)) {
      throw new NetworkPolicyError(
        `replay proxy "${config.proxyUrl}" must point to an allowlisted host (${normalized.join(', ')})`
      );
    }
  }
  return {
    mode: NETWORK_POLICY_MODE,
    allowedHosts: [...new Set(normalized)],
    ...(config.proxyUrl !== undefined ? { proxyUrl: config.proxyUrl } : {}),
  };
}

/** Return true ONLY when `hostOrUrl` resolves to an exact entry in `config.allowedHosts`. */
export function isHostAllowed(hostOrUrl: string, config: NetworkIsolationConfig): boolean {
  const validated = validateNetworkPolicy(config);
  const host = normalizeHost(hostOrUrl);
  return host !== '' && validated.allowedHosts.includes(host);
}

/** Throw `NetworkPolicyError` when `hostOrUrl` is not permitted by the replay policy. */
export function assertHostAllowed(hostOrUrl: string, config: NetworkIsolationConfig): void {
  if (!isHostAllowed(hostOrUrl, config)) {
    throw new NetworkPolicyError(
      `replay network policy (${config.mode}) blocks outbound host "${hostOrUrl}"`
    );
  }
}

function shouldStripEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (STRIPPED_EXACT_ENV_KEYS.has(upper) || PROXY_ENV_KEYS.has(upper)) return true;
  return STRIPPED_PREFIXES.some(prefix => upper.startsWith(prefix));
}

function assertWorkOrderNotLowered(key: string, value: string): void {
  const upper = key.toUpperCase();
  if (!WORK_ORDER_ENV_KEYS.has(upper)) return;
  const normalized = value.trim().toLowerCase();
  if (!TRUTHY_WORK_ORDER.has(normalized)) {
    throw new Error(`replay environment forbids lowering ${upper} to "${value}"`);
  }
}

function copySanitizedEnv(
  source: Readonly<Record<string, string | undefined>>,
  target: Record<string, string>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    assertWorkOrderNotLowered(key, value);
    if (shouldStripEnvKey(key) || WORK_ORDER_ENV_KEYS.has(key.toUpperCase())) continue;
    target[key] = value;
  }
}

function applyProxyEnv(env: Record<string, string>, network: NetworkIsolationConfig): void {
  if (network.proxyUrl === undefined) return;
  env.HTTP_PROXY = network.proxyUrl;
  env.http_proxy = network.proxyUrl;
  env.HTTPS_PROXY = network.proxyUrl;
  env.https_proxy = network.proxyUrl;
  const loopback = network.allowedHosts.filter(host => host === '127.0.0.1' || host === 'localhost');
  if (loopback.length > 0) {
    const joined = loopback.join(',');
    env.NO_PROXY = joined;
    env.no_proxy = joined;
  }
}

/**
 * Build a sanitized environment for a replay run:
 * - Forces `ARCHON_WORK_ORDER_MODE=1` (rejects lowering on any case variant).
 * - Strips forge/GitHub/cloud tokens and all inherited proxy vars unconditionally.
 * - Enforces `no_network_except_model_api` env markers and proxy hygiene.
 */
export function buildReplayEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: ReplayEnvOptions = {}
): Record<string, string> {
  const network = validateNetworkPolicy(
    options.network ?? { mode: NETWORK_POLICY_MODE, allowedHosts: DEFAULT_MODEL_API_ALLOWLIST }
  );
  const env: Record<string, string> = {};
  copySanitizedEnv(baseEnv, env);
  if (options.extraEnv !== undefined) copySanitizedEnv(options.extraEnv, env);
  env.ARCHON_WORK_ORDER_MODE = '1';
  env.INPUTS_WORK_ORDER_MODE = 'true';
  env.ARCHON_NETWORK_POLICY = network.mode;
  env.ARCHON_ALLOWED_HOSTS = network.allowedHosts.join(',');
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  applyProxyEnv(env, network);
  return env;
}

/**
 * Snapshot every file and symlink beneath `rootDir` (excluding only top-level `.git`)
 * into a map of relative POSIX path -> content fingerprint (`file:<sha256>` or `symlink:<target>`).
 */
export function snapshotSandboxFiles(rootDir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (rel === '.git') continue;
      const fullPath = join(dir, entry.name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        snapshot.set(toPosixPath(rel), `symlink:${readlinkSync(fullPath)}`);
      } else if (stat.isDirectory()) {
        walk(fullPath, rel);
      } else if (stat.isFile()) {
        const digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex');
        snapshot.set(toPosixPath(rel), `file:${digest}`);
      }
    }
  };
  walk(rootDir, '');
  return snapshot;
}

function createSandboxDirectory(outDir?: string): string {
  const parent = outDir === undefined ? tmpdir() : resolve(outDir);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'archon-build-replay-'));
}

function extractParentArchive(repoRoot: string, parentCommit: string, sandboxDir: string): void {
  const archive = Bun.spawnSync(
    ['git', '-C', repoRoot, 'archive', '--format=tar', parentCommit],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  if (archive.exitCode !== 0) {
    throw new Error(`git archive ${parentCommit} failed: ${archive.stderr.toString().trim()}`);
  }
  const extract = Bun.spawnSync(['tar', '-x', '-C', sandboxDir], {
    stdin: archive.stdout,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (extract.exitCode !== 0) {
    throw new Error(
      `extracting git archive for ${parentCommit} failed: ${extract.stderr.toString().trim()}`
    );
  }
}

function initSingleSnapshotCommit(sandboxDir: string, branch: string, fixedDate: string): string {
  const snapshotEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: SNAPSHOT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: SNAPSHOT_AUTHOR.email,
    GIT_AUTHOR_DATE: fixedDate,
    GIT_COMMITTER_NAME: SNAPSHOT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: SNAPSHOT_AUTHOR.email,
    GIT_COMMITTER_DATE: fixedDate,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (...args: string[]): string => {
    const result = Bun.spawnSync(
      ['git', '-C', sandboxDir, '-c', 'commit.gpgsign=false', ...args],
      { stdout: 'pipe', stderr: 'pipe', env: snapshotEnv }
    );
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString().trim();
  };
  run('init', '-q', '-b', branch);
  run('add', '-A');
  run('commit', '-q', '--allow-empty', '-m', 'Initial snapshot');
  rmSync(join(sandboxDir, '.git', 'logs'), { recursive: true, force: true });
  return run('rev-parse', 'HEAD');
}

/**
 * Verify that `sandboxDir` is properly sealed:
 * - When `expectSnapshotGit === false`: `.git` MUST NOT exist AND `git rev-parse --is-inside-work-tree`
 *   MUST fail so no enclosing parent `.git` can be inherited.
 * - When `expectSnapshotGit === true`: exactly 1 parentless commit, ZERO remotes,
 *   and ZERO tags.
 */
export function verifyReplaySandbox(sandboxDir: string, expectSnapshotGit: boolean): void {
  const gitPath = join(sandboxDir, '.git');
  if (!expectSnapshotGit) {
    if (existsSync(gitPath)) {
      throw new ReplaySealError(`replay sandbox ${sandboxDir} must not contain .git`);
    }
    const inherited = git('-C', sandboxDir, 'rev-parse', '--is-inside-work-tree');
    if (inherited.code === 0) {
      throw new ReplaySealError(
        `replay sandbox ${sandboxDir} inherits an enclosing git repository`
      );
    }
    return;
  }
  if (!existsSync(gitPath)) {
    throw new ReplaySealError(`replay sandbox ${sandboxDir} is missing its snapshot .git root`);
  }
  const commitCount = gitOrThrow('-C', sandboxDir, 'rev-list', '--count', '--all');
  if (commitCount !== '1') {
    throw new ReplaySealError(
      `replay sandbox ${sandboxDir} has ${commitCount} commits; expected exactly 1 parentless snapshot`
    );
  }
  const parents = gitOrThrow('-C', sandboxDir, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/);
  if (parents.length !== 1) {
    throw new ReplaySealError(
      `replay sandbox ${sandboxDir} snapshot commit has parents (${parents.slice(1).join(', ')})`
    );
  }
  const remotes = gitOrThrow('-C', sandboxDir, 'remote');
  if (remotes !== '') {
    throw new ReplaySealError(`replay sandbox ${sandboxDir} leaks remotes: ${remotes}`);
  }
  const tags = gitOrThrow('-C', sandboxDir, 'tag');
  if (tags !== '') {
    throw new ReplaySealError(`replay sandbox ${sandboxDir} leaks tags: ${tags}`);
  }
}

/**
 * Prepare a sealed, history-less replay sandbox from `git archive <parentCommit>`.
 */
export function prepareReplaySandbox(options: PrepareReplayOptions): ReplaySandbox {
  const { repoRoot, parentCommit } = options;
  if (!isCommitSha(parentCommit)) {
    throw new Error(`parent_commit "${parentCommit}" must be a 40-hex commit SHA`);
  }
  if (options.outDir !== undefined) {
    assertOutsideAgentTrees(options.outDir, { repoRoot });
  }
  const verified = git('-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${parentCommit}^{commit}`);
  if (verified.code !== 0) {
    throw new Error(`parent_commit ${parentCommit} does not exist in ${repoRoot}`);
  }
  const initSnapshotGit = options.initSnapshotGit ?? true;
  const sandboxDir = createSandboxDirectory(options.outDir);
  try {
    assertOutsideAgentTrees(sandboxDir, { repoRoot });
    extractParentArchive(repoRoot, parentCommit, sandboxDir);
    const snapshotCommit = initSnapshotGit
      ? initSingleSnapshotCommit(
          sandboxDir,
          options.snapshotBranch ?? 'main',
          options.fixedDate ?? SNAPSHOT_AUTHOR.date
        )
      : null;
    verifyReplaySandbox(sandboxDir, initSnapshotGit);
    const initialFiles = snapshotSandboxFiles(sandboxDir);
    return {
      dir: sandboxDir,
      parentCommit,
      hasSnapshotGit: initSnapshotGit,
      snapshotCommit,
      initialFiles,
    };
  } catch (error) {
    rmSync(sandboxDir, { recursive: true, force: true });
    throw error;
  }
}
