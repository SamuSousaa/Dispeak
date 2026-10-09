import { useEffect, useState } from 'react';
import { LabJoinForm } from '../components/LabJoinForm';
import { LabLayout } from '../components/LabLayout';
import { VoiceControls } from '../features/voice/components/VoiceControls';
import { VoiceStage } from '../features/voice/components/VoiceStage';
import { VoiceSystemBar } from '../features/voice/components/VoiceSystemBar';
import { useVoiceShortcuts } from '../features/voice/use-voice-shortcuts';
import { joinVoice, leaveVoice } from '../features/voice/voice-actions';
import { useVoiceStore } from '../features/voice/voice-store';
import { fetchLabVoiceToken } from '../lib/lab-api';

export function LabVoicePage() {
  const status = useVoiceStore((state) => state.status);
  const error = useVoiceStore((state) => state.error);
  const channelName = useVoiceStore((state) => state.channelName);
  const [nickname, setNickname] = useState('');

  useVoiceShortcuts();
  useEffect(() => leaveVoice, []);

  const inChannel = status === 'connected' || status === 'reconnecting';

  const join = (channel: string, name: string) => {
    setNickname(name);
    void joinVoice({
      channelId: channel,
      channelName: channel,
      getToken: () => fetchLabVoiceToken({ nickname: name, channel }),
    });
  };

  return (
    <LabLayout
      code="LAB.02"
      title={inChannel && channelName ? `VOZ / ${channelName}` : 'VOZ (SFU)'}
      footer={status !== 'idle' && status !== 'error' ? <VoiceSystemBar /> : undefined}
    >
      {!inChannel ? (
        <LabJoinForm
          title="CANAL DE VOZ"
          description="Áudio roteado pelo servidor de mídia (SFU). Abra o mesmo canal em várias abas ou dispositivos."
          roomLabel="CANAL"
          roomParam="canal"
          busy={status === 'connecting'}
          error={error}
          onJoin={join}
        />
      ) : (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            <VoiceStage selfName={nickname} />
          </div>
          <div className="shrink-0 border-t border-line bg-surface p-3">
            <VoiceControls />
          </div>
        </div>
      )}
    </LabLayout>
  );
}
