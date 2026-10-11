import { describe, expect, it } from 'vitest';
import { nextRinging, type CallState } from './incoming-calls';

const state = (friendIn: string[], selfIn: string[] = []): CallState => ({
  friendIn: new Set(friendIn),
  selfIn: new Set(selfIn),
});
const none = new Set<string>();

describe('nextRinging', () => {
  it('rings when the friend starts a call', () => {
    expect([...nextRinging(none, state([]), state(['a']))]).toEqual(['a']);
  });

  it('keeps ringing while nothing changes, and stops when the friend gives up', () => {
    const ringing = new Set(['a']);
    expect([...nextRinging(ringing, state(['a']), state(['a']))]).toEqual(['a']);
    expect([...nextRinging(ringing, state(['a']), state([]))]).toEqual([]);
  });

  it('stops when the user answers', () => {
    expect([...nextRinging(new Set(['a']), state(['a']), state(['a'], ['a']))]).toEqual([]);
  });

  it('does not ring a call the user started or has just left', () => {
    // The user called first; the friend joins.
    expect([...nextRinging(none, state([], ['a']), state(['a'], ['a']))]).toEqual([]);
    // The user hangs up and the friend stays.
    expect([...nextRinging(none, state(['a'], ['a']), state(['a']))]).toEqual([]);
  });

  it('does not ring again after being refused, until the next call', () => {
    expect([...nextRinging(none, state(['a']), state(['a']))]).toEqual([]);
    expect([...nextRinging(none, state([]), state(['a']))]).toEqual(['a']);
  });
});
