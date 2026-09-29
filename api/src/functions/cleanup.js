import { app } from '@azure/functions';
import { odata } from '@azure/data-tables';
import { DateTime } from 'luxon';
import { centralZone, getTableClient } from './songs.js';

export async function cleanup(_timer, context) {
  const today = DateTime.now().setZone(centralZone).toISODate();
  const client = await getTableClient();
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
      if (error.statusCode !== 404) {
        throw error;
      }
    }
  }
  context.log(`Removed ${removed} old daily song entries.`);
}

app.timer('cleanup', {
  // Check both possible UTC midnights; the date filter preserves today's songs.
  schedule: '0 0 5,6 * * *',
  handler: cleanup,
});
