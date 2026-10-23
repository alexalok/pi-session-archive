import { registerSessionPresence } from "../activity.ts";
import { join } from "node:path";

registerSessionPresence(join(process.argv[2], "sessions-archive"), process.argv[3]);
process.send?.("ready");
setInterval(() => {}, 1000);
