import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export function loadEnvFromFile(envPath = '.env'): void {
  const resolvedPath = resolve(envPath);
  if (!existsSync(resolvedPath)) {
    return;
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex === -1) continue;

    const key = cleaned.slice(0, eqIndex).trim();
    let value = cleaned.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!key || key in process.env) continue;
    process.env[key] = value;
  }
}
