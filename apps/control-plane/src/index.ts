import type { Store } from "@throughline/core";
import { postgres } from "@throughline/store-postgres";
import { sqlite } from "@throughline/store-sqlite";
import { createApp } from "./app";
import logger from "./logger";

const port = Number(process.env.PORT ?? 3001);

// Postgres in production (DATABASE_URL), SQLite locally by default.
const store: Store = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL)
  : sqlite(process.env.THROUGHLINE_DB ?? "throughline.db");

await store.init();
createApp(store).listen(port, () => logger.info(`control-plane listening on :${port}`));
