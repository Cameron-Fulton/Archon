import type { NodeExecutionMetadata } from './schemas/node-execution';
import { USER_CONTROLLED_VARIABLES } from './user-controlled-variables';
import { currentPackDir } from './workflow-variables';
import { packDirOrThrow, type PackDirScope } from './pack-dir';

/** The part of a node's execution record its own process may read. */
export type NodeExecutionIdentity = Pick<
  NodeExecutionMetadata,
  'runId' | 'path' | 'invocation' | 'attempt'
>;

export interface ExecNodeEnvironmentContext {
  artifactsDir: string;
  stateDir: string;
  logDir: string;
  workflowId: string;
  baseBranch: string;
  userMessage: string;
  loopUserInput: string;
  loopPrevOutput: string;
  rejectionReason: string;
  issueContext?: string;
  adoptedRunDir?: string | undefined;
  /**
   * This invocation's typed-artifact listing. Required so a real invocation cannot
   * forget it and hand its script an empty pointer; only a caller with no listing
   * (the dry run) passes `''` explicitly. The path is inside the run's artifact dir,
   * so a container that mounts it reads the same bytes at the same path.
   */
  typedArtifactsFile: string;
  /** This invocation's node-outcome listing, required for the same reason. */
  nodeOutcomesFile: string;
  /**
   * The execution this process belongs to: identity plus the invocation's and this
   * attempt's checkout starts (#3375). Carries manifest pointers and digests, never
   * manifest contents. Required for the same reason as `typedArtifactsFile`; only a
   * caller with no execution record passes `null`, which delivers an empty value.
   */
  nodeExecution: NodeExecutionIdentity | null;
  inputEnvKeys: readonly string[];
}

const WORK_ORDER_TRUTHY = new Set(['1', 'true']);
const WORK_ORDER_FALSY = new Set(['', '0', 'false']);

/**
 * Whether the host process enabled work-order mode via `ARCHON_WORK_ORDER_MODE`.
 * Fails closed on invalid values so a typo cannot silently disable isolation.
 */
export function hostWorkOrderMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ARCHON_WORK_ORDER_MODE ?? '').trim().toLowerCase();
  if (WORK_ORDER_FALSY.has(raw)) return false;
  if (WORK_ORDER_TRUTHY.has(raw)) return true;
  throw new Error(
    `ARCHON_WORK_ORDER_MODE must be "true", "false", "1", or "0", not "${(env.ARCHON_WORK_ORDER_MODE ?? '').trim()}"`
  );
}

export function buildExecNodeEnvironment(
  context: ExecNodeEnvironmentContext,
  hostEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const workOrder = hostWorkOrderMode(hostEnv);
  const userVariables: Record<string, string> = {};
  for (const group of USER_CONTROLLED_VARIABLES) {
    for (const name of group.names) userVariables[name] = context[group.source] ?? '';
  }
  const env: Record<string, string> = {
    ARTIFACTS_DIR: context.artifactsDir,
    STATE_DIR: context.stateDir,
    LOG_DIR: context.logDir,
    ADOPTED_RUN_DIR: context.adoptedRunDir ?? '',
    // Read from the dispatch scope rather than passed by each caller, so no exec path can
    // forget it. Empty for a workflow outside a pack, as ADOPTED_RUN_DIR is without one;
    // a pack the run's source does not hold fails the node instead of reading ''.
    PACK_DIR: packDirEnvValue(currentPackDir()),
    // $WORKFLOW_ID substitutes into the body, but a heredoc'd python/node block
    // reads os.environ and found it missing while its siblings above were all
    // present. Deliver it the same way.
    WORKFLOW_ID: context.workflowId,
    BASE_BRANCH: context.baseBranch,
    ...userVariables,
    // The listing path, delivered like the other engine-reserved keys: configured
    // project env and node bindings spread before this bag, so neither can shadow it.
    TYPED_ARTIFACTS_FILE: context.typedArtifactsFile,
    NODE_OUTCOMES_FILE: context.nodeOutcomesFile,
    ARCHON_RUN_ENV_KEYS: '',
    ARCHON_NODE_EXECUTION:
      context.nodeExecution === null ? '' : nodeExecutionEnvValue(context.nodeExecution),
    // Emitted LAST so repo `.archon/config.yaml` envVars cannot weaken it and container
    // runs always receive it via ARCHON_RUN_ENV_KEYS.
    ...(workOrder ? { ARCHON_WORK_ORDER_MODE: '1' } : {}),
  };
  env.ARCHON_RUN_ENV_KEYS = JSON.stringify([...Object.keys(env), ...context.inputEnvKeys]);
  return env;
}

function nodeExecutionEnvValue(execution: NodeExecutionIdentity): string {
  return JSON.stringify({
    runId: execution.runId,
    path: execution.path,
    invocation: execution.invocation,
    attempt: execution.attempt,
  });
}

/**
 * The run identity an AI node's provider subprocess carries, so an `archon state`
 * write from the agent's shell records this run and node (#4059). Spread after the
 * configured project env so none of these keys can be shadowed by it. `ARCHON_CLI_COMMAND`
 * is always owned here, empty when the host has none to give (a container does not have the
 * host executable), so a project-env value never stands in for it.
 */
export function buildAiNodeEnvironment(
  execution: NodeExecutionIdentity,
  cliCommand: string | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const workOrder = hostWorkOrderMode(hostEnv);
  return {
    WORKFLOW_ID: execution.runId,
    ARCHON_NODE_EXECUTION: nodeExecutionEnvValue(execution),
    ARCHON_CLI_COMMAND: cliCommand ?? '',
    // Emitted LAST so repo `.archon/config.yaml` envVars cannot clear it and container
    // AI runs always receive it.
    ...(workOrder ? { ARCHON_WORK_ORDER_MODE: '1' } : {}),
  };
}

export const EXEC_NODE_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(
    buildExecNodeEnvironment({
      artifactsDir: '',
      stateDir: '',
      logDir: '',
      workflowId: '',
      baseBranch: '',
      userMessage: '',
      loopUserInput: '',
      loopPrevOutput: '',
      rejectionReason: '',
      typedArtifactsFile: '',
      nodeOutcomesFile: '',
      nodeExecution: null,
      inputEnvKeys: [],
    })
  )
);

function packDirEnvValue(scope: PackDirScope | undefined): string {
  return scope === undefined || scope.kind === 'none' ? '' : packDirOrThrow(scope);
}
