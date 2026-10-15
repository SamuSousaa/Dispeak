import type { LinkPreview } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccountSettings } from '../settings/account-settings';
import { chatApi } from './chat-store';

/** Links of one message that get a preview; the rest stay plain links. */
const MAX_EMBEDS = 3;
const HOUR_MS = 60 * 60 * 1000;

const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;

/** A link that, by its looks, is the picture itself (a GIF from the picker, a pasted image URL). */
export function isImageLink(href: string): boolean {
  try {
    return IMAGE_PATH.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

/** Optional features of the server, asked once. */
export function useFeatures() {
  return useQuery({
    queryKey: ['features'],
    queryFn: chatApi.features,
    staleTime: Infinity,
    retry: 1,
  }).data;
}

/**
 * A picture hosted somewhere else. The box has a fixed height so the history does not jump
 * when it loads; a picture that fails to load takes its box with it.
 */
function RemoteImage({ src, href, alt }: { src: string; href: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="embed-image"
      className="block h-48 max-w-full self-start border border-line bg-surface transition-colors hover:border-accent"
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        // The host of the picture learns nothing about where it is being shown.
        referrerPolicy="no-referrer"
        draggable={false}
        onError={() => setBroken(true)}
        className="h-full max-w-full object-contain"
      />
    </a>
  );
}

function PageCard({ preview }: { preview: LinkPreview }) {
  return (
    <div
      data-testid="embed-card"
      className="flex max-w-md flex-col gap-1.5 border border-l-2 border-line border-l-line-strong bg-surface p-2.5"
    >
      {preview.siteName && <p className="label truncate text-muted">{preview.siteName}</p>}
      {preview.title && (
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="line-clamp-2 text-sm font-medium text-fg underline-offset-2 transition-colors hover:text-accent hover:underline"
        >
          {preview.title}
        </a>
      )}
      {preview.description && (
        <p className="line-clamp-3 text-xs text-muted">{preview.description}</p>
      )}
      {preview.image && <RemoteImage src={preview.image} href={preview.url} alt="" />}
    </div>
  );
}

function Embed({ href, canAsk }: { href: string; canAsk: boolean }) {
  const direct = isImageLink(href);
  const { data: preview } = useQuery({
    queryKey: ['unfurl', href],
    queryFn: () => chatApi.unfurl(href),
    enabled: canAsk && !direct,
    staleTime: HOUR_MS,
    gcTime: HOUR_MS,
    retry: 0,
  });

  if (direct) return <RemoteImage src={href} href={href} alt="Imagem do link" />;
  if (!preview) return null;
  if (preview.kind === 'image' && preview.image) {
    return <RemoteImage src={preview.image} href={href} alt="Imagem do link" />;
  }
  return <PageCard preview={preview} />;
}

/** Pictures and previews of the links of a message. */
export function Embeds({ links }: { links: string[] }) {
  const show = useAccountSettings((settings) => settings.showEmbeds);
  const features = useFeatures();
  const unique = [...new Set(links)].slice(0, MAX_EMBEDS);
  if (!show || unique.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 py-1">
      {unique.map((href) => (
        <Embed key={href} href={href} canAsk={features?.linkPreviews ?? false} />
      ))}
    </div>
  );
}
