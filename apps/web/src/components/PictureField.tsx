import { useRef, useState, type ReactNode } from 'react';
import { describeError } from '../lib/http';
import { squareImage } from '../lib/square-image';
import { Avatar } from './Avatar';
import { Button } from './Button';

interface PictureFieldProps {
  /** What the picture represents, for labels: `sua foto`, `o ícone do servidor`. */
  subject: string;
  name: string;
  picture: string | null;
  /** Receives the picture already cut to size. */
  onChange: (image: Blob) => Promise<unknown>;
  /** Cuts the chosen file to size; a small square unless told otherwise. */
  prepare?: (file: Blob) => Promise<Blob>;
  /** Shown instead of the square thumbnail. */
  preview?: ReactNode;
  hint?: string;
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
  prepare = squareImage,
  preview,
  hint = 'Qualquer imagem serve: ela é cortada no centro, em quadrado, antes de ser enviada.',
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
        {preview ?? (
          <Avatar name={name} picture={picture} size={64} className="border border-line-strong" />
        )}
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
              if (file) void run(async () => onChange(await prepare(file)));
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
      <p className="text-xs text-muted">{hint}</p>
      {error && (
        <p role="alert" className="label text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
