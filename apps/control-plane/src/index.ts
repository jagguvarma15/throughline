import { sqlite } from "@throughline/store-sqlite";
import { createApp } from "./app";
import logger from "./logger";

const port = Number(process.env.PORT ?? 3001);
const store = sqlite(process.env.THROUGHLINE_DB ?? "throughline.db");
await store.init();

createApp(store).listen(port, () => logger.info(`control-plane listening on :${port}`));
