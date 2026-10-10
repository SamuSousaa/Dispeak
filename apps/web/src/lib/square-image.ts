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
 * Turns any image the browser can open into a small one of the given size, keeping the centre
 * and cutting what does not fit. Whatever the original weighed, the result is a few dozen
 * kilobytes. Animated images become their first frame.
 */
export async function coverImage(file: Blob, width: number, height: number): Promise<Blob> {
  const image = await load(file);
  if (image.naturalWidth === 0 || image.naturalHeight === 0) throw new Error('empty image');
  // The largest area of the wanted proportion that fits inside the picture.
  const scale = Math.min(image.naturalWidth / width, image.naturalHeight / height);
  const sourceWidth = width * scale;
  const sourceHeight = height * scale;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    (image.naturalWidth - sourceWidth) / 2,
    (image.naturalHeight - sourceHeight) / 2,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );

  // WebP where the browser can write it (it falls back to PNG by itself), JPEG if that is too big.
  let blob = await encode(canvas, 'image/webp', 0.9);
  if (!blob || blob.size > PICTURE_MAX_BYTES) blob = await encode(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new Error('could not encode the image');
  return blob;
}

/** The square the server expects for profile pictures and server icons. */
export const squareImage = (file: Blob) => coverImage(file, PICTURE_SIZE, PICTURE_SIZE);
