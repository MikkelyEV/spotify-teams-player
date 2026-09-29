import { createHash } from 'node:crypto';
import { app } from '@azure/functions';
import { TableClient, odata } from '@azure/data-tables';
import { DateTime } from 'luxon';

export const centralZone = 'America/Chicago';
let tablePromise;

export function getTableClient() {
  if (!tablePromise) {
    tablePromise = (async () => {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error('Song storage is not configured.');
      }
      const client = TableClient.fromConnectionString(connectionString, 'sotdSongs');
      await client.createTable();
      return client;
    })().catch((error) => {
      tablePromise = undefined;
      throw error;
    });
  }
  return tablePromise;
}

function songResponse(song) {
  return {
    trackId: song.trackId,
    userName: song.userName,
    centralTime: DateTime.fromISO(song.createdAt, { zone: 'utc' })
      .setZone(centralZone)
      .toFormat('h:mm a'),
  };
}

export async function songs(request, context) {
  try {
    if (request.method === 'GET') {
      const today = DateTime.now().setZone(centralZone).toISODate();
      const client = await getTableClient();
      const entries = [];
      for await (const entity of client.listEntities({
        queryOptions: { filter: odata`PartitionKey eq ${today}` },
      })) {
        entries.push(entity);
      }
      entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: { items: entries.map(songResponse) },
      };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: 'A valid JSON body is required.' } };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.trackId !== 'string' || !/^[A-Za-z0-9]{22}$/.test(body.trackId)
      || typeof body.userId !== 'string' || !body.userId.trim() || body.userId.length > 256
      || typeof body.userName !== 'string' || !body.userName.trim() || body.userName.length > 256) {
      return {
        status: 400,
        jsonBody: { error: 'A valid Spotify track ID, userId, and userName are required.' },
      };
    }

    const client = await getTableClient();
    const now = DateTime.now().setZone(centralZone);
    const userId = body.userId.trim();
    const entity = {
      partitionKey: now.toISODate(),
      // A deterministic, Table-safe key makes concurrent submissions atomic.
      rowKey: createHash('sha256').update(userId).digest('hex'),
      trackId: body.trackId,
      userId,
      userName: body.userName.trim(),
      createdAt: now.toUTC().toISO(),
    };
    try {
      await client.createEntity(entity);
    } catch (error) {
      if (error.statusCode === 409) {
        return {
          status: 409,
          jsonBody: { error: 'You have already submitted a song for today (Central Time).' },
        };
      }
      throw error;
    }
    return { status: 201, jsonBody: songResponse(entity) };
  } catch {
    context.error('Unable to access song storage.');
    return { status: 500, jsonBody: { error: 'Song storage is unavailable. Please try again later.' } };
  }
}

app.http('songs', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'songs',
  handler: songs,
});
