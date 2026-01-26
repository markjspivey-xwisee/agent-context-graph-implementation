import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function resolveSpecRoot(): string {
  const envSpecDir = process.env.ACG_SPEC_DIR ? resolve(process.env.ACG_SPEC_DIR) : null;
  if (envSpecDir) {
    return envSpecDir;
  }

  const candidates = [
    join(repoRoot, 'spec'),
    join(repoRoot, '..', 'agent-context-graph-foundations', 'spec'),
    join(process.cwd(), 'spec'),
    join(process.cwd(), '..', 'agent-context-graph-foundations', 'spec')
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return join(repoRoot, 'spec');
}

export function resolveSpecPath(...parts: string[]): string {
  return join(resolveSpecRoot(), ...parts);
}
