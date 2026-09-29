import { createHash } from 'node:crypto';
import { app } from '@azure/functions';
import { TableClient, odata } from '@azure/data-tables';
import { DateTime } from 'luxon';
import { centralZone, getTableClient } from './songs.js';

let ratingsTablePromise;

export function getRatingsTableClient() {
  if (!ratingsTablePromise) {
    ratingsTablePromise = (async () => {
      const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) throw new Error('Rating storage is not configured.');
      const client = TableClient.fromConnectionString(connectionString, 'SotdRatings');
      await client.createTable();
      return client;
    })().catch((error) => {
      ratingsTablePromise = undefined;
      throw error;
    });
  }
  return ratingsTablePromise;
}

const clean = (value) => (typeof value === 'string' ? value.trim().slice(0, 256) : '');
const songKey = (songOwnerId, trackId) => `${songOwnerId}\u0000${trackId}`;
const ratingRowKey = (songOwnerId, reviewerUserId) => createHash('sha256')
  .update(`${songOwnerId}\u0000${reviewerUserId}`)
  .digest('hex');
const ownerRowKey = (songOwnerId) => createHash('sha256').update(songOwnerId).digest('hex');

function requestedDay(request) {
  const supplied = clean(request.query.get('day'));
  if (!supplied) return DateTime.now().setZone(centralZone).toISODate();
  const parsed = DateTime.fromISO(supplied, { zone: centralZone });
  return parsed.isValid && parsed.toISODate() === supplied ? supplied : null;
}

function aggregateResponse(song, ratings, reviewerUserId) {
  const matching = ratings.filter((rating) => rating.songOwnerId === song.userId
    && rating.trackId === song.trackId);
  const reviewCount = matching.length;
  const averageRating = reviewCount
    ? Number((matching.reduce((sum, rating) => sum + Number(rating.normalizedScore), 0) / reviewCount).toFixed(1))
    : 0;
  const current = reviewerUserId
    ? matching.find((rating) => rating.reviewerUserId === reviewerUserId)
    : undefined;
  return {
    trackId: song.trackId,
    songOwnerId: song.userId,
    averageRating,
    reviewCount,
    ...(current ? {
      currentUserRating: {
        ratingType: current.ratingType,
        ratingValue: Number(current.ratingValue),
        normalizedScore: Number(current.normalizedScore),
      },
    } : {}),
  };
}

async function listForDay(client, day) {
  const entities = [];
  for await (const entity of client.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${day}` },
  })) entities.push(entity);
  return entities;
}

export async function ratings(request, context) {
  try {
    if (request.method === 'GET') {
      const day = requestedDay(request);
      if (!day) return { status: 400, jsonBody: { error: 'day must use YYYY-MM-DD format.' } };

      const reviewerUserId = clean(request.query.get('reviewerUserId'));
      const trackId = clean(request.query.get('trackId'));
      const songOwnerId = clean(request.query.get('songOwnerId'));
      const [songClient, ratingClient] = await Promise.all([getTableClient(), getRatingsTableClient()]);
      const [songs, savedRatings] = await Promise.all([
        listForDay(songClient, day),
        listForDay(ratingClient, day),
      ]);
      const activeSongs = songs.filter((song) => (!trackId || song.trackId === trackId)
        && (!songOwnerId || song.userId === songOwnerId));
      return {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
        jsonBody: {
          day,
          items: activeSongs.map((song) => aggregateResponse(song, savedRatings, reviewerUserId)),
        },
      };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: 'A valid JSON body is required.' } };
    }

    const trackId = clean(body?.trackId);
    const songOwnerId = clean(body?.songOwnerId);
    const reviewerUserId = clean(body?.reviewerUserId);
    const reviewerUserName = clean(body?.reviewerUserName);
    const ratingType = clean(body?.ratingType);
    const ratingValue = Number(body?.ratingValue);
    const validValue = Number.isInteger(ratingValue)
      && ((ratingType === 'stars' && ratingValue >= 1 && ratingValue <= 5)
        || (ratingType === 'points' && ratingValue >= 1 && ratingValue <= 8));

    if (!/^[A-Za-z0-9]{22}$/.test(trackId) || !songOwnerId || !reviewerUserId
      || !reviewerUserName || !['stars', 'points'].includes(ratingType) || !validValue) {
      return {
        status: 400,
        jsonBody: { error: 'Valid song, reviewer, rating type, and rating value are required.' },
      };
    }

    const now = DateTime.now().setZone(centralZone);
    const day = now.toISODate();
    const songClient = await getTableClient();
    let song;
    try {
      song = await songClient.getEntity(day, ownerRowKey(songOwnerId));
    } catch (error) {
      if (error.statusCode === 404) {
        return { status: 404, jsonBody: { error: 'The song is not in today’s SOTD playlist.' } };
      }
      throw error;
    }
    if (song.trackId !== trackId || song.userId !== songOwnerId) {
      return { status: 404, jsonBody: { error: 'The song is not in today’s SOTD playlist.' } };
    }

    const client = await getRatingsTableClient();
    const rowKey = ratingRowKey(songOwnerId, reviewerUserId);
    let createdUtc = now.toUTC().toISO();
    try {
      const existing = await client.getEntity(day, rowKey);
      createdUtc = existing.createdUtc || createdUtc;
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    const normalizedScore = ratingType === 'stars' ? ratingValue : (ratingValue / 8) * 5;
    await client.upsertEntity({
      partitionKey: day,
      rowKey,
      songOwnerId,
      trackId,
      reviewerUserId,
      reviewerUserName,
      ratingType,
      ratingValue,
      normalizedScore,
      createdUtc,
      updatedUtc: now.toUTC().toISO(),
    }, 'Replace');

    const dailyRatings = await listForDay(client, day);
    const aggregate = aggregateResponse(song, dailyRatings, reviewerUserId);
    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      jsonBody: {
        ...aggregate,
        ratingType,
        ratingValue,
        normalizedScore,
      },
    };
  } catch (error) {
    context.error(`Unable to access rating storage: ${error.message}`);
    return { status: 500, jsonBody: { error: 'Rating storage is unavailable. Please try again later.' } };
  }
}

app.http('ratings', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous',
  route: 'ratings',
  handler: ratings,
});
