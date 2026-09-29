import { app } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { DateTime } from 'luxon';
import { centralZone, getTableClient } from './songs.js';
import { getRatingsTableClient } from './ratings.js';

async function removeBeforeToday(client, today) {
  let removed = 0;
  for await (const entity of client.listEntities({
    queryOptions: {
      filter: odata`PartitionKey lt ${today}`,
      select: ['PartitionKey', 'RowKey'],
    },
  })) {
    try {
      await client.deleteEntity(entity.partitionKey, entity.rowKey);
      removed += 1;
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
  }
  return removed;
}

export async function cleanup(_timer, context) {
  const today = DateTime.now().setZone(centralZone).toISODate();
  const [songsClient, ratingsClient] = await Promise.all([
    getTableClient(),
    getRatingsTableClient(),
  ]);
  const [songsRemoved, ratingsRemoved] = await Promise.all([
    removeBeforeToday(songsClient, today),
    removeBeforeToday(ratingsClient, today),
  ]);
  context.log(`Removed ${songsRemoved} old daily song entries and ${ratingsRemoved} old rating entries.`);
}

app.timer('cleanup', {
  // Check both possible UTC midnights; America/Chicago determines which partition is current.
  schedule: '0 0 5,6 * * *',
  handler: cleanup,
});
