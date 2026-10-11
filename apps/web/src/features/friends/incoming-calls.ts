/** How long a call rings before it is left as a missed one. */
export const RING_TIMEOUT_MS = 45_000;

export interface CallState {
  /** Conversations (guild ids) in which the friend is in the call right now. */
  friendIn: ReadonlySet<string>;
  /** Conversations in which the user is in the call too. */
  selfIn: ReadonlySet<string>;
}

/**
 * Which conversations are ringing after a change of state. A call rings when the friend enters
 * it while the user is out: the edge, not the level. Hanging up on a friend who stays, or
 * refusing, therefore does not ring again; the friend leaving ends the ring and arms the next.
 */
export function nextRinging(
  ringing: ReadonlySet<string>,
  previous: CallState,
  next: CallState,
): Set<string> {
  const result = new Set<string>();
  for (const id of next.friendIn) {
    if (next.selfIn.has(id)) continue;
    const started = !previous.friendIn.has(id);
    if (started || ringing.has(id)) result.add(id);
  }
  return result;
}
