// Append-only logger that writes timestamped lines to logs/transcript.log.
// Each entry is also echoed to stdout/stderr so `pm2 logs` still works.

import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "transcript.log");

mkdirSync(LOG_DIR, { recursive: true });
const stream = createWriteStream(LOG_FILE, { flags: "a" });

function write(level, ...args) {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => {
      if (a instanceof Error) return a.stack ?? String(a);
      if (typeof a === "object" && a !== null) return JSON.stringify(a);
      return String(a);
    })
    .join(" ");
  const line = `${ts} [${level}] ${msg}\n`;
  stream.write(line);
  (level === "ERROR" || level === "WARN" ? process.stderr : process.stdout).write(line);
}

export const log = (...args) => write("INFO", ...args);
export const warn = (...args) => write("WARN", ...args);
export const error = (...args) => write("ERROR", ...args);
