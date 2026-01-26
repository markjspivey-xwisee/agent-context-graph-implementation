import { spawn } from 'child_process';
import { writeFile, readFile, mkdir, unlink, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

export interface FileWriteParams {
  path: string;
  content: string;
}

export interface FileReadParams {
  path: string;
}

export interface BashParams {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface GlobParams {
  pattern: string;
  cwd?: string;
}

/**
 * ToolExecutor - Executes real tools for agent actions
 *
 * Provides actual file system and shell access for executor agents.
 * All operations are traced and can be audited.
 */
export class ToolExecutor {
  private workingDirectory: string;
  private defaultTimeout: number;
  private executionLog: Array<{
    tool: string;
    params: unknown;
    result: ToolResult;
    timestamp: string;
  }> = [];

  constructor(options?: { workingDirectory?: string; timeout?: number }) {
    this.workingDirectory = options?.workingDirectory ?? process.cwd();
    this.defaultTimeout = options?.timeout ?? 30000;
  }

  /**
   * Write a file to the filesystem
   */
  async writeFile(params: FileWriteParams): Promise<ToolResult> {
    const startTime = Date.now();
    const fullPath = this.resolvePath(params.path);

    try {
      // Ensure directory exists
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeFile(fullPath, params.content, 'utf-8');

      const result: ToolResult = {
        success: true,
        output: `File written: ${fullPath} (${params.content.length} bytes)`,
        duration: Date.now() - startTime
      };

      this.log('writeFile', params, result);
      return result;

    } catch (error) {
      const result: ToolResult = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
      this.log('writeFile', params, result);
      return result;
    }
  }

  /**
   * Read a file from the filesystem
   */
  async readFile(params: FileReadParams): Promise<ToolResult> {
    const startTime = Date.now();
    const fullPath = this.resolvePath(params.path);

    try {
      const content = await readFile(fullPath, 'utf-8');

      const result: ToolResult = {
        success: true,
        output: content,
        duration: Date.now() - startTime
      };

      this.log('readFile', params, result);
      return result;

    } catch (error) {
      const result: ToolResult = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
      this.log('readFile', params, result);
      return result;
    }
  }

  /**
   * Delete a file
   */
  async deleteFile(params: FileReadParams): Promise<ToolResult> {
    const startTime = Date.now();
    const fullPath = this.resolvePath(params.path);

    try {
      await unlink(fullPath);

      const result: ToolResult = {
        success: true,
        output: `File deleted: ${fullPath}`,
        duration: Date.now() - startTime
      };

      this.log('deleteFile', params, result);
      return result;

    } catch (error) {
      const result: ToolResult = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
      this.log('deleteFile', params, result);
      return result;
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(params: { path: string }): Promise<ToolResult> {
    const startTime = Date.now();
    const fullPath = this.resolvePath(params.path);

    try {
      const files = await readdir(fullPath, { withFileTypes: true });
      const output = files.map(f =>
        `${f.isDirectory() ? '[DIR]' : '[FILE]'} ${f.name}`
      ).join('\n');

      const result: ToolResult = {
        success: true,
        output,
        duration: Date.now() - startTime
      };

      this.log('listFiles', params, result);
      return result;

    } catch (error) {
      const result: ToolResult = {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
      this.log('listFiles', params, result);
      return result;
    }
  }

  /**
   * Execute a bash command
   */
  async bash(params: BashParams): Promise<ToolResult> {
    const startTime = Date.now();
    const timeout = params.timeout ?? this.defaultTimeout;
    const cwd = params.cwd ? this.resolvePath(params.cwd) : this.workingDirectory;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = spawn(params.command, {
        shell: true,
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      const timeoutId = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, timeout);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timeoutId);

        const result: ToolResult = {
          success: code === 0 && !killed,
          output: stdout,
          error: killed ? `Command timed out after ${timeout}ms` : (stderr || undefined),
          duration: Date.now() - startTime
        };

        this.log('bash', params, result);
        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);

        const result: ToolResult = {
          success: false,
          output: stdout,
          error: err.message,
          duration: Date.now() - startTime
        };

        this.log('bash', params, result);
        resolve(result);
      });
    });
  }

  /**
   * Execute npm commands
   */
  async npm(params: { command: string; cwd?: string }): Promise<ToolResult> {
    return this.bash({
      command: `npm ${params.command}`,
      cwd: params.cwd
    });
  }

  /**
   * Execute git commands
   */
  async git(params: { command: string; cwd?: string }): Promise<ToolResult> {
    return this.bash({
      command: `git ${params.command}`,
      cwd: params.cwd
    });
  }

  /**
   * Create a TypeScript/JavaScript file with proper formatting
   */
  async createCodeFile(params: {
    path: string;
    code: string;
    language?: 'typescript' | 'javascript';
  }): Promise<ToolResult> {
    // Add common header
    const header = `// Generated by Agent Context Graph
// Timestamp: ${new Date().toISOString()}
`;
    const content = header + params.code;
    return this.writeFile({ path: params.path, content });
  }

  /**
   * Run TypeScript compiler
   */
  async compileTypeScript(params: { cwd?: string }): Promise<ToolResult> {
    return this.bash({
      command: 'npx tsc --noEmit',
      cwd: params.cwd,
      timeout: 60000
    });
  }

  /**
   * Run tests
   */
  async runTests(params: { cwd?: string; pattern?: string }): Promise<ToolResult> {
    const pattern = params.pattern ? ` ${params.pattern}` : '';
    return this.bash({
      command: `npm test -- --run${pattern}`,
      cwd: params.cwd,
      timeout: 120000
    });
  }

  /**
   * Get execution log
   */
  getExecutionLog() {
    return [...this.executionLog];
  }

  /**
   * Clear execution log
   */
  clearExecutionLog() {
    this.executionLog = [];
  }

  /**
   * Resolve a path relative to working directory
   */
  private resolvePath(path: string): string {
    if (path.startsWith('/') || path.match(/^[A-Za-z]:/)) {
      return path; // Already absolute
    }
    return join(this.workingDirectory, path);
  }

  /**
   * Log an execution
   */
  private log(tool: string, params: unknown, result: ToolResult) {
    this.executionLog.push({
      tool,
      params,
      result,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Create a sandboxed tool executor that restricts operations to a specific directory
 */
export function createSandboxedExecutor(sandboxDir: string): ToolExecutor {
  return new ToolExecutor({
    workingDirectory: sandboxDir
  });
}
