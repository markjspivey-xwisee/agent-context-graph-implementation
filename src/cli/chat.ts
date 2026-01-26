#!/usr/bin/env node
/**
 * Simple Chat CLI for ACG Personal Broker
 *
 * A command-line interface to interact with the personal broker,
 * demonstrating conversation, memory, and federation features.
 */

import * as readline from 'readline';
import { PersonalBroker, PersonalBrokerRegistry } from '../services/personal-broker.js';
import { SocialFederationService } from '../services/social-federation.js';
import { SharedContextService } from '../services/shared-context.js';

// ANSI colors for pretty output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

function print(text: string, color: keyof typeof colors = 'reset'): void {
  console.log(`${colors[color]}${text}${colors.reset}`);
}

function printHeader(): void {
  console.log();
  print('╔═══════════════════════════════════════════════════╗', 'cyan');
  print('║       ACG Personal Broker - Chat Interface        ║', 'cyan');
  print('╚═══════════════════════════════════════════════════╝', 'cyan');
  console.log();
  print('Type /help for commands, or just start chatting!', 'dim');
  console.log();
}

function printHelp(): void {
  console.log();
  print('Available Commands:', 'bold');
  console.log();
  print('  /help              - Show this help message', 'cyan');
  print('  /status            - Show broker status', 'cyan');
  print('  /memory            - List stored memories', 'cyan');
  print('  /remember <text>   - Store a new memory', 'cyan');
  print('  /contacts          - List contacts', 'cyan');
  print('  /profile           - Show your profile', 'cyan');
  print('  /conversations     - List all conversations', 'cyan');
  print('  /new               - Start a new conversation', 'cyan');
  print('  /switch <id>       - Switch to a conversation', 'cyan');
  print('  /history           - Show conversation history', 'cyan');
  print('  /context new <name> - Create shared context', 'cyan');
  print('  /context list      - List shared contexts', 'cyan');
  print('  /invite            - Create an invite link', 'cyan');
  print('  /presence <status> - Set presence (online/away/busy/dnd/offline)', 'cyan');
  print('  /clear             - Clear the screen', 'cyan');
  print('  /quit              - Exit the chat', 'cyan');
  console.log();
}

async function main(): Promise<void> {
  // Initialize services
  const brokerRegistry = new PersonalBrokerRegistry();
  const socialService = new SocialFederationService();
  const contextService = new SharedContextService();

  // Create or load personal broker
  const broker = brokerRegistry.createBroker({
    displayName: 'CLI User',
    ownerDID: 'did:web:local.acg:user:cli',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: 'en-US'
  });

  // Create social profile
  const profile = socialService.createProfile(broker);

  // Start default conversation
  let currentConversation = broker.startConversation({
    title: 'Main Chat',
    channelId: 'cli'
  });

  printHeader();
  print(`Connected as: ${broker.config.displayName}`, 'green');
  print(`Broker ID: ${broker.id}`, 'dim');
  print(`Conversation: ${currentConversation.title || currentConversation.id}`, 'dim');
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${colors.green}You > ${colors.reset}`
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    // Handle commands
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(' ');
      const arg = args.join(' ');

      switch (cmd.toLowerCase()) {
        case 'help':
          printHelp();
          break;

        case 'quit':
        case 'exit':
          print('\nGoodbye!', 'cyan');
          rl.close();
          process.exit(0);

        case 'clear':
          console.clear();
          printHeader();
          break;

        case 'status':
          console.log();
          print('Broker Status:', 'bold');
          print(`  ID: ${broker.id}`, 'dim');
          print(`  Owner: ${broker.ownerDID}`, 'dim');
          print(`  Display Name: ${broker.config.displayName}`, 'dim');
          print(`  Created: ${broker.createdAt}`, 'dim');
          print(`  Conversations: ${broker.listConversations().length}`, 'dim');
          print(`  Channels: ${broker.listChannels().length}`, 'dim');
          print(`  Memory Entries: ${broker.recallMemory({}).length}`, 'dim');
          print(`  Contacts: ${broker.listContacts().length}`, 'dim');
          console.log();
          break;

        case 'memory':
          const memories = broker.recallMemory({ limit: 10 });
          console.log();
          if (memories.length === 0) {
            print('No memories stored yet. Use /remember <text> to store one.', 'dim');
          } else {
            print('Recent Memories:', 'bold');
            memories.forEach((m, i) => {
              print(`  ${i + 1}. [${m.memoryType}] ${m.content}`, 'dim');
              print(`     (importance: ${m.importance}, tags: ${m.tags.join(', ') || 'none'})`, 'gray');
            });
          }
          console.log();
          break;

        case 'remember':
          if (!arg) {
            print('Usage: /remember <text>', 'yellow');
          } else {
            const memory = broker.storeMemory({
              type: 'semantic',
              content: arg,
              importance: 0.7,
              tags: ['user-note']
            });
            print(`Memory stored: ${memory.id}`, 'green');
          }
          break;

        case 'contacts':
          const contacts = broker.listContacts();
          console.log();
          if (contacts.length === 0) {
            print('No contacts yet.', 'dim');
          } else {
            print('Contacts:', 'bold');
            contacts.forEach((c, i) => {
              print(`  ${i + 1}. ${c.displayName} (${c.status})`, 'dim');
            });
          }
          console.log();
          break;

        case 'profile':
          console.log();
          print('Your Profile:', 'bold');
          print(`  Display Name: ${profile.displayName}`, 'dim');
          print(`  Visibility: ${profile.visibility}`, 'dim');
          print(`  Joined: ${profile.joinedAt}`, 'dim');
          print(`  Connections: ${profile.connectionCount}`, 'dim');
          print(`  Protocols: ${profile.supportedProtocols.join(', ')}`, 'dim');
          console.log();
          break;

        case 'conversations':
          const convos = broker.listConversations();
          console.log();
          print('Conversations:', 'bold');
          convos.forEach((c, i) => {
            const current = c.id === currentConversation.id ? ' (current)' : '';
            print(`  ${i + 1}. ${c.title || c.id}${current} [${c.status}]`, c.id === currentConversation.id ? 'green' : 'dim');
          });
          console.log();
          break;

        case 'new':
          const title = arg || `Conversation ${broker.listConversations().length + 1}`;
          currentConversation = broker.startConversation({ title });
          print(`Started new conversation: ${currentConversation.title}`, 'green');
          break;

        case 'switch':
          if (!arg) {
            print('Usage: /switch <conversation-id>', 'yellow');
          } else {
            const found = broker.getConversation(arg);
            if (found) {
              currentConversation = found;
              print(`Switched to: ${currentConversation.title || currentConversation.id}`, 'green');
            } else {
              print('Conversation not found', 'red');
            }
          }
          break;

        case 'history':
          const messages = broker.getMessages(currentConversation.id, { limit: 20 });
          console.log();
          print(`History for: ${currentConversation.title || currentConversation.id}`, 'bold');
          if (messages.length === 0) {
            print('  No messages yet.', 'dim');
          } else {
            messages.forEach(m => {
              const roleColor = m.role === 'user' ? 'green' : m.role === 'assistant' ? 'cyan' : 'dim';
              print(`  [${m.role}] ${m.content}`, roleColor);
            });
          }
          console.log();
          break;

        case 'context':
          if (args[0] === 'new') {
            const name = args.slice(1).join(' ') || 'Shared Context';
            const ctx = contextService.createContext(broker.id, { name });
            print(`Created shared context: ${ctx.id}`, 'green');
            print(`  Name: ${ctx.name}`, 'dim');
          } else if (args[0] === 'list') {
            const contexts = contextService.getContextsForBroker(broker.id);
            console.log();
            if (contexts.length === 0) {
              print('No shared contexts. Use /context new <name> to create one.', 'dim');
            } else {
              print('Shared Contexts:', 'bold');
              contexts.forEach((c, i) => {
                print(`  ${i + 1}. ${c.name} (${c.id})`, 'dim');
              });
            }
            console.log();
          } else {
            print('Usage: /context new <name> | /context list', 'yellow');
          }
          break;

        case 'invite':
          const invite = socialService.createInviteLink(broker.id, {
            type: 'multi_use',
            maxUses: 10
          });
          console.log();
          print('Invite Link Created:', 'bold');
          print(`  Code: ${invite.code}`, 'green');
          print(`  URL: ${invite.url}`, 'dim');
          print(`  Max Uses: ${invite.maxUses}`, 'dim');
          console.log();
          break;

        case 'presence':
          const validStatuses = ['online', 'away', 'busy', 'dnd', 'offline'];
          if (!arg || !validStatuses.includes(arg.toLowerCase())) {
            print(`Usage: /presence <${validStatuses.join('|')}>`, 'yellow');
          } else {
            const presence = socialService.updatePresence(broker.id, {
              status: arg.toLowerCase() as any
            });
            broker.updatePresence({ status: arg.toLowerCase() as any });
            print(`Presence updated: ${presence.status}`, 'green');
          }
          break;

        default:
          print(`Unknown command: /${cmd}. Type /help for available commands.`, 'yellow');
      }
    } else {
      // Regular chat message
      try {
        // Store user message
        await broker.sendMessage(currentConversation.id, input, { role: 'user' });

        // Simulate assistant response (in real implementation, this would go to AI)
        const response = generateSimpleResponse(input);
        await broker.sendMessage(currentConversation.id, response, { role: 'assistant' });

        // Print assistant response
        print(`${colors.cyan}Assistant > ${colors.reset}${response}`);
      } catch (error) {
        print(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 'red');
      }
    }

    rl.prompt();
  });

  rl.on('close', () => {
    print('\nSession ended.', 'dim');
    process.exit(0);
  });
}

// Simple response generator (placeholder for AI integration)
function generateSimpleResponse(input: string): string {
  const lower = input.toLowerCase();

  if (lower.includes('hello') || lower.includes('hi') || lower.includes('hey')) {
    return "Hello! I'm your ACG personal assistant. How can I help you today?";
  }

  if (lower.includes('help')) {
    return "I can help with conversations, memory, contacts, and federation. Type /help to see all commands.";
  }

  if (lower.includes('thank')) {
    return "You're welcome! Let me know if you need anything else.";
  }

  if (lower.includes('bye') || lower.includes('goodbye')) {
    return "Goodbye! Type /quit to exit.";
  }

  if (lower.includes('what') && lower.includes('do')) {
    return "I'm an ACG-powered personal broker. I can manage conversations, store memories, connect with other users via federation, and help you collaborate on shared contexts.";
  }

  if (lower.includes('memory') || lower.includes('remember')) {
    return "Use /memory to see stored memories, or /remember <text> to save something new.";
  }

  if (lower.includes('contact') || lower.includes('friend')) {
    return "Use /contacts to see your connections, or /invite to create an invite link.";
  }

  // Default response
  return `I received your message: "${input}". In a full implementation, this would be processed by an AI model.`;
}

// Run the CLI
main().catch(error => {
  console.error('Error starting chat CLI:', error);
  process.exit(1);
});
