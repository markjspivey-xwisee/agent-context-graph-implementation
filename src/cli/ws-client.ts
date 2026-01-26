#!/usr/bin/env node
/**
 * WebSocket Test Client for ACG Real-time Sync
 *
 * A simple command-line client to test WebSocket connectivity
 * and real-time sync features.
 */

import WebSocket from 'ws';
import * as readline from 'readline';
import { v4 as uuidv4 } from 'uuid';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function print(text: string, color: keyof typeof colors = 'reset'): void {
  console.log(`${colors[color]}${text}${colors.reset}`);
}

interface WSMessage {
  type: string;
  id: string;
  timestamp: string;
  payload: unknown;
}

class WSTestClient {
  private ws: WebSocket | null = null;
  private brokerId: string;
  private authenticated: boolean = false;

  constructor(brokerId: string = `cli:${uuidv4().slice(0, 8)}`) {
    this.brokerId = brokerId;
  }

  connect(url: string = 'ws://localhost:3000/ws'): Promise<void> {
    return new Promise((resolve, reject) => {
      print(`Connecting to ${url}...`, 'cyan');

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        print('Connected!', 'green');
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(JSON.parse(data.toString()));
      });

      this.ws.on('close', (code, reason) => {
        print(`Connection closed: ${code} - ${reason}`, 'yellow');
        this.authenticated = false;
      });

      this.ws.on('error', (error) => {
        print(`WebSocket error: ${error.message}`, 'red');
        reject(error);
      });
    });
  }

  private handleMessage(message: WSMessage): void {
    const timestamp = new Date().toLocaleTimeString();

    switch (message.type) {
      case 'auth':
        print(`[${timestamp}] Server requests authentication`, 'cyan');
        // Auto-authenticate
        this.authenticate();
        break;

      case 'auth_success':
        this.authenticated = true;
        print(`[${timestamp}] Authenticated as ${(message.payload as any).brokerId}`, 'green');
        break;

      case 'auth_error':
        print(`[${timestamp}] Auth failed: ${(message.payload as any).error}`, 'red');
        break;

      case 'subscribed':
        const sub = message.payload as { channel: string; contextId?: string };
        print(`[${timestamp}] Subscribed to: ${sub.channel}${sub.contextId ? `:${sub.contextId}` : ''}`, 'green');
        break;

      case 'context_change':
        print(`[${timestamp}] Context change:`, 'magenta');
        console.log(JSON.stringify(message.payload, null, 2));
        break;

      case 'presence_update':
        print(`[${timestamp}] Presence update:`, 'magenta');
        console.log(JSON.stringify(message.payload, null, 2));
        break;

      case 'notification':
        const notif = (message.payload as any).notification;
        print(`[${timestamp}] Notification: ${notif.title}`, 'yellow');
        print(`  ${notif.body}`, 'dim');
        break;

      case 'federation_message':
        print(`[${timestamp}] Federation message:`, 'magenta');
        console.log(JSON.stringify(message.payload, null, 2));
        break;

      case 'pong':
        print(`[${timestamp}] Pong received`, 'dim');
        break;

      case 'error':
        print(`[${timestamp}] Error: ${(message.payload as any).error}`, 'red');
        break;

      default:
        print(`[${timestamp}] Unknown message: ${message.type}`, 'yellow');
        console.log(JSON.stringify(message.payload, null, 2));
    }
  }

  private send(type: string, payload: unknown = {}): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      print('Not connected', 'red');
      return;
    }

    const message: WSMessage = {
      type,
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      payload
    };

    this.ws.send(JSON.stringify(message));
  }

  authenticate(): void {
    this.send('auth', { brokerId: this.brokerId });
  }

  subscribe(channel: 'context' | 'presence' | 'notifications' | 'federation', contextId?: string): void {
    this.send('subscribe', { channel, contextId });
  }

  unsubscribe(channel: string, contextId?: string): void {
    this.send('unsubscribe', { channel, contextId });
  }

  ping(): void {
    this.send('ping');
  }

  updatePresence(contextId: string, state: 'active' | 'idle' | 'away' | 'offline'): void {
    this.send('presence_update', {
      contextId,
      brokerId: this.brokerId,
      presence: { state }
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getBrokerId(): string {
    return this.brokerId;
  }
}

async function main(): Promise<void> {
  const url = process.argv[2] || 'ws://localhost:3000/ws';
  const client = new WSTestClient();

  console.log();
  print('╔═══════════════════════════════════════════════════╗', 'cyan');
  print('║     ACG WebSocket Test Client                     ║', 'cyan');
  print('╚═══════════════════════════════════════════════════╝', 'cyan');
  console.log();

  try {
    await client.connect(url);
  } catch (error) {
    print('Failed to connect. Make sure the server is running.', 'red');
    process.exit(1);
  }

  print('\nCommands:', 'bold');
  print('  /auth               - Authenticate', 'dim');
  print('  /sub <channel> [id] - Subscribe (context|presence|notifications|federation)', 'dim');
  print('  /unsub <channel>    - Unsubscribe', 'dim');
  print('  /ping               - Send ping', 'dim');
  print('  /presence <id> <s>  - Update presence (active|idle|away|offline)', 'dim');
  print('  /status             - Show connection status', 'dim');
  print('  /quit               - Disconnect and exit', 'dim');
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.cyan}ws> ${colors.reset}`
  });

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(' ');

      switch (cmd.toLowerCase()) {
        case 'auth':
          client.authenticate();
          break;

        case 'sub':
        case 'subscribe':
          if (!args[0]) {
            print('Usage: /sub <channel> [contextId]', 'yellow');
          } else {
            client.subscribe(args[0] as any, args[1]);
          }
          break;

        case 'unsub':
        case 'unsubscribe':
          if (!args[0]) {
            print('Usage: /unsub <channel> [contextId]', 'yellow');
          } else {
            client.unsubscribe(args[0], args[1]);
          }
          break;

        case 'ping':
          client.ping();
          break;

        case 'presence':
          if (args.length < 2) {
            print('Usage: /presence <contextId> <state>', 'yellow');
          } else {
            client.updatePresence(args[0], args[1] as any);
          }
          break;

        case 'status':
          console.log();
          print('Connection Status:', 'bold');
          print(`  Connected: ${client.isConnected()}`, 'dim');
          print(`  Authenticated: ${client.isAuthenticated()}`, 'dim');
          print(`  Broker ID: ${client.getBrokerId()}`, 'dim');
          console.log();
          break;

        case 'quit':
        case 'exit':
          print('\nDisconnecting...', 'cyan');
          client.disconnect();
          rl.close();
          process.exit(0);

        default:
          print(`Unknown command: /${cmd}`, 'yellow');
      }
    } else {
      print('Use /commands to interact. Type /quit to exit.', 'dim');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    client.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
