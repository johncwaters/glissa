const SUPERVISED_RESTART_EXIT_CODE = 75;

function decideRestartStrategy(env: Record<string, string | undefined> | null | undefined): 'respawn' | 'exit-for-supervisor' {
  const invocationId = env ? env.INVOCATION_ID : undefined;

  if (typeof invocationId === 'string' && invocationId !== '') return 'exit-for-supervisor';
  return 'respawn';
}

export { decideRestartStrategy, SUPERVISED_RESTART_EXIT_CODE };
