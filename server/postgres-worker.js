import { workerData } from "node:worker_threads";
import pg from "pg";

const { Client, types } = pg;
// SQLite returns numbers for COUNT/SUM; keep that behavior under PostgreSQL.
types.setTypeParser(20, (value) => Number(value)); // int8 / bigint
types.setTypeParser(1700, (value) => Number(value)); // numeric

const { port, flagBuffer, connectionString, ssl, timeoutMs = 60_000 } = workerData;
const flag = new Int32Array(flagBuffer);

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Leave a small margin so PostgreSQL reports its own timeout before the
      // main thread gives up waiting for the worker.
      const queryTimeoutMs = Math.max(1_000, timeoutMs - 1_000);
      const client = new Client({
        connectionString,
        ssl: ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: timeoutMs,
        statement_timeout: queryTimeoutMs,
        query_timeout: queryTimeoutMs,
      });
      await client.connect();
      return client;
    })();
  }
  return clientPromise;
}

let chain = Promise.resolve();

function reply(payload) {
  try {
    port.postMessage(payload);
  } finally {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
}

port.on("message", (message) => {
  chain = chain.then(async () => {
    try {
      if (message.type === "close") {
        const client = await getClient().catch(() => null);
        if (client) await client.end();
        reply({ id: message.id, result: { rows: [], rowCount: 0 } });
        return;
      }
      const client = await getClient();
      const result = message.params
        ? await client.query(message.sql, message.params)
        : await client.query(message.sql);
      reply({
        id: message.id,
        result: { rows: result.rows || [], rowCount: result.rowCount ?? 0 },
      });
    } catch (error) {
      reply({ id: message.id, error: error?.message || String(error) });
    }
  });
});
