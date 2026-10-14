import { createDb, runMigrations } from "@labordispatch/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { dispatchOptions, startHousekeeping } from "./dispatcher.js";

const config = loadConfig();
const handle = await createDb();
await runMigrations(handle);
const app = await buildApp({ db: handle.db, config });
const stopHousekeeping = startHousekeeping(handle.db, dispatchOptions(handle.db, config), (m) => app.log.info(m));

const shutdown = async () => {
  stopHousekeeping();
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`LaborDispatch API on ${config.publicUrl} (db: ${handle.driver})`);
