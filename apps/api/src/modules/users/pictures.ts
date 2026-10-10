import { randomUUID } from 'node:crypto';
import { PICTURE_MAX_BYTES, type AttachmentContentType } from '@frequencia/shared';
import { badRequest } from '../../errors';
import { sniffImage } from '../../lib/image';
import type { AttachmentFiles } from '../messages/attachment-files';

/**
 * Profile pictures and server icons. Each upload gets a fresh random id, which is all a
 * browser needs to fetch it: the pictures are shown to everyone who shares a server with their
 * owner, so they are served without a session and cached for good.
 */
export class PictureStore {
  constructor(private readonly files: AttachmentFiles) {}

  /** Keeps an image and returns its id. The type comes from the bytes, as with attachments. */
  async store(data: Buffer): Promise<string> {
    if (data.length === 0 || data.length > PICTURE_MAX_BYTES) {
      throw badRequest('the picture is empty or too large');
    }
    if (!sniffImage(data)) throw badRequest('only PNG, JPEG, GIF and WebP images are accepted');
    const id = randomUUID();
    await this.files.write(id, data);
    return id;
  }

  /** Drops a picture that nothing points to any more. */
  async discard(id: string | null): Promise<void> {
    if (id) await this.files.remove([id]);
  }

  async read(id: string): Promise<{ data: Buffer; contentType: AttachmentContentType } | null> {
    const data = await this.files.read(id);
    const image = data && sniffImage(data);
    return data && image ? { data, contentType: image.contentType } : null;
  }
}
