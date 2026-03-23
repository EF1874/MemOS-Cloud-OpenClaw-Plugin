import { runConfigUiChildProcess } from "./config-ui-server.js";

runConfigUiChildProcess(console).catch((error) => {
  console.error(`[memos-cloud] Config UI child process failed: ${String(error?.message || error)}`);
  process.exit(1);
});
