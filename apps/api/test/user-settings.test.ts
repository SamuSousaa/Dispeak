import type { UserSettings } from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('user settings', () => {
  let t: TestApp;
  let me: Account;
  let friend: Account;
  let other: Account;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    return { client, ready: await client.identify(account.token) };
  };
  const patch = (account: Account, body: object) =>
    t.request('PATCH', '/users/@me/settings', { token: account.token, body });
  const read = async (account: Account) =>
    (await t.request('GET', '/users/@me/settings', { token: account.token })).json<UserSettings>();

  beforeAll(async () => {
    t = await createTestApp();
    [me, friend, other] = await Promise.all([
      t.account('Eu'),
      t.account('Amigo'),
      t.account('Outro'),
    ]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('starts with the defaults, in READY and over REST', async () => {
    const { ready } = await online(other);
    expect(ready.settings).toEqual({
      people: {},
      showEmbeds: true,
      privateProfile: false,
      shareActivity: true,
      games: { added: [], hidden: [] },
    });
    expect(await read(other)).toEqual({
      people: {},
      showEmbeds: true,
      privateProfile: false,
      shareActivity: true,
      games: { added: [], hidden: [] },
    });
  });

  it('merges a person field by field and tells every session of the account', async () => {
    const first = await online(me);
    const second = await online(me);
    const stranger = await online(friend);

    const muted = await patch(me, { people: { [friend.user.id]: { streamMuted: true } } });
    expect(muted.statusCode).toBe(200);
    const update = await second.client.next('USER_SETTINGS_UPDATE');
    expect(update.people[friend.user.id]).toEqual({ streamMuted: true });
    await first.client.next('USER_SETTINGS_UPDATE');
    await stranger.client.expectNone('USER_SETTINGS_UPDATE');

    await patch(me, { people: { [friend.user.id]: { streamVolume: 0.4 } } });
    expect((await read(me)).people[friend.user.id]).toEqual({
      streamMuted: true,
      streamVolume: 0.4,
    });
  });

  it('keeps nothing that equals the default', async () => {
    await patch(me, { people: { [other.user.id]: { voiceVolume: 0.5 } } });
    await patch(me, { people: { [other.user.id]: { voiceVolume: 1, voiceMuted: false } } });
    expect((await read(me)).people[other.user.id]).toBeUndefined();
  });

  it('forgets a person with null', async () => {
    await patch(me, { people: { [other.user.id]: { voiceMuted: true } } });
    await patch(me, { people: { [other.user.id]: null } });
    expect((await read(me)).people[other.user.id]).toBeUndefined();
  });

  it('keeps both of two changes made at the same time', async () => {
    const ids = [friend.user.id, other.user.id, crypto.randomUUID(), crypto.randomUUID()];
    await Promise.all(ids.map((id) => patch(me, { people: { [id]: { voiceVolume: 0.3 } } })));
    const { people } = await read(me);
    for (const id of ids) expect(people[id]?.voiceVolume).toBe(0.3);
  });

  it('rejects values out of range', async () => {
    const response = await patch(me, { people: { [friend.user.id]: { streamVolume: 2 } } });
    expect(response.statusCode).toBe(400);
  });

  it('needs a session', async () => {
    const response = await t.request('GET', '/users/@me/settings');
    expect(response.statusCode).toBe(401);
  });
});
