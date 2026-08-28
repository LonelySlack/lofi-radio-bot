// .env must be loaded before any module reads process.env at import time.
//
// ESM evaluates a module's imports before its own body, so bot.js loading .env
// in its body ran *after* stations.js had already been evaluated and captured
// its module-scope defaults — meaning YT_DLP_PATH and YT_DLP_PROXY from .env
// were silently ignored there, and stations.js quietly used a different proxy
// than bot.js. Importing this module first fixes the ordering for everyone.
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const file = join(dirname(fileURLToPath(import.meta.url)), '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
