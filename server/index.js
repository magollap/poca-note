import { createConfig, loadDotenv } from "./config.js";
import { openDatabase } from "./db.js";
import { seedDemoTenant } from "./auth.js";
import { createApp } from "./app.js";
import { startReportScheduler } from "./services/reports.js";

loadDotenv();
const config = createConfig();
const db = openDatabase(config);
const seeded = seedDemoTenant(db, config);

const app = createApp({ db, config });
const server = app.listen(config.port, () => {
  console.log(`poca-note server listening on http://localhost:${config.port}`);
  console.log(`storage: ${config.databaseUrl ? "postgresql (DATABASE_URL)" : config.databasePath}`);
  if (seeded) {
    console.log(
      `seeded demo tenant "${config.demo.slug}" (password: ${config.demo.showCredentials ? config.demo.password : "hidden"})`
    );
  }
});

const stopReportScheduler = startReportScheduler({ db, config });

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`);
  stopReportScheduler();
  server.close(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
