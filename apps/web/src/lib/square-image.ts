import { PICTURE_MAX_BYTES, PICTURE_SIZE } from '@frequencia/shared';

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not an image'));
    };
    image.src = url;
  });
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Turns any image the browser can open into the small square the server expects: the centre
 * of the picture, scaled to `PICTURE_SIZE`. Whatever the original weighed, the result is a few
 * dozen kilobytes. Animated images become their first frame.
 */
export async function squareImage(file: Blob): Promise<Blob> {
  const image = await load(file);
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  if (side === 0) throw new Error('empty image');

  const canvas = document.createElement('canvas');
  canvas.width = PICTURE_SIZE;
  canvas.height = PICTURE_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    PICTURE_SIZE,
    PICTURE_SIZE,
  );

  // WebP where the browser can write it (it falls back to PNG by itself), JPEG if that is too big.
  let blob = await encode(canvas, 'image/webp', 0.9);
  if (!blob || blob.size > PICTURE_MAX_BYTES) blob = await encode(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new Error('could not encode the image');
  return blob;
}
