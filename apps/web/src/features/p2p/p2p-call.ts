import {
  API_PREFIX,
  P2P_SIGNALING_PATH,
  P2pErrorCode,
  p2pClientSide,
  p2pServerSide,
  RpcError,
  type P2pPeer,
  type P2pSignalPayload,
} from '@frequencia/shared';
import { create } from 'zustand';
import { connectRpc, type RpcConnection } from '../../lib/rpc-client';

export type P2pStatus = 'idle' | 'acquiring' | 'connecting' | 'waiting' | 'in-call' | 'error';

export interface P2pStats {
  rttMs: number | null;
  sendKbps: number | null;
  receiveKbps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

interface P2pState {
  status: P2pStatus;
  error: string | null;
  self: P2pPeer | null;
  remote: P2pPeer | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  hasCamera: boolean;
  iceState: RTCIceConnectionState | null;
  stats: P2pStats;
}

const emptyStats: P2pStats = {
  rttMs: null,
  sendKbps: null,
  receiveKbps: null,
  videoCodec: null,
  audioCodec: null,
};

const initialState: P2pState = {
  status: 'idle',
  error: null,
  self: null,
  remote: null,
  localStream: null,
  remoteStream: null,
  micEnabled: true,
  cameraEnabled: true,
  hasCamera: true,
  iceState: null,
  stats: emptyStats,
};

export const useP2pStore = create<P2pState>(() => initialState);
const set = useP2pStore.setState;

type Connection = RpcConnection<typeof p2pClientSide, typeof p2pServerSide>;

// Live objects are kept out of the store: they are not serializable render state.
let connection: Connection | null = null;
let pc: RTCPeerConnection | null = null;
let iceServers: RTCIceServer[] = [];
let statsTimer: number | null = null;

// The peer that was already in the room always offers; the newcomer only answers. A single
// offerer rules out glare, and ICE restarts are renegotiated by that same side.
let initiator = false;

async function acquireLocalMedia(): Promise<MediaStream> {
  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (error) {
    // No camera (or camera denied): fall back to an audio-only call.
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    console.warn('[p2p] camera unavailable, continuing with audio only', error);
    return stream;
  }
}

function describeError(error: unknown): string {
  if (error instanceof RpcError) {
    if (error.code === P2pErrorCode.RoomFull) return 'Esta sala já tem duas pessoas.';
    return `Erro de sinalização (${error.code}).`;
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Permissão de microfone/câmera negada.';
    if (error.name === 'NotFoundError') return 'Nenhum microfone encontrado.';
  }
  return 'Não foi possível conectar ao servidor de sinalização.';
}

function sendSignal(to: string, payload: P2pSignalPayload): void {
  connection?.rpc.notify('signal', { to, payload });
}

function closePeerConnection(): void {
  if (statsTimer !== null) window.clearInterval(statsTimer);
  statsTimer = null;
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onnegotiationneeded = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
  }
  pc = null;
  set({ remoteStream: null, iceState: null, stats: emptyStats });
}

function createPeerConnection(remote: P2pPeer, isInitiator: boolean): void {
  closePeerConnection();
  initiator = isInitiator;
  const peerConnection = new RTCPeerConnection({ iceServers });
  pc = peerConnection;
  set({ remote, status: 'in-call' });

  const { localStream } = useP2pStore.getState();
  for (const track of localStream?.getTracks() ?? []) {
    peerConnection.addTrack(track, localStream as MediaStream);
  }

  const remoteStream = new MediaStream();
  peerConnection.ontrack = ({ track }) => {
    remoteStream.addTrack(track);
    // A new MediaStream identity makes React re-attach it to the <video> element.
    set({ remoteStream: new MediaStream(remoteStream.getTracks()) });
  };

  peerConnection.onicecandidate = ({ candidate }) => {
    sendSignal(remote.id, {
      type: 'candidate',
      candidate: candidate
        ? {
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment,
          }
        : null,
    });
  };

  peerConnection.onnegotiationneeded = async () => {
    if (!initiator) return;
    try {
      await peerConnection.setLocalDescription();
      const description = peerConnection.localDescription;
      if (description) {
        sendSignal(remote.id, {
          type: 'description',
          description: { type: description.type, sdp: description.sdp },
        });
      }
    } catch (error) {
      console.error('[p2p] negotiation failed', error);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    set({ iceState: peerConnection.iceConnectionState });
    if (peerConnection.iceConnectionState === 'failed') peerConnection.restartIce();
  };

  startStats(peerConnection);
}

async function handleSignal(from: string, payload: P2pSignalPayload): Promise<void> {
  const peerConnection = pc;
  if (!peerConnection || useP2pStore.getState().remote?.id !== from) return;

  try {
    if (payload.type === 'candidate') {
      await peerConnection.addIceCandidate(payload.candidate ?? undefined);
      return;
    }

    const description = payload.description as RTCSessionDescriptionInit;
    if (description.type === 'offer' && initiator) return;
    await peerConnection.setRemoteDescription(description);
    if (description.type === 'offer') {
      await peerConnection.setLocalDescription();
      const answer = peerConnection.localDescription;
      if (answer) {
        sendSignal(from, {
          type: 'description',
          description: { type: answer.type, sdp: answer.sdp },
        });
      }
    }
  } catch (error) {
    console.error('[p2p] failed to apply remote signal', error);
  }
}

function startStats(peerConnection: RTCPeerConnection): void {
  let lastSent = 0;
  let lastReceived = 0;
  let lastAt = performance.now();

  statsTimer = window.setInterval(async () => {
    if (peerConnection.connectionState === 'closed') return;
    const report = await peerConnection.getStats();
    let sent = 0;
    let received = 0;
    let rttMs: number | null = null;
    let videoCodecId: string | undefined;
    let audioCodecId: string | undefined;

    report.forEach((entry: Record<string, unknown> & { type: string }) => {
      if (entry.type === 'outbound-rtp') {
        sent += (entry.bytesSent as number | undefined) ?? 0;
        if (entry.kind === 'video') videoCodecId = entry.codecId as string | undefined;
        if (entry.kind === 'audio') audioCodecId = entry.codecId as string | undefined;
      } else if (entry.type === 'inbound-rtp') {
        received += (entry.bytesReceived as number | undefined) ?? 0;
      } else if (
        entry.type === 'candidate-pair' &&
        entry.nominated === true &&
        typeof entry.currentRoundTripTime === 'number'
      ) {
        rttMs = Math.round(entry.currentRoundTripTime * 1000);
      }
    });

    const codecName = (id: string | undefined): string | null => {
      const codec = id ? (report.get(id) as { mimeType?: string } | undefined) : undefined;
      return codec?.mimeType?.split('/')[1] ?? null;
    };

    const now = performance.now();
    const seconds = (now - lastAt) / 1000;
    const kbps = (bytes: number, previous: number) =>
      previous === 0 ? null : Math.max(0, Math.round(((bytes - previous) * 8) / seconds / 1000));

    set({
      stats: {
        rttMs,
        sendKbps: kbps(sent, lastSent),
        receiveKbps: kbps(received, lastReceived),
        videoCodec: codecName(videoCodecId),
        audioCodec: codecName(audioCodecId),
      },
    });
    lastSent = sent;
    lastReceived = received;
    lastAt = now;
  }, 1000);
}

function teardown(next: Partial<P2pState> = {}): void {
  closePeerConnection();
  connection?.close();
  connection = null;
  for (const track of useP2pStore.getState().localStream?.getTracks() ?? []) track.stop();
  set({ ...initialState, ...next });
}

export async function joinP2pRoom(room: string, nickname: string): Promise<void> {
  if (useP2pStore.getState().status !== 'idle' && useP2pStore.getState().status !== 'error') return;
  set({ ...initialState, status: 'acquiring' });

  try {
    const localStream = await acquireLocalMedia();
    const hasCamera = localStream.getVideoTracks().length > 0;
    set({ localStream, hasCamera, cameraEnabled: hasCamera, status: 'connecting' });

    connection = await connectRpc({
      path: `${API_PREFIX}${P2P_SIGNALING_PATH}`,
      local: p2pClientSide,
      remote: p2pServerSide,
      onClose: () => teardown({ status: 'error', error: 'A conexão com o servidor caiu.' }),
    });
    const { rpc } = connection;

    rpc.on('peer-joined', ({ peer }) => createPeerConnection(peer, true));
    rpc.on('peer-left', ({ peerId }) => {
      if (useP2pStore.getState().remote?.id !== peerId) return;
      closePeerConnection();
      set({ remote: null, status: 'waiting' });
    });
    rpc.on('signal', ({ from, payload }) => void handleSignal(from, payload));

    const joined = await rpc.request('join', { room, nickname });
    iceServers = joined.iceServers;
    set({ self: joined.self, status: 'waiting' });

    const [existing] = joined.peers;
    if (existing) createPeerConnection(existing, false);
  } catch (error) {
    teardown({ status: 'error', error: describeError(error) });
  }
}

export function leaveP2pRoom(): void {
  teardown();
}

export function toggleP2pMic(): void {
  const { localStream, micEnabled } = useP2pStore.getState();
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !micEnabled;
  set({ micEnabled: !micEnabled });
}

export function toggleP2pCamera(): void {
  const { localStream, cameraEnabled, hasCamera } = useP2pStore.getState();
  if (!hasCamera) return;
  for (const track of localStream?.getVideoTracks() ?? []) track.enabled = !cameraEnabled;
  set({ cameraEnabled: !cameraEnabled });
}
