import { IMAGE_CONTENT_TYPES, type Attachment } from '@frequencia/shared';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { toast } from '../../components/Toast';
import { chatApi } from './chat-store';

const MAX_WIDTH = 400;
const MAX_HEIGHT = 300;
const ATTACHMENT_KEY = 'attachment';

/**
 * Object URL of an attachment. Images are downloaded with the access token (which an `<img>`
 * cannot send) and kept in the query cache for as long as something shows them.
 */
function useAttachmentUrl(id: string) {
  return useQuery({
    queryKey: [ATTACHMENT_KEY, id],
    queryFn: async () => URL.createObjectURL(await chatApi.attachmentBlob(id)),
    // The bytes behind an id never change.
    staleTime: Infinity,
    retry: 0,
  });
}

/** Frees the object URL of an attachment once its cache entry is collected. */
export function releaseAttachmentUrls(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'removed' || event.query.queryKey[0] !== ATTACHMENT_KEY) return;
    const url: unknown = event.query.state.data;
    if (typeof url === 'string') URL.revokeObjectURL(url);
  });
}

/** Size on screen: the image's own proportions, fitted into the maximum box. */
function fit(attachment: Attachment): { width: number; height: number } {
  const { width, height } = attachment;
  if (!width || !height) return { width: MAX_WIDTH, height: MAX_HEIGHT };
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function AttachmentImage({ attachment }: { attachment: Attachment }) {
  const { data: url, isError } = useAttachmentUrl(attachment.id);
  const [open, setOpen] = useState(false);
  const size = fit(attachment);

  return (
    <>
      <button
        type="button"
        data-testid="attachment"
        aria-label={`Ampliar ${attachment.filename}`}
        disabled={!url}
        onClick={() => setOpen(true)}
        // The box is reserved before the image arrives, so the history does not jump.
        style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}
        className="flex max-w-full items-center justify-center overflow-hidden border border-line bg-surface transition-colors enabled:hover:border-accent"
      >
        {url ? (
          <img
            src={url}
            alt={attachment.filename}
            className="h-full w-full object-contain"
            draggable={false}
          />
        ) : (
          <span className={isError ? 'label text-danger' : 'label text-muted'}>
            {isError ? 'IMAGEM INDISPONÍVEL' : 'CARREGANDO'}
          </span>
        )}
      </button>
      {open && url && (
        <Dialog title={attachment.filename} eyebrow="IMAGEM" wide onClose={() => setOpen(false)}>
          <div className="flex flex-col items-center gap-3 p-4">
            <img
              src={url}
              alt={attachment.filename}
              className="max-h-[70dvh] max-w-full object-contain"
            />
            <a
              href={url}
              download={attachment.filename}
              className="label text-muted transition-colors hover:text-accent"
            >
              [ BAIXAR ]
            </a>
          </div>
        </Dialog>
      )}
    </>
  );
}

export const isImageAttachment = (attachment: Attachment) =>
  (IMAGE_CONTENT_TYPES as readonly string[]).includes(attachment.contentType);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file that is not a picture: its name, its size and the way to save it. */
function AttachmentFile({ attachment }: { attachment: Attachment }) {
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      // The download needs the access token, which a plain link cannot send.
      const url = URL.createObjectURL(await chatApi.attachmentBlob(attachment.id));
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast('NÃO FOI POSSÍVEL BAIXAR O ARQUIVO.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="attachment-file"
      className="flex max-w-sm items-center gap-3 border border-line-strong bg-surface px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg" title={attachment.filename}>
          {attachment.filename}
        </p>
        <p className="label text-muted">{formatBytes(attachment.size)}</p>
      </div>
      <button
        type="button"
        disabled={busy}
        aria-label={`Baixar ${attachment.filename}`}
        onClick={() => void save()}
        className="label shrink-0 text-muted transition-colors hover:text-accent disabled:opacity-40"
      >
        {busy ? '[ BAIXANDO ]' : '[ BAIXAR ]'}
      </button>
    </div>
  );
}

/** Files of a message, in the order they were attached: pictures are shown, the rest listed. */
export function Attachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 py-1">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="max-w-full">
          {isImageAttachment(attachment) ? (
            <AttachmentImage attachment={attachment} />
          ) : (
            <AttachmentFile attachment={attachment} />
          )}
        </li>
      ))}
    </ul>
  );
}
