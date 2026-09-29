import { createHash } from 'node:crypto';
import { app } from '@azure/functions';
import { TableClient, odata } from '@azure/data-tables';
import { DateTime } from 'luxon';

export const centralZone = 'America/Chicago';
let tablePromise;
let ratingsCleanupTablePromise;

export function getTableClient() {
  if (!tablePromise) {
    tablePromise = (async () => {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) throw new Error('Song storage is not configured.');
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

async function getRatingsCleanupTableClient() {
  if (!ratingsCleanupTablePromise) {
    ratingsCleanupTablePromise = (async () => {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) throw new Error('Rating storage is not configured.');
      const client = TableClient.fromConnectionString(connectionString, 'SotdRatings');
      await client.createTable();
      return client;
    })().catch((error) => {
      ratingsCleanupTablePromise = undefined;
      throw error;
    });
  }
  return ratingsCleanupTablePromise;
}

const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 256) : '');
const ownerRowKey = (userId) => createHash('sha256').update(userId).digest('hex');

// Public Spotify metadata (no credentials); failures fall back to empty values.
export async function trackMetadata(trackId) {
  const metadata = { trackTitle: '', artistName: '' };
  const trackUrl = `https://open.spotify.com/track/${trackId}`;
  try {
    const response = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const json = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await response.text())?.[1];
      const entity = json && JSON.parse(json)?.props?.pageProps?.state?.data?.entity;
      metadata.trackTitle = text(entity?.name || entity?.title);
      metadata.artistName = text(Array.isArray(entity?.artists)
        ? entity.artists.map((artist) => text(artist?.name)).filter(Boolean).join(', ')
        : entity?.subtitle);
    }
  } catch {
    // Metadata is optional.
  }
  if (!metadata.trackTitle) {
    try {
      const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) metadata.trackTitle = text((await response.json())?.title);
    } catch {
      // Metadata is optional.
    }
  }
  return metadata;
}

const createdUtc = (song) => song.createdUtc || song.createdAt;

function songResponse(song) {
  return {
    trackId: song.trackId,
    trackTitle: song.trackTitle || '',
    artistName: song.artistName || '',
    spotifyUrl: song.spotifyUrl || `https://open.spotify.com/track/${song.trackId}`,
    songOwnerId: song.userId,
    userName: song.userName,
    createdUtc: createdUtc(song),
    centralTime: DateTime.fromISO(createdUtc(song), { zone: 'utc' })
      .setZone(centralZone)
      .setLocale('en-US')
      .toFormat('h:mm a'),
  };
}

async function removeRatingsForOwner(day, songOwnerId, context) {
  try {
    const client = await getRatingsCleanupTableClient();
    for await (const entity of client.listEntities({
      queryOptions: {
        filter: odata`PartitionKey eq ${day} and songOwnerId eq ${songOwnerId}`,
        select: ['PartitionKey', 'RowKey'],
      },
    })) {
      try {
        await client.deleteEntity(entity.partitionKey, entity.rowKey);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }
  } catch (error) {
    // Ratings for the old track are also excluded by trackId, so replacement remains safe.
    context.warn(`Unable to remove replaced-song ratings: ${error.message}`);
  }
}

export async function songs(request, context) {
  try {
    if (request.method === 'GET') {
      const today = DateTime.now().setZone(centralZone).toISODate();
      const client = await getTableClient();
      const entries = [];
      for await (const entity of client.listEntities({
        queryOptions: { filter: odata`PartitionKey eq ${today}` },
      })) entries.push(entity);
      entries.sort((a, b) => createdUtc(a).localeCompare(createdUtc(b)));
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
      || typeof body.userName !== 'string' || !body.userName.trim() || body.userName.length > 256
      || (body.replace !== undefined && typeof body.replace !== 'boolean')) {
      return {
        status: 400,
        jsonBody: { error: 'A valid Spotify track ID, userId, and userName are required.' },
      };
    }

    const client = await getTableClient();
    const metadata = await trackMetadata(body.trackId);
    const now = DateTime.now().setZone(centralZone);
    const userId = body.userId.trim();
    const entity = {
      partitionKey: now.toISODate(),
      rowKey: ownerRowKey(userId),
      trackId: body.trackId,
      trackTitle: metadata.trackTitle,
      artistName: metadata.artistName,
      spotifyUrl: `https://open.spotify.com/track/${body.trackId}`,
      userId,
      userName: body.userName.trim(),
      createdUtc: now.toUTC().toISO(),
    };
    if (body.replace === true) {
      await client.upsertEntity(entity, 'Replace');
      await removeRatingsForOwner(entity.partitionKey, userId, context);
      return { status: 200, jsonBody: songResponse(entity) };
    }
    try {
      await client.createEntity(entity);
    } catch (error) {
      if (error.statusCode === 409) {
        let existing;
        try {
          existing = songResponse(await client.getEntity(entity.partitionKey, entity.rowKey));
        } catch {
          existing = undefined;
        }
        return {
          status: 409,
          jsonBody: { error: 'Ya agregaste una canción hoy.', code: 'ALREADY_SUBMITTED', existing },
        };
      }
      throw error;
    }
    return { status: 201, jsonBody: songResponse(entity) };
  } catch (error) {
    context.error(`Unable to access song storage: ${error.message}`);
    return { status: 500, jsonBody: { error: 'Song storage is unavailable. Please try again later.' } };
  }
}

app.http('songs', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'songs',
  handler: songs,
});
