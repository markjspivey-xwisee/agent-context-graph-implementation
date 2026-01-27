import type { ReasoningClientConfig } from '../agents/reasoning-client.js';

export interface ResolvedReasoningConfig {
  clientConfig: ReasoningClientConfig;
  label: string;
}

const parseFlags = (value?: string): string[] => {
  if (!value) return [];
  return value
    .split(',')
    .map(flag => flag.trim())
    .filter(Boolean);
};

const parseTimeout = (value?: string, fallback = 120000): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const resolveReasoningConfigFromEnv = (): ResolvedReasoningConfig => {
  const backendRaw = process.env.REASONING_BACKEND?.toLowerCase().trim();
  const legacyUseClaude = process.env.USE_CLAUDE_CLI === 'true';
  const backend = backendRaw || (legacyUseClaude ? 'claude-cli' : 'anthropic');

  switch (backend) {
    case 'openai':
    case 'openai-api': {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is required for OpenAI API');
      }
      return {
        label: 'OpenAI API',
        clientConfig: {
          type: 'api',
          provider: 'openai',
          apiKey,
          model: process.env.OPENAI_MODEL,
          baseUrl: process.env.OPENAI_BASE_URL
        }
      };
    }
    case 'claude-cli':
    case 'claude': {
      return {
        label: 'Claude Code CLI',
        clientConfig: {
          type: 'cli',
          provider: 'claude-cli',
          cliPath: process.env.CLAUDE_CLI_PATH ?? 'claude',
          workingDirectory: process.cwd(),
          timeout: parseTimeout(process.env.CLAUDE_CLI_TIMEOUT_MS),
          model: process.env.CLAUDE_CLI_MODEL,
          additionalFlags: parseFlags(process.env.CLAUDE_CLI_FLAGS)
        }
      };
    }
    case 'codex-cli':
    case 'codex': {
      return {
        label: 'Codex CLI',
        clientConfig: {
          type: 'cli',
          provider: 'codex-cli',
          cliPath: process.env.CODEX_CLI_PATH ?? 'codex',
          workingDirectory: process.cwd(),
          timeout: parseTimeout(process.env.CODEX_CLI_TIMEOUT_MS),
          model: process.env.CODEX_CLI_MODEL,
          additionalFlags: parseFlags(process.env.CODEX_CLI_FLAGS),
          sandbox: process.env.CODEX_CLI_SANDBOX
        }
      };
    }
    case 'anthropic':
    case 'anthropic-api':
    default: {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required for Anthropic API');
      }
      return {
        label: 'Anthropic API',
        clientConfig: {
          type: 'api',
          provider: 'anthropic',
          apiKey,
          model: process.env.ANTHROPIC_MODEL
        }
      };
    }
  }
};
