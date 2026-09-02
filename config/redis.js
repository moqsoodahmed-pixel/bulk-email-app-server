import IORedis from 'ioredis';

let connection;

export function getRedisConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    connection = new IORedis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
    connection.on('error', (err) => console.error('[redis] error:', err.message));
    connection.on('connect', () => console.log('[redis] connected'));
  }
  return connection;
}
