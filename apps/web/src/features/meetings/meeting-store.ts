import {
  API_PREFIX,
  meetingRoom,
  meetingServerFrameSchema,
  meetingSocketPath,
  type MeetingPreview,
  type MeetingState,
} from '@frequencia/shared';
import { create } from 'zustand';
import { ApiError, describeError } from '../../lib/http';
import { wsUrl } from '../../lib/api';
import { toast } from '../../components/Toast';
import { playSound } from '../sounds/sound-player';
import { joinVoice, leaveVoice } from '../voice/voice-actions';
import { VoiceAccessError } from '../voice/voice-session';
import { meetingApi } from './meeting-api';

/**
 * Where the person stands with the meeting:
 * - `loading`: finding out whether it exists;
 * - `missing`: it ended, or never was;
 * - `outside`: it exists; they may ask to come in;
 * - `waiting`: at the door, until someone inside answers;
 * - `denied`: turned away;
 * - `inside`: let in, in the call;
 * - `left`: let in, but they left the call (and may go back without asking again);
 * - `removed`: taken out by the host.
 */
export type MeetingPhase =
  'loading' | 'missing' | 'outside' | 'waiting' | 'denied' | 'inside' | 'left' | 'removed';

interface MeetingStore {
  phase: MeetingPhase;
  meetingId: string | null;
  preview: MeetingPreview | null;
  /** What people inside see; filled by the meeting socket. */
  meeting: MeetingState | null;
  /** Something the person tried that did not work. */
  error: string | null;
  busy: boolean;
}

export const useMeetingStore = create<MeetingStore>(() => ({
  phase: 'loading',
  meetingId: null,
  preview: null,
  meeting: null,
  error: null,
  busy: false,
}));

const set = useMeetingStore.setState;
const get = useMeetingStore.getState;

/** The key lives in the tab: a reload goes straight back in, another tab asks again. */
const storageKey = (meetingId: string) => `frequencia:meeting:${meetingId}`;
function storedKey(meetingId: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(meetingId));
  } catch {
    return null;
  }
}
function storeKey(meetingId: string, key: string | null): void {
  try {
    if (key) sessionStorage.setItem(storageKey(meetingId), key);
    else sessionStorage.removeItem(storageKey(meetingId));
  } catch {
    // Without storage a reload just asks to come in again.
  }
}

const RECONNECT_MS = 1500;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** The key of the person inside, for the requests they make. */
let key: string | null = null;

function closeSocket(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  socket = null;
}

/**
 * Opens the meeting's socket, inside (`key`) or at the door (`requestKey`). Inside, a dropped
 * socket comes back on its own; at the door, losing it means losing the place in the queue.
 */
function connect(meetingId: string, hello: { key: string } | { requestKey: string }): void {
  closeSocket();
  const next = new WebSocket(wsUrl(`${API_PREFIX}${meetingSocketPath(meetingId)}`));
  socket = next;
  next.onopen = () => next.send(JSON.stringify({ t: 'hello', ...hello }));
  next.onmessage = (event) => {
    const parsed = meetingServerFrameSchema.safeParse(JSON.parse(String(event.data)));
    if (!parsed.success) return;
    const frame = parsed.data;
    switch (frame.t) {
      case 'state': {
        const mutedOf = (state: MeetingState | null) =>
          state?.participants.find((p) => p.id === state.selfId)?.mutedByHost ?? false;
        const before = get().meeting;
        if (before) announceKnocks(before, frame.d);
        if (before && mutedOf(before) !== mutedOf(frame.d)) {
          toast(
            mutedOf(frame.d)
              ? 'O anfitrião desligou o seu microfone.'
              : 'O anfitrião devolveu o seu microfone.',
            'info',
          );
        }
        set({ meeting: frame.d });
        return;
      }
      case 'message': {
        const { meeting } = get();
        if (meeting && !meeting.messages.some((m) => m.id === frame.d.id)) {
          set({ meeting: { ...meeting, messages: [...meeting.messages, frame.d] } });
        }
        return;
      }
      case 'admitted':
        void enter(meetingId, frame.d.key);
        return;
      case 'denied':
        closeSocket();
        set({ phase: 'denied' });
        return;
      case 'ended':
        if (frame.d.reason === 'gone' && 'key' in hello) {
          // The key no longer opens it: over, or the person was never in it.
          storeKey(meetingId, null);
          void openMeeting(meetingId);
          return;
        }
        finish(meetingId, frame.d.reason === 'removed' ? 'removed' : 'missing');
        return;
    }
  };
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    if ('key' in hello) {
      reconnectTimer = setTimeout(() => connect(meetingId, hello), RECONNECT_MS);
    } else if (get().phase === 'waiting') {
      set({ phase: 'outside', error: 'A conexão caiu. Peça para entrar de novo.' });
    }
  };
}

/**
 * Someone new at the door: everyone inside hears it and sees it, and gets a system
 * notification when the page is not in view, so nobody is left waiting unseen.
 */
function announceKnocks(before: MeetingState, after: MeetingState): void {
  const seen = new Set(before.waiting.map((knock) => knock.id));
  const fresh = after.waiting.filter((knock) => !seen.has(knock.id));
  if (fresh.length === 0) return;
  const text =
    fresh.length === 1
      ? `${fresh[0]?.name ?? 'Alguém'} está pedindo para entrar.`
      : `${fresh.length} pessoas estão pedindo para entrar.`;
  toast(text, 'info');
  void playSound('join');
  if (
    document.visibilityState === 'visible' ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }
  try {
    const notification = new Notification('Reunião', { body: text, tag: fresh[0]?.id });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some mobile browsers expose the API but only let a service worker use it.
  }
}

/** The meeting is over (or over for this person): everything of it goes. */
function finish(meetingId: string, phase: 'missing' | 'removed' = 'missing'): void {
  closeSocket();
  key = null;
  storeKey(meetingId, null);
  leaveVoice();
  set({ phase, meeting: null, busy: false });
}

/** In the meeting with a key: its socket, and its call. */
async function enter(meetingId: string, given: string): Promise<void> {
  key = given;
  storeKey(meetingId, given);
  set({ phase: 'inside', error: null, busy: false });
  connect(meetingId, { key: given });
  await joinCall();
}

function joinCall(): Promise<void> {
  const { meetingId } = get();
  if (!meetingId || !key) return Promise.resolve();
  const current = key;
  return joinVoice({
    channelId: meetingRoom(meetingId),
    channelName: 'REUNIÃO',
    getToken: async () => {
      try {
        return await meetingApi.voiceToken(meetingId, current);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          throw new VoiceAccessError('A reunião acabou.');
        }
        if (error instanceof ApiError && error.status === 403) {
          throw new VoiceAccessError('Você não está nesta reunião.');
        }
        throw error;
      }
    },
  });
}

/** Opens a meeting's page: back inside with a kept key, or at its door. */
export async function openMeeting(meetingId: string): Promise<void> {
  closeSocket();
  key = null;
  set({ phase: 'loading', meetingId, preview: null, meeting: null, error: null, busy: false });
  try {
    const preview = await meetingApi.preview(meetingId);
    if (get().meetingId !== meetingId) return;
    set({ preview });
  } catch (error) {
    if (get().meetingId !== meetingId) return;
    if (error instanceof ApiError && error.status === 404) {
      storeKey(meetingId, null);
      set({ phase: 'missing' });
    } else {
      set({ phase: 'outside', error: describeError(error) });
    }
    return;
  }
  const kept = storedKey(meetingId);
  if (kept) await enter(meetingId, kept);
  else set({ phase: 'outside' });
}

/** The host of a new meeting goes straight in. */
export async function startMeeting(): Promise<string> {
  const created = await meetingApi.create();
  storeKey(created.id, created.key);
  return created.id;
}

/** Asks to come in; a guest gives a name, a signed-in user goes by theirs. */
export async function knock(name: string | undefined): Promise<void> {
  const { meetingId } = get();
  if (!meetingId) return;
  set({ busy: true, error: null });
  try {
    const answer = await meetingApi.knock(meetingId, name);
    if (answer.status === 'admitted') {
      await enter(meetingId, answer.key);
      return;
    }
    set({ phase: 'waiting', busy: false });
    connect(meetingId, { requestKey: answer.requestKey });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      set({ phase: 'missing', busy: false });
      return;
    }
    set({
      busy: false,
      error:
        error instanceof ApiError && error.status === 409
          ? 'Muita gente esperando para entrar. Tente daqui a pouco.'
          : describeError(error),
    });
  }
}

/** Stops waiting at the door. */
export function cancelKnock(): void {
  closeSocket();
  set({ phase: 'outside' });
}

/** Leaves the call, keeping the key to go back without asking. */
export function leaveCall(): void {
  leaveVoice();
  set({ phase: 'left' });
}

export function rejoinCall(): void {
  set({ phase: 'inside', error: null });
  void joinCall();
}

/** Leaves the page: the socket and the call go, the key stays for a reload. */
export function closeMeeting(): void {
  closeSocket();
  leaveVoice();
  key = null;
  set({ phase: 'loading', meetingId: null, preview: null, meeting: null, error: null });
}

async function asInside(action: (meetingId: string, key: string) => Promise<unknown>) {
  const { meetingId } = get();
  if (!meetingId || !key) return;
  try {
    set({ error: null });
    await action(meetingId, key);
  } catch (error) {
    set({
      error:
        error instanceof ApiError && error.status === 409
          ? 'A reunião está cheia.'
          : describeError(error),
    });
  }
}

export const admit = (requestId: string) => asInside((id, k) => meetingApi.admit(id, k, requestId));
export const deny = (requestId: string) => asInside((id, k) => meetingApi.deny(id, k, requestId));
/** The host mutes someone for everyone, or gives their microphone back. */
export const muteForEveryone = (participantId: string, muted: boolean) =>
  asInside((id, k) => meetingApi.mute(id, k, participantId, muted));
/** The host takes someone out of the meeting. */
export const removeParticipant = (participantId: string) =>
  asInside((id, k) => meetingApi.remove(id, k, participantId));
export const say = (content: string) => asInside((id, k) => meetingApi.say(id, k, content));

/** Ends the meeting for everyone (host only). */
export async function endMeeting(): Promise<void> {
  const { meetingId } = get();
  await asInside((id, k) => meetingApi.end(id, k));
  if (meetingId && !get().error) finish(meetingId);
}
