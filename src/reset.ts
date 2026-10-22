import { loadConfig } from "./config.ts";
import { Store } from "./db/store.ts";

const config = loadConfig();
const store = new Store(config.dataDir, true);
store.resetAll();
console.log(`Pasture data reset to seed in ${config.dataDir}`);
