import { GatewayOp, type Guild } from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

describe('activity: the game someone plays', () => {
  let t: TestApp;
  const clients: GatewayClient[] = [];

  const online = async (account: Account) => {
    const client = await connectGateway(t.wsUrl);
    clients.push(client);
    return { client, ready: await client.identify(account.token) };
  };
  const play = (client: GatewayClient, game: string | null) =>
    client.send({ op: GatewayOp.UpdateActivity, d: { game } });

  beforeAll(async () => {
    // A closed session can still be resumed for this long; then what it showed goes.
    t = await createTestApp({ GATEWAY_RESUME_WINDOW_MS: '100' });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('reaches the others in the server, shows in the guild, and ends with the session', async () => {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const guild = await t.createGuild(ana);
    await t.join(guild, ana, beto);
    const anaSession = await online(ana);
    const { client } = await online(beto);

    play(anaSession.client, 'ELDEN RING');
    const started = await client.next('ACTIVITY_UPDATE');
    expect(started).toMatchObject({ userId: ana.user.id, activity: { game: 'ELDEN RING' } });
    const seen = (
      await t.request('GET', `/guilds/${guild.id}`, { token: beto.token })
    ).json<Guild>();
    expect(seen.activities[ana.user.id]?.game).toBe('ELDEN RING');

    // The same game again changes nothing; another one does.
    play(anaSession.client, 'ELDEN RING');
    await client.expectNone('ACTIVITY_UPDATE');
    play(anaSession.client, 'Stardew Valley');
    expect((await client.next('ACTIVITY_UPDATE')).activity?.game).toBe('Stardew Valley');

    await anaSession.client.close();
    expect(await client.next('ACTIVITY_UPDATE')).toEqual({ userId: ana.user.id, activity: null });
  });

  it('is not shown while the player is invisible', async () => {
    const [ana, beto] = await Promise.all([t.account('Ana'), t.account('Beto')]);
    const guild = await t.createGuild(ana);
    await t.join(guild, ana, beto);
    await t.request('PATCH', '/users/@me', { token: ana.token, body: { presence: 'invisible' } });
    const anaSession = await online(ana);
    const { client } = await online(beto);

    play(anaSession.client, 'ELDEN RING');
    await client.expectNone('ACTIVITY_UPDATE');
    const seen = (
      await t.request('GET', `/guilds/${guild.id}`, { token: beto.token })
    ).json<Guild>();
    expect(seen.activities[ana.user.id]).toBeUndefined();
  });
});
