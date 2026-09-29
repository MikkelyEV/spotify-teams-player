import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, beforeEach, mock, test } from 'node:test';
import { app, HttpRequest } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { DateTime, Settings } from 'luxon';

const originalConnection = process.env.AZURE_STORAGE_CONNECTION_STRING;
const originalNow = Settings.now;
delete process.env.AZURE_STORAGE_CONNECTION_STRING;

const httpRegistration = mock.method(app, 'http', () => {});
const timerRegistration = mock.method(app, 'timer', () => {});
const embedPage = (entity) => `<html><script id="__NEXT_DATA__" type="application/json">${
  JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></html>`;
const spotify = mock.method(globalThis, 'fetch', async () => new Response(embedPage({
  name: 'BbyWOW', artists: [{ name: 'KAROL G' }, { name: 'Judeline' }, { name: 'rusowsky' }],
})));
const { songs } = await import('../src/functions/songs.js');
const { cleanup } = await import('../src/functions/cleanup.js');
const entries = new Map();
const context = { error: mock.fn(), log: mock.fn() };
let now;
Settings.now = () => Date.parse(now);

const key = (entity) => `${entity.partitionKey}/${entity.rowKey}`;
const storageError = (statusCode) => Object.assign(new Error('Private storage details'), { statusCode });
const table = {
  async createTable() {},
  async createEntity(entity) {
    if (entries.has(key(entity))) throw storageError(409);
    entries.set(key(entity), { ...entity });
  },
  async *listEntities({ queryOptions }) {
    const match = /^PartitionKey (eq|lt) '(\d{4}-\d{2}-\d{2})'$/.exec(queryOptions.filter);
    assert.ok(match, 'Queries must be scoped to a Central calendar date');
    for (const entity of entries.values()) {
      if (match[1] === 'eq' ? entity.partitionKey === match[2] : entity.partitionKey < match[2]) {
        yield entity;
      }
    }
  },
  async getEntity(partitionKey, rowKey) {
    const entity = entries.get(key({ partitionKey, rowKey }));
    if (!entity) throw storageError(404);
    return { ...entity };
  },
  async upsertEntity(entity, mode) {
    assert.equal(mode, 'Replace');
    entries.set(key(entity), { ...entity });
  },
  async deleteEntity(partitionKey, rowKey) {
    entries.delete(key({ partitionKey, rowKey }));
  },
};
const connect = mock.method(TableClient, 'fromConnectionString', (connectionString, tableName) => {
  assert.equal(connectionString, 'test-storage');
  assert.equal(tableName, 'sotdSongs');
  return table;
});
const trackId = 'A'.repeat(22);
const spotifyUrl = `https://open.spotify.com/track/${trackId}`;
const song = { trackTitle: 'BbyWOW', artistName: 'KAROL G, Judeline, rusowsky', spotifyUrl };
const validBody = { trackId, userId: 'teams-user-1', userName: 'First user' };
const get = () => songs(new HttpRequest({ method: 'GET', url: 'http://localhost/api/songs' }), context);
const post = (body = validBody) => songs(new HttpRequest({
  method: 'POST',
  url: 'http://localhost/api/songs',
  headers: { 'content-type': 'application/json' },
  body: { string: JSON.stringify(body) },
}), context);

beforeEach(() => {
  entries.clear();
  context.error.mock.resetCalls();
  context.log.mock.resetCalls();
  spotify.mock.resetCalls();
  now = '2026-07-15T17:00:00.000Z';
});

after(() => {
  Settings.now = originalNow;
  if (originalConnection === undefined) delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  else process.env.AZURE_STORAGE_CONNECTION_STRING = originalConnection;
  mock.restoreAll();
});

test('the entry point discovers both v4 functions without requiring storage at import time', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.main, 'src/functions/*.js');
  assert.deepEqual((await readdir(new URL('../src/functions/', import.meta.url))).sort(), ['cleanup.js', 'songs.js']);
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(httpRegistration.mock.callCount(), 1);
  const [name, options] = httpRegistration.mock.calls[0].arguments;
  assert.equal(name, 'songs');
  assert.equal(options.route, 'songs');
  assert.deepEqual(options.methods, ['GET', 'POST']);
  assert.equal(options.authLevel, 'anonymous');
  assert.equal(options.handler, songs);
  assert.equal(timerRegistration.mock.callCount(), 1);
  assert.equal(timerRegistration.mock.calls[0].arguments[0], 'cleanup');
  assert.equal(timerRegistration.mock.calls[0].arguments[1].schedule, '0 0 5,6 * * *');
  assert.equal(timerRegistration.mock.calls[0].arguments[1].handler, cleanup);
});

test('missing configuration and transient initialization failures are safe and retryable', async (t) => {
  assert.equal((await get()).status, 500);
  assert.equal(connect.mock.callCount(), 0);
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'test-storage';
  const create = t.mock.method(table, 'createTable', async () => { throw storageError(503); });
  assert.equal((await get()).status, 500);
  create.mock.restore();
  assert.deepEqual((await get()).jsonBody, { items: [] });
  assert.equal(connect.mock.callCount(), 2);
  await get();
  assert.equal(connect.mock.callCount(), 2);
});

test('multiple users can submit the same track and all required fields are stored', async () => {
  assert.equal((await post()).status, 201);
  assert.equal((await post({ ...validBody, userId: 'teams-user-2', userName: 'Second user' })).status, 201);
  assert.equal(entries.size, 2);
  const entity = [...entries.values()][0];
  assert.equal(entity.partitionKey, '2026-07-15');
  assert.match(entity.rowKey, /^[a-f0-9]{64}$/);
  assert.equal(entity.trackId, trackId);
  assert.equal(entity.userId, validBody.userId);
  assert.equal(entity.userName, validBody.userName);
  assert.equal(entity.trackTitle, 'BbyWOW');
  assert.equal(entity.artistName, 'KAROL G, Judeline, rusowsky');
  assert.equal(entity.createdUtc, now);
  assert.equal(spotify.mock.calls[0].arguments[0], `https://open.spotify.com/embed/track/${trackId}`);
  assert.equal((await get()).jsonBody.items.length, 2);
});

test('concurrent submissions from one user create one entity without overwriting it', async () => {
  const responses = await Promise.all([
    post(),
    post({ ...validBody, trackId: 'B'.repeat(22) }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(entries.size, 1);
  assert.equal([...entries.values()][0].trackId, trackId);
  assert.equal((await post({ ...validBody, userId: ` ${validBody.userId} ` })).status, 409);
});

test('Teams IDs with Table key delimiters are safe and distinct users remain distinct', async () => {
  assert.equal((await post({ ...validBody, userId: 'user/#?\\one' })).status, 201);
  assert.equal((await post({ ...validBody, userId: 'user/#?\\two' })).status, 201);
  assert.equal(entries.size, 2);
});

test('GET returns only today, ordered by creation, in the existing frontend response shape', async () => {
  for (const [time, id] of [
    ['2026-07-15T18:00:00.000Z', 'later'],
    ['2026-07-15T16:00:00.000Z', 'earlier'],
    ['2026-07-15T04:59:00.000Z', 'yesterday'],
    ['2026-07-16T05:00:00.000Z', 'tomorrow'],
  ]) {
    now = time;
    await post({ ...validBody, userId: id, userName: id });
  }
  now = '2026-07-16T04:59:59.000Z';
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(response.jsonBody, {
    items: [
      { trackId, ...song, userName: 'earlier', createdUtc: '2026-07-15T16:00:00.000Z', centralTime: '11:00 AM' },
      { trackId, ...song, userName: 'later', createdUtc: '2026-07-15T18:00:00.000Z', centralTime: '1:00 PM' },
    ],
  });
});

for (const [name, before, afterMidnight] of [
  ['CST', '2026-01-16T05:59:59.000Z', '2026-01-16T06:00:00.000Z'],
  ['CDT', '2026-07-16T04:59:59.000Z', '2026-07-16T05:00:00.000Z'],
  ['spring DST day', '2026-03-09T04:59:59.000Z', '2026-03-09T05:00:00.000Z'],
  ['fall DST day', '2026-11-02T05:59:59.000Z', '2026-11-02T06:00:00.000Z'],
  ['year rollover', '2027-01-01T05:59:59.000Z', '2027-01-01T06:00:00.000Z'],
]) {
  test(`the daily list and limit reset at Central midnight in ${name} without cleanup`, async () => {
    now = before;
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 409);
    now = afterMidnight;
    assert.deepEqual((await get()).jsonBody.items, []);
    assert.equal((await post()).status, 201);
    assert.deepEqual((await get()).jsonBody.items, [
      { trackId, ...song, userName: validBody.userName, createdUtc: afterMidnight, centralTime: '12:00 AM' },
    ]);
    assert.equal(entries.size, 2);
  });
}

for (const [name, before, afterShift] of [
  ['spring-forward', '2026-03-08T07:59:59.000Z', '2026-03-08T08:00:00.000Z'],
  ['fall-back', '2026-11-01T06:59:59.000Z', '2026-11-01T07:00:00.000Z'],
]) {
  test(`the ${name} clock change does not reset the user limit`, async () => {
    now = before;
    assert.equal((await post()).status, 201);
    now = afterShift;
    assert.equal((await post()).status, 409);
    assert.equal((await get()).jsonBody.items.length, 1);
  });
}

test('legacy entries without metadata still render without exposing the track ID as a title', async () => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'test-storage';
  const legacy = {
    partitionKey: '2026-07-15', rowKey: 'legacy', trackId, userId: 'old', userName: 'Old user',
    createdAt: '2026-07-15T16:00:00.000Z',
  };
  entries.set(key(legacy), legacy);
  await post();
  assert.deepEqual((await get()).jsonBody.items, [
    {
      trackId, trackTitle: '', artistName: '', spotifyUrl, userName: 'Old user',
      createdUtc: legacy.createdAt, centralTime: '11:00 AM',
    },
    { trackId, ...song, userName: validBody.userName, createdUtc: now, centralTime: '12:00 PM' },
  ]);
});

test('metadata falls back to oEmbed for the title and never blocks a submission', async (t) => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'test-storage';
  const lookup = t.mock.method(globalThis, 'fetch', async (url) => (String(url).includes('/oembed?')
    ? Response.json({ title: 'BbyWOW' })
    : new Response('unavailable', { status: 503 })));
  assert.equal((await post()).status, 201);
  assert.equal(lookup.mock.calls[1].arguments[0],
    `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${trackId}`)}`);
  lookup.mock.mockImplementation(async () => { throw new Error('network down'); });
  assert.equal((await post({ ...validBody, userId: 'teams-user-2' })).status, 201);
  assert.deepEqual((await get()).jsonBody.items.map(({ trackTitle, artistName }) => [trackTitle, artistName]), [
    ['BbyWOW', ''],
    ['', ''],
  ]);
});

test('a duplicate submission reports the existing song and changes nothing', async () => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'test-storage';
  assert.equal((await post()).status, 201);
  now = '2026-07-15T21:08:00.000Z';
  const response = await post({ ...validBody, trackId: 'B'.repeat(22) });
  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.code, 'ALREADY_SUBMITTED');
  assert.equal(response.jsonBody.existing.trackId, trackId);
  assert.equal(entries.size, 1);
  assert.equal([...entries.values()][0].trackId, trackId);
  assert.equal([...entries.values()][0].createdUtc, '2026-07-15T17:00:00.000Z');
});

test('a confirmed replacement overwrites the user entry, keeps one record, and re-sorts by UTC time', async () => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'test-storage';
  const other = 'C'.repeat(22);
  const replacement = 'B'.repeat(22);
  assert.equal((await post()).status, 201);
  now = '2026-07-15T18:00:00.000Z';
  assert.equal((await post({ ...validBody, trackId: other, userId: 'teams-user-2', userName: 'Second user' })).status, 201);
  now = '2026-07-15T21:08:00.000Z';
  const response = await post({ ...validBody, trackId: replacement, replace: true });
  assert.equal(response.status, 200);
  assert.equal(response.jsonBody.trackId, replacement);
  assert.equal(response.jsonBody.centralTime, '4:08 PM');
  assert.equal(entries.size, 2);
  const items = (await get()).jsonBody.items;
  assert.deepEqual(items.map((item) => item.trackId), [other, replacement]);
  assert.deepEqual(items[1], {
    trackId: replacement, ...song, spotifyUrl: `https://open.spotify.com/track/${replacement}`,
    userName: validBody.userName, createdUtc: now, centralTime: '4:08 PM',
  });
  assert.ok(!items.some((item) => item.trackId === trackId));
  assert.equal((await post({ ...validBody, trackId: other })).status, 409);
  assert.equal((await post({ ...validBody, replace: 'yes' })).status, 400);
});

test('invalid JSON and invalid fields are rejected before writing to storage', async () => {
  const malformed = new HttpRequest({
    method: 'POST', url: 'http://localhost/api/songs', body: { string: '{' },
  });
  assert.equal((await songs(malformed, context)).status, 400);
  for (const body of [
    null, [], {}, { ...validBody, trackId: "');alert(1);//" },
    { ...validBody, trackId: 'A'.repeat(21) }, { ...validBody, trackId: 123 },
    { ...validBody, userId: '' }, { ...validBody, userId: '   ' },
    { ...validBody, userId: 123 }, { ...validBody, userId: 'A'.repeat(257) },
    { ...validBody, userName: '' }, { ...validBody, userName: '   ' },
    { ...validBody, userName: {} }, { ...validBody, userName: 'A'.repeat(257) },
  ]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(entries.size, 0);
});

test('HTTP storage failures return generic errors without leaking storage details', async (t) => {
  t.mock.method(table, 'createEntity', async () => { throw storageError(503); });
  t.mock.method(table, 'listEntities', async function* () { throw storageError(503); });
  for (const response of [await get(), await post()]) {
    assert.equal(response.status, 500);
    assert.ok(response.jsonBody.error);
    assert.doesNotMatch(JSON.stringify(response), /Private storage details/);
  }
  assert.doesNotMatch(JSON.stringify(context.error.mock.calls), /Private storage details/);
});

for (const time of [
  '2026-01-16T05:00:00.000Z', '2026-01-16T06:00:00.000Z',
  '2026-07-16T05:00:00.000Z', '2026-07-16T06:00:00.000Z',
  '2026-03-09T05:00:00.000Z', '2026-11-02T06:00:00.000Z',
]) {
  test(`cleanup at ${time} removes only prior Central days and is idempotent`, async () => {
    now = time;
    const today = DateTime.fromISO(time).setZone('America/Chicago').startOf('day');
    for (const offset of [-7, -1, 0, 1]) {
      const entity = { partitionKey: today.plus({ days: offset }).toISODate(), rowKey: String(offset) };
      entries.set(key(entity), entity);
    }
    await cleanup({}, context);
    assert.deepEqual([...entries.values()].map((entity) => entity.rowKey), ['0', '1']);
    await cleanup({}, context);
    assert.equal(entries.size, 2);
  });
}

test('cleanup tolerates already-deleted entries but propagates other storage failures', async (t) => {
  const entity = { partitionKey: '2026-07-14', rowKey: 'old' };
  entries.set(key(entity), entity);
  const remove = t.mock.method(table, 'deleteEntity', async () => { throw storageError(404); });
  await cleanup({}, context);
  remove.mock.mockImplementation(async () => { throw storageError(503); });
  await assert.rejects(cleanup({}, context), { statusCode: 503 });
});
