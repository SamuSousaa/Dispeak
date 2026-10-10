import { useRef, useState } from 'react';
import { describeError } from '../lib/http';
import { squareImage } from '../lib/square-image';
import { Avatar } from './Avatar';
import { Button } from './Button';

interface PictureFieldProps {
  /** What the picture represents, for labels: `sua foto`, `o ícone do servidor`. */
  subject: string;
  name: string;
  picture: string | null;
  /** Receives the picture already cut to a small square. */
  onChange: (image: Blob) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  testId: string;
}

/** Current picture with the buttons to pick another one from the computer or remove it. */
export function PictureField({
  subject,
  name,
  picture,
  onChange,
  onRemove,
  testId,
}: PictureFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message === 'not an image'
          ? 'ESSE ARQUIVO NÃO É UMA IMAGEM QUE O NAVEGADOR CONSIGA ABRIR.'
          : describeError(failure, 'Não foi possível salvar a imagem.').toUpperCase(),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Avatar name={name} picture={picture} size={64} className="border border-line-strong" />
        <div className="flex flex-wrap gap-1.5">
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            data-testid={testId}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void run(async () => onChange(await squareImage(file)));
            }}
          />
          <Button
            disabled={busy}
            aria-label={`Escolher imagem para ${subject}`}
            onClick={() => input.current?.click()}
          >
            {busy ? 'ENVIANDO' : 'ESCOLHER IMAGEM'}
          </Button>
          {picture && (
            <Button
              variant="danger"
              disabled={busy}
              aria-label={`Remover ${subject}`}
              onClick={() => void run(onRemove)}
            >
              REMOVER
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted">
        Qualquer imagem serve: ela é cortada no centro, em quadrado, antes de ser enviada.
      </p>
      {error && (
        <p role="alert" className="label text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
