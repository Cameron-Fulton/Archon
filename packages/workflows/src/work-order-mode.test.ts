import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildAiNodeEnvironment,
  buildExecNodeEnvironment,
  hostWorkOrderMode,
  type ExecNodeEnvironmentContext,
  type NodeExecutionIdentity,
} from './exec-environment';
import {
  buildNodeShellEnvironment,
  inputEnvVars,
  resolveNodeBindings,
  resolveRunInputs,
  type ShellInputContext,
} from './dag/references';
import { resolveRunStartInputs } from './pack-settings';
import type { DagNode, ResolvedWorkflow } from './schemas';

const originalWorkOrderEnv = process.env.ARCHON_WORK_ORDER_MODE;

afterEach(() => {
  if (originalWorkOrderEnv === undefined) {
    delete process.env.ARCHON_WORK_ORDER_MODE;
  } else {
    process.env.ARCHON_WORK_ORDER_MODE = originalWorkOrderEnv;
  }
});

const baseExecContext: Omit<ExecNodeEnvironmentContext, 'inputEnvKeys'> = {
  artifactsDir: '/artifacts',
  stateDir: '/state',
  logDir: '/logs',
  workflowId: 'run-1',
  baseBranch: 'dev',
  userMessage: 'msg',
  loopUserInput: '',
  loopPrevOutput: '',
  rejectionReason: '',
  typedArtifactsFile: '/artifacts/typed.json',
  nodeOutcomesFile: '/artifacts/outcomes.json',
  nodeExecution: null,
};

const executionIdentity: NodeExecutionIdentity = {
  runId: 'run-1',
  path: 'scope',
  invocation: { id: 'inv-1', startedAt: '2026-10-16T00:00:00.000Z', loopPath: [] },
  attempt: { id: 'att-1', startedAt: '2026-10-16T00:00:00.000Z' },
};

const shellContext = (inputs?: Record<string, unknown>): ShellInputContext => ({
  workflowRun: {
    id: 'run-1',
    user_message: '',
    metadata: inputs === undefined ? {} : { inputs },
  },
  artifactsDir: '/artifacts',
  stateDir: '/state',
  baseBranch: 'dev',
  docsDir: 'docs',
  nodeOutputs: new Map(),
  loopBodyScopes: [],
});

describe('host ARCHON_WORK_ORDER_MODE environment enforcement', () => {
  it('parses valid values and fails closed on invalid values', () => {
    expect(hostWorkOrderMode({})).toBe(false);
    expect(hostWorkOrderMode({ ARCHON_WORK_ORDER_MODE: '0' })).toBe(false);
    expect(hostWorkOrderMode({ ARCHON_WORK_ORDER_MODE: 'false' })).toBe(false);
    expect(hostWorkOrderMode({ ARCHON_WORK_ORDER_MODE: '1' })).toBe(true);
    expect(hostWorkOrderMode({ ARCHON_WORK_ORDER_MODE: 'TRUE' })).toBe(true);
    expect(() => hostWorkOrderMode({ ARCHON_WORK_ORDER_MODE: 'maybe' })).toThrow(
      'ARCHON_WORK_ORDER_MODE must be'
    );
  });

  it('emits ARCHON_WORK_ORDER_MODE=1 last in exec and container envs so repo config cannot clear it', () => {
    process.env.ARCHON_WORK_ORDER_MODE = '1';
    const node: DagNode = { id: 'check', kind: 'exec', runtime: 'sh', script: 'true' };
    const env = buildNodeShellEnvironment(
      node,
      shellContext({ work_order_mode: 'false' }),
      { ARCHON_WORK_ORDER_MODE: '0', OTHER_VAR: 'kept' },
      baseExecContext
    );
    expect(env.ARCHON_WORK_ORDER_MODE).toBe('1');
    expect(env.INPUTS_WORK_ORDER_MODE).toBe('true');
    expect(env.OTHER_VAR).toBe('kept');
    const keys = JSON.parse(String(env.ARCHON_RUN_ENV_KEYS)) as string[];
    expect(keys).toContain('ARCHON_WORK_ORDER_MODE');
    expect(keys).toContain('INPUTS_WORK_ORDER_MODE');
  });

  it('emits ARCHON_WORK_ORDER_MODE=1 last in AI node env so repo config cannot clear it and containers inherit it', () => {
    process.env.ARCHON_WORK_ORDER_MODE = 'true';
    const repoEnvVars = { ARCHON_WORK_ORDER_MODE: '0', CUSTOM: 'value' };
    // Mirrors agent.ts / loop.ts where aiNodeEnvironment spreads after nodeOptions.env,
    // and container runs pass cliCommand = undefined.
    const mergedContainerEnv: Record<string, string> = {
      ...repoEnvVars,
      ...buildAiNodeEnvironment(executionIdentity, undefined),
    };
    expect(mergedContainerEnv.ARCHON_WORK_ORDER_MODE).toBe('1');
    expect(mergedContainerEnv.ARCHON_CLI_COMMAND).toBe('');
    expect(mergedContainerEnv.CUSTOM).toBe('value');
  });

  it('omits ARCHON_WORK_ORDER_MODE from exec and AI envs when inactive and fails closed when invalid', () => {
    delete process.env.ARCHON_WORK_ORDER_MODE;
    const execEnv = buildExecNodeEnvironment({ ...baseExecContext, inputEnvKeys: [] });
    expect(execEnv).not.toHaveProperty('ARCHON_WORK_ORDER_MODE');
    const aiEnv = buildAiNodeEnvironment(executionIdentity, undefined);
    expect(aiEnv).not.toHaveProperty('ARCHON_WORK_ORDER_MODE');

    process.env.ARCHON_WORK_ORDER_MODE = 'bogus';
    expect(() => buildExecNodeEnvironment({ ...baseExecContext, inputEnvKeys: [] })).toThrow(
      'ARCHON_WORK_ORDER_MODE must be'
    );
    expect(() => buildAiNodeEnvironment(executionIdentity, undefined)).toThrow(
      'ARCHON_WORK_ORDER_MODE must be'
    );
  });
});

describe('host ARCHON_WORK_ORDER_MODE forces work_order_mode workflow inputs to true', () => {
  it('forces work_order_mode to true in resolveRunInputs, inputEnvVars, and resolveNodeBindings', () => {
    process.env.ARCHON_WORK_ORDER_MODE = '1';
    const runInputs = resolveRunInputs({
      metadata: { inputs: { work_order_mode: 'false', target: 'x' } },
    });
    expect(runInputs).toEqual({ work_order_mode: 'true', target: 'x' });

    const bareInputs = resolveRunInputs({ metadata: {} });
    expect(bareInputs).toEqual({ work_order_mode: 'true' });

    const node: DagNode = {
      id: 'script-node',
      kind: 'exec',
      runtime: 'bun',
      script: 'console.log(1)',
      with: { work_order_mode: 'false' },
    };
    const env = inputEnvVars(node, shellContext({ work_order_mode: 'false' }));
    expect(env.INPUTS_WORK_ORDER_MODE).toBe('true');

    const bindings = resolveNodeBindings(
      'scope',
      { work_order_mode: 'false', other: 'ok' },
      shellContext({ work_order_mode: 'false' }),
      runInputs
    );
    expect(bindings).toEqual({ work_order_mode: 'true', other: 'ok' });
  });

  it('forces work_order_mode to true in resolveRunStartInputs even when caller omits or sets false', async () => {
    process.env.ARCHON_WORK_ORDER_MODE = '1';
    const workflow = {
      name: 'test-work-order',
      inputs: {
        work_order_mode: { default: 'false' },
        target: { default: '' },
      },
      nodes: [],
    } as unknown as ResolvedWorkflow;

    const fromDefault = await resolveRunStartInputs(process.cwd(), workflow, undefined);
    expect(fromDefault.inputs?.work_order_mode).toBe('true');

    const fromFalse = await resolveRunStartInputs(process.cwd(), workflow, {
      work_order_mode: 'false',
      target: 'pinned',
    });
    expect(fromFalse.inputs).toEqual({ work_order_mode: 'true', target: 'pinned' });
  });
});
