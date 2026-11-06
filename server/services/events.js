/**
 * Small in-process SSE hub. One channel per tenant; every board mutation
 * publishes the new revision so other tabs and devices refresh promptly.
 */
export function createEventHub({ heartbeatMs = 25_000 } = {}) {
  const clients = new Set();
  let heartbeat = null;

  function ensureHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      for (const client of clients) {
        try {
          client.res.write(": heartbeat\n\n");
        } catch {
          remove(client);
        }
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function remove(client) {
    clients.delete(client);
    if (clients.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function subscribe(tenantId, res, initial = {}) {
    const client = { tenantId, res };
    clients.add(client);
    ensureHeartbeat();
    res.write("retry: 3000\n\n");
    res.write(`event: ready\ndata: ${JSON.stringify(initial)}\n\n`);
    return () => remove(client);
  }

  function publish(tenantId, payload) {
    const data = `event: revision\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      if (client.tenantId !== tenantId) continue;
      try {
        client.res.write(data);
      } catch {
        remove(client);
      }
    }
  }

  function close() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    clients.clear();
  }

  return { subscribe, publish, close, get size() { return clients.size; } };
}
