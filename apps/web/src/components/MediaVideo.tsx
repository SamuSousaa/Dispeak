import { useEffect, useRef, type VideoHTMLAttributes } from 'react';

interface MediaVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src'> {
  stream: MediaStream | null;
}

/** <video> bound to a MediaStream. */
export function MediaVideo({ stream, ...props }: MediaVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) {
      // Autoplay can be rejected until the user interacts with the page.
      element.play().catch(() => undefined);
    }
  }, [stream]);

  return <video ref={ref} autoPlay playsInline {...props} />;
}
