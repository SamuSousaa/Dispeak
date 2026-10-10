import { readdir } from 'node:fs/promises';
import {
  ATTACHMENT_MAX_BYTES,
  Permissions as P,
  type Attachment,
  type Message,
  type MessagePage,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sniffImage } from '../src/lib/image';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** Header of a 3x2 GIF; enough for the type and size checks. */
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([3, 0, 2, 0, 0, 0, 0, 0x3b])]);

describe('sniffImage', () => {
  it('reads the type and size from the bytes', () => {
    expect(sniffImage(PNG)).toEqual({ contentType: 'image/png', width: 1, height: 1 });
    expect(sniffImage(GIF)).toEqual({ contentType: 'image/gif', width: 3, height: 2 });

    // SOI, an APP0 segment to skip, then a baseline frame of 640x480.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0,
      0x02, 0x80, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(sniffImage(jpeg)).toEqual({ contentType: 'image/jpeg', width: 640, height: 480 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(sniffImage(webp)).toEqual({ contentType: 'image/webp', width: 800, height: 600 });
  });

  it('rejects everything else, whatever it claims to be', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(Buffer.from('GIF'))).toBeNull();
  });
});

describe('attachments', () => {
  let t: TestApp;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  const clients: GatewayClient[] = [];

  async function scenario() {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    const text = guild.channels.filter((channel) => channel.type === 'text');
    if (!text[0]) throw new Error('default text channel missing');
    return { guild, channelId: text[0].id };
  }
  const upload = (
    account: Account | null,
    channelId: string,
    data: Buffer,
    contentType = 'image/png',
    filename = 'meme.png',
  ) =>
    t.app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/attachments?filename=${encodeURIComponent(filename)}`,
      headers: {
        'content-type': contentType,
        ...(account ? { authorization: `Bearer ${account.token}` } : {}),
      },
      payload: data,
    });
  const uploaded = async (account: Account, channelId: string, data = PNG) =>
    (await upload(account, channelId, data)).json<Attachment>();
  const send = (account: Account, channelId: string, body: object) =>
    t.request('POST', `/channels/${channelId}/messages`, { token: account.token, body });
  const download = (account: Account, id: string) =>
    t.request('GET', `/attachments/${id}`, { token: account.token });
  const storedFiles = () => readdir(t.app.ctx.config.UPLOADS_DIR).catch(() => []);

  beforeAll(async () => {
    t = await createTestApp();
    [owner, member, outsider] = await Promise.all([
      t.account('Dona'),
      t.account('Membro'),
      t.account('Estranho'),
    ]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('uploads an image, attaches it to a message and serves it to members only', async () => {
    const { channelId } = await scenario();
    const socket = await connectGateway(t.wsUrl);
    clients.push(socket);
    await socket.identify(member.token);

    const response = await upload(owner, channelId, PNG, 'image/png', '../../etc/gato feliz.png');
    expect(response.statusCode).toBe(201);
    const attachment = response.json<Attachment>();
    expect(attachment).toMatchObject({
      filename: 'gato feliz.png',
      contentType: 'image/png',
      size: PNG.length,
      width: 1,
      height: 1,
    });
    // Until it is in a message, only the uploader can fetch it.
    expect((await download(member, attachment.id)).statusCode).toBe(404);

    const sent = await send(owner, channelId, { attachmentIds: [attachment.id] });
    expect(sent.statusCode).toBe(201);
    expect(sent.json<Message>()).toMatchObject({ content: '', attachments: [attachment] });
    await expect(socket.next('MESSAGE_CREATE')).resolves.toMatchObject({
      attachments: [attachment],
    });

    const page = (
      await t.request('GET', `/channels/${channelId}/messages`, { token: member.token })
    ).json<MessagePage>();
    expect(page.messages.at(-1)?.attachments).toEqual([attachment]);

    const file = await download(member, attachment.id);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toContain('private');

    expect((await download(outsider, attachment.id)).statusCode).toBe(404);
    expect((await t.request('GET', `/attachments/${attachment.id}`)).statusCode).toBe(401);
  });

  it('trusts the bytes, not the declared type', async () => {
    const { channelId } = await scenario();
    // A GIF sent as PNG is stored as what it is.
    expect((await upload(owner, channelId, GIF, 'image/png')).json<Attachment>()).toMatchObject({
      contentType: 'image/gif',
      width: 3,
      height: 2,
    });
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect((await upload(owner, channelId, html, 'image/png')).statusCode).toBe(400);
    expect((await upload(owner, channelId, PNG, 'image/svg+xml')).statusCode).toBe(415);
    expect((await upload(owner, channelId, PNG, 'application/octet-stream')).statusCode).toBe(415);
  });

  it('enforces the size limit and the channel permissions', async () => {
    const { channelId } = await scenario();
    const huge = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_BYTES)]);
    expect((await upload(owner, channelId, huge)).statusCode).toBe(413);
    expect((await upload(null, channelId, PNG)).statusCode).toBe(401);
    expect((await upload(outsider, channelId, PNG)).statusCode).toBe(404);

    await t.request('PUT', `/channels/${channelId}/overwrites/${member.user.id}`, {
      token: owner.token,
      body: { targetType: 'member', allow: '0', deny: P.SendMessages.toString() },
    });
    expect((await upload(member, channelId, PNG)).statusCode).toBe(403);
  });

  it('only attaches the sender’s own unused uploads to the same channel', async () => {
    const { guild, channelId } = await scenario();
    const mine = await uploaded(owner, channelId);
    const theirs = await uploaded(member, channelId);

    expect(
      (await send(owner, channelId, { content: 'x', attachmentIds: [theirs.id] })).statusCode,
    ).toBe(400);
    // The failed attempt left no message behind.
    const page = (
      await t.request('GET', `/channels/${channelId}/messages`, { token: owner.token })
    ).json<MessagePage>();
    expect(page.messages).toEqual([]);

    const other = await t.request('POST', `/guilds/${guild.id}/channels`, {
      token: owner.token,
      body: { name: 'outro', type: 'text' },
    });
    const otherId = other.json<{ id: string }>().id;
    expect(
      (await send(owner, otherId, { content: 'x', attachmentIds: [mine.id] })).statusCode,
    ).toBe(400);

    expect(
      (await send(owner, channelId, { content: 'x', attachmentIds: [mine.id] })).statusCode,
    ).toBe(201);
    expect(
      (await send(owner, channelId, { content: 'y', attachmentIds: [mine.id] })).statusCode,
    ).toBe(400);
  });

  it('needs text or an attachment, and keeps the order of several attachments', async () => {
    const { channelId } = await scenario();
    expect((await send(owner, channelId, { content: '   ' })).statusCode).toBe(400);
    expect((await send(owner, channelId, {})).statusCode).toBe(400);

    const first = await uploaded(owner, channelId);
    const second = await uploaded(owner, channelId, GIF);
    const sent = await send(owner, channelId, {
      content: 'dois',
      attachmentIds: [second.id, first.id],
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const message = sent.json<Message>();
    expect(message.attachments.map((attachment) => attachment.id)).toEqual([second.id, first.id]);

    // The text of a message with attachments can be removed; of a plain one it cannot.
    const emptied = await t.request('PATCH', `/messages/${message.id}`, {
      token: owner.token,
      body: { content: '' },
    });
    expect(emptied.json<Message>()).toMatchObject({
      content: '',
      attachments: message.attachments,
    });
    const plain = (await send(owner, channelId, { content: 'só texto' })).json<Message>();
    const rejected = await t.request('PATCH', `/messages/${plain.id}`, {
      token: owner.token,
      body: { content: '' },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it('hides attachments of a channel the member can no longer see', async () => {
    const { channelId } = await scenario();
    const attachment = await uploaded(owner, channelId);
    await send(owner, channelId, { attachmentIds: [attachment.id] });
    expect((await download(member, attachment.id)).statusCode).toBe(200);

    await t.request('PUT', `/channels/${channelId}/overwrites/${member.user.id}`, {
      token: owner.token,
      body: { targetType: 'member', allow: '0', deny: P.ViewChannel.toString() },
    });
    expect((await download(member, attachment.id)).statusCode).toBe(404);
  });

  it('removes the file with its message, and sweeps uploads that were never used', async () => {
    const { guild, channelId } = await scenario();
    const attachment = await uploaded(owner, channelId);
    const message = (
      await send(owner, channelId, { attachmentIds: [attachment.id] })
    ).json<Message>();
    expect(await storedFiles()).toContain(attachment.id);

    await t.request('DELETE', `/messages/${message.id}`, { token: owner.token });
    expect(await storedFiles()).not.toContain(attachment.id);
    expect((await download(owner, attachment.id)).statusCode).toBe(404);

    const abandoned = await uploaded(owner, channelId);
    const orphan = await uploaded(owner, channelId);
    await send(owner, channelId, { attachmentIds: [orphan.id] });
    // Fresh uploads survive a sweep; so does everything still in a message.
    await t.app.ctx.messages.sweepAttachments();
    expect(await storedFiles()).toEqual(expect.arrayContaining([abandoned.id, orphan.id]));

    // Deleting the guild drops the rows but not the files: the sweep collects both leftovers.
    await t.request('DELETE', `/guilds/${guild.id}`, { token: owner.token });
    await t.app.ctx.messages.sweepAttachments(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const remaining = await storedFiles();
    expect(remaining).not.toContain(abandoned.id);
    expect(remaining).not.toContain(orphan.id);
  });
});

describe('upload rate limiting', () => {
  it('limits uploads per user', async () => {
    const limited = await createTestApp({ RATE_LIMIT_UPLOADS_MAX: '2' });
    try {
      const alice = await limited.account();
      const guild = await limited.createGuild(alice);
      const channelId = guild.channels.find((channel) => channel.type === 'text')?.id;
      const statuses = [];
      for (let i = 0; i < 3; i++) {
        const response = await limited.app.inject({
          method: 'POST',
          url: `/api/channels/${channelId}/attachments?filename=a.png`,
          headers: { 'content-type': 'image/png', authorization: `Bearer ${alice.token}` },
          payload: PNG,
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toEqual([201, 201, 429]);
    } finally {
      await limited.close();
    }
  });
});
