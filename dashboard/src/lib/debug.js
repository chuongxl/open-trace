export const STATE_LABEL = {
  running: 'running',
  pausing: 'pausing at next request',
  paused: 'paused',
  stopping: 'stopping at next step',
}

/** Which controls make sense in each state. */
export function availableActions(state, heldCount) {
  return {
    pause: state === 'running',
    step: state === 'paused' && heldCount > 0,
    continue: state !== 'running', // also cancels an armed stop
    stop: state !== 'stopping',
  }
}
