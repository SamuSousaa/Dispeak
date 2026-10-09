import { nicknameSchema } from '@frequencia/shared';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from './Button';

const ROOM_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const NICKNAME_KEY = 'lab.nickname';

interface LabJoinFormProps {
  title: string;
  description: string;
  /** Label of the room field, e.g. "SALA" or "CANAL". */
  roomLabel: string;
  /** Query-string key that carries the room, so a link can be shared. */
  roomParam: string;
  busy: boolean;
  error: string | null;
  onJoin: (room: string, nickname: string) => void;
}

/** Nickname + room form used by the lab routes, which have no accounts. */
export function LabJoinForm({
  title,
  description,
  roomLabel,
  roomParam,
  busy,
  error,
  onJoin,
}: LabJoinFormProps) {
  const [params, setParams] = useSearchParams();
  const [room, setRoom] = useState(params.get(roomParam) ?? '');
  const [nickname, setNickname] = useState(() => localStorage.getItem(NICKNAME_KEY) ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedNickname = nicknameSchema.safeParse(nickname);
    const trimmedRoom = room.trim();
    if (!parsedNickname.success) {
      setFormError('Apelido: 2 a 24 caracteres (letras, números, espaço, _ . -).');
      return;
    }
    if (!ROOM_PATTERN.test(trimmedRoom)) {
      setFormError(`${roomLabel}: até 32 caracteres, apenas letras, números, _ e -.`);
      return;
    }
    setFormError(null);
    localStorage.setItem(NICKNAME_KEY, parsedNickname.data);
    setParams({ [roomParam]: trimmedRoom }, { replace: true });
    onJoin(trimmedRoom, parsedNickname.data);
  };

  const message = formError ?? error;

  return (
    <div className="grid-bg flex h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm border border-line bg-surface" noValidate>
        <div className="border-b border-line px-4 py-4">
          <p className="label text-muted">{title}</p>
          <p className="mt-1 text-sm text-muted">{description}</p>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted">APELIDO</span>
            <input
              className="field"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              autoComplete="nickname"
              maxLength={24}
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted">{roomLabel}</span>
            <input
              className="field"
              value={room}
              onChange={(event) => setRoom(event.target.value)}
              placeholder="ex.: geral"
              maxLength={32}
              autoCapitalize="none"
              required
            />
          </label>
          {message && (
            <p role="alert" className="label text-danger">
              {message}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'CONECTANDO' : 'ENTRAR'}
          </Button>
        </div>
      </form>
    </div>
  );
}
