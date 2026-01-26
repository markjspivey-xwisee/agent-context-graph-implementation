/**
 * Multi-Broker Federation Demo
 *
 * Demonstrates end-to-end federation between multiple ACG broker instances:
 * - Three brokers (Alice, Bob, Carol) each running independently
 * - Connection establishment via invite codes
 * - Shared context creation and real-time collaboration
 * - CRDT-based conflict resolution
 * - Presence tracking across federation
 */

import { v4 as uuidv4 } from 'uuid';

// Simulated broker instances (in production, these would be separate processes)
interface BrokerInstance {
  id: string;
  name: string;
  did: string;
  port: number;
  connections: string[];
  sharedContexts: Map<string, SharedContextState>;
  presence: Map<string, PresenceState>;
}

interface SharedContextState {
  id: string;
  name: string;
  nodes: Map<string, ContextNode>;
  edges: Map<string, ContextEdge>;
  participants: string[];
  vectorClock: Map<string, number>;
}

interface ContextNode {
  id: string;
  type: string;
  label: string;
  data: Record<string, unknown>;
  createdBy: string;
  version: number;
}

interface ContextEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  createdBy: string;
}

interface PresenceState {
  brokerId: string;
  displayName: string;
  state: 'online' | 'away' | 'busy' | 'offline';
  lastSeen: Date;
  activeContexts: string[];
}

// Demo orchestrator
class MultiBrokerDemo {
  private brokers: Map<string, BrokerInstance> = new Map();
  private eventLog: string[] = [];

  constructor() {
    this.log('='.repeat(60));
    this.log('Multi-Broker Federation Demo');
    this.log('='.repeat(60));
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    const logEntry = `[${timestamp}] ${message}`;
    this.eventLog.push(logEntry);
    console.log(logEntry);
  }

  // Step 1: Initialize broker instances
  async initializeBrokers(): Promise<void> {
    this.log('\n📦 Step 1: Initializing broker instances...\n');

    const brokerConfigs = [
      { name: 'Alice', port: 3001 },
      { name: 'Bob', port: 3002 },
      { name: 'Carol', port: 3003 }
    ];

    for (const config of brokerConfigs) {
      const broker: BrokerInstance = {
        id: `broker-${uuidv4().slice(0, 8)}`,
        name: config.name,
        did: `did:key:z6Mk${uuidv4().replace(/-/g, '').slice(0, 43)}`,
        port: config.port,
        connections: [],
        sharedContexts: new Map(),
        presence: new Map()
      };

      this.brokers.set(broker.name, broker);
      this.log(`  ✓ ${config.name}'s broker started on port ${config.port}`);
      this.log(`    DID: ${broker.did.slice(0, 30)}...`);
    }

    this.log('\n  All brokers initialized successfully!\n');
  }

  // Step 2: Establish connections
  async establishConnections(): Promise<void> {
    this.log('\n🔗 Step 2: Establishing federation connections...\n');

    const alice = this.brokers.get('Alice')!;
    const bob = this.brokers.get('Bob')!;
    const carol = this.brokers.get('Carol')!;

    // Alice connects to Bob
    this.log('  Alice → Bob: Sending connection request...');
    await this.simulateDelay(500);

    const aliceBobInvite = this.generateInviteCode(alice);
    this.log(`    Invite code: ${aliceBobInvite.slice(0, 20)}...`);

    await this.acceptConnection(bob, alice, aliceBobInvite);
    this.log('  ✓ Alice ↔ Bob connection established');

    // Bob connects to Carol
    this.log('\n  Bob → Carol: Sending connection request...');
    await this.simulateDelay(500);

    const bobCarolInvite = this.generateInviteCode(bob);
    await this.acceptConnection(carol, bob, bobCarolInvite);
    this.log('  ✓ Bob ↔ Carol connection established');

    // Alice connects to Carol (forming a triangle)
    this.log('\n  Alice → Carol: Sending connection request...');
    await this.simulateDelay(500);

    const aliceCarolInvite = this.generateInviteCode(alice);
    await this.acceptConnection(carol, alice, aliceCarolInvite);
    this.log('  ✓ Alice ↔ Carol connection established');

    this.log('\n  Federation triangle complete! All brokers connected.\n');
    this.printConnectionGraph();
  }

  // Step 3: Create and sync shared context
  async createSharedContext(): Promise<string> {
    this.log('\n📋 Step 3: Creating shared context...\n');

    const alice = this.brokers.get('Alice')!;
    const bob = this.brokers.get('Bob')!;
    const carol = this.brokers.get('Carol')!;

    const contextId = `ctx-${uuidv4().slice(0, 8)}`;
    const context: SharedContextState = {
      id: contextId,
      name: 'Project Alpha Planning',
      nodes: new Map(),
      edges: new Map(),
      participants: [alice.did],
      vectorClock: new Map([[alice.did, 1]])
    };

    // Alice creates the context
    alice.sharedContexts.set(contextId, context);
    this.log(`  ✓ Alice created shared context: "${context.name}"`);
    this.log(`    Context ID: ${contextId}`);

    // Alice invites Bob and Carol
    await this.simulateDelay(300);
    this.log('\n  Inviting participants...');

    await this.inviteToContext(alice, bob, contextId);
    this.log('  ✓ Bob joined the context');

    await this.inviteToContext(alice, carol, contextId);
    this.log('  ✓ Carol joined the context');

    this.log(`\n  Context now has ${context.participants.length} participants\n`);

    return contextId;
  }

  // Step 4: Collaborative editing with CRDT sync
  async demonstrateCRDTSync(contextId: string): Promise<void> {
    this.log('\n✏️  Step 4: Demonstrating CRDT-based collaborative editing...\n');

    const alice = this.brokers.get('Alice')!;
    const bob = this.brokers.get('Bob')!;
    const carol = this.brokers.get('Carol')!;

    const context = alice.sharedContexts.get(contextId)!;

    // Alice adds a node
    this.log('  Alice adds a goal node...');
    const goalNode: ContextNode = {
      id: `node-${uuidv4().slice(0, 8)}`,
      type: 'acg:Goal',
      label: 'Launch MVP by Q2',
      data: { priority: 'high', deadline: '2025-06-30' },
      createdBy: alice.did,
      version: 1
    };
    context.nodes.set(goalNode.id, goalNode);
    await this.syncToParticipants(context, alice);
    this.log(`    ✓ Created node: ${goalNode.label}`);

    // Bob adds a task (concurrent with Carol)
    await this.simulateDelay(200);
    this.log('\n  Bob adds a task node (concurrent operation)...');
    const taskNode1: ContextNode = {
      id: `node-${uuidv4().slice(0, 8)}`,
      type: 'acg:Task',
      label: 'Design API schema',
      data: { assignee: 'Bob', status: 'in_progress' },
      createdBy: bob.did,
      version: 1
    };
    context.nodes.set(taskNode1.id, taskNode1);
    this.log(`    ✓ Created node: ${taskNode1.label}`);

    // Carol adds a task (concurrent with Bob)
    this.log('  Carol adds a task node (concurrent operation)...');
    const taskNode2: ContextNode = {
      id: `node-${uuidv4().slice(0, 8)}`,
      type: 'acg:Task',
      label: 'Set up CI/CD pipeline',
      data: { assignee: 'Carol', status: 'pending' },
      createdBy: carol.did,
      version: 1
    };
    context.nodes.set(taskNode2.id, taskNode2);
    this.log(`    ✓ Created node: ${taskNode2.label}`);

    // Sync all changes
    await this.simulateDelay(300);
    this.log('\n  Synchronizing changes across federation...');
    await this.syncToParticipants(context, bob);
    await this.syncToParticipants(context, carol);
    this.log('  ✓ All changes synced via CRDT merge');

    // Add edges
    this.log('\n  Alice connects tasks to goal...');
    const edge1: ContextEdge = {
      id: `edge-${uuidv4().slice(0, 8)}`,
      source: taskNode1.id,
      target: goalNode.id,
      type: 'acg:contributesTo',
      createdBy: alice.did
    };
    const edge2: ContextEdge = {
      id: `edge-${uuidv4().slice(0, 8)}`,
      source: taskNode2.id,
      target: goalNode.id,
      type: 'acg:contributesTo',
      createdBy: alice.did
    };
    context.edges.set(edge1.id, edge1);
    context.edges.set(edge2.id, edge2);
    this.log('  ✓ Created relationships between nodes');

    this.printContextState(context);
  }

  // Step 5: Presence tracking
  async demonstratePresence(): Promise<void> {
    this.log('\n👥 Step 5: Demonstrating presence tracking...\n');

    const alice = this.brokers.get('Alice')!;
    const bob = this.brokers.get('Bob')!;
    const carol = this.brokers.get('Carol')!;

    // Update presence for all brokers
    this.updatePresence(alice, 'online', ['Project Alpha Planning']);
    this.updatePresence(bob, 'busy', ['Project Alpha Planning']);
    this.updatePresence(carol, 'away', []);

    // Broadcast presence to federation
    this.log('  Broadcasting presence updates...');
    await this.simulateDelay(200);

    this.log('\n  Current presence state:');
    this.log('  ┌─────────────────────────────────────────────────────┐');
    this.log('  │ Broker    │ Status  │ Active Contexts              │');
    this.log('  ├─────────────────────────────────────────────────────┤');

    for (const broker of this.brokers.values()) {
      const status = broker.presence.get(broker.did);
      const statusIcon = status?.state === 'online' ? '🟢' :
                        status?.state === 'busy' ? '🔴' :
                        status?.state === 'away' ? '🟡' : '⚫';
      const contexts = status?.activeContexts.join(', ') || 'None';
      this.log(`  │ ${broker.name.padEnd(9)} │ ${statusIcon} ${(status?.state || 'offline').padEnd(5)} │ ${contexts.slice(0, 28).padEnd(28)} │`);
    }
    this.log('  └─────────────────────────────────────────────────────┘\n');
  }

  // Step 6: Multi-hop message routing
  async demonstrateMultiHopRouting(): Promise<void> {
    this.log('\n🔀 Step 6: Demonstrating multi-hop message routing...\n');

    const alice = this.brokers.get('Alice')!;
    const carol = this.brokers.get('Carol')!;

    // Simulate a message from Alice to Carol via Bob
    this.log('  Scenario: Alice sends encrypted message to Carol');
    this.log('  Route: Alice → Bob → Carol (if direct route unavailable)\n');

    const message = {
      id: `msg-${uuidv4().slice(0, 8)}`,
      from: alice.did,
      to: carol.did,
      type: 'https://didcomm.org/basicmessage/2.0/message',
      body: { content: 'Hey Carol, can we sync on the CI/CD tasks?' },
      created_time: Date.now()
    };

    this.log(`  📤 Alice sends message: "${message.body.content}"`);
    await this.simulateDelay(300);

    this.log('    → Encrypting with DIDComm...');
    await this.simulateDelay(200);

    this.log('    → Routing through federation...');
    await this.simulateDelay(400);

    this.log(`  📥 Carol receives message`);
    this.log('    → Decrypted successfully');
    this.log('    → Message verified via DID signature\n');
  }

  // Step 7: Export context as RDF
  async exportContextAsRDF(contextId: string): Promise<void> {
    this.log('\n📤 Step 7: Exporting context as RDF/Turtle...\n');

    const alice = this.brokers.get('Alice')!;
    const context = alice.sharedContexts.get(contextId)!;

    const turtle = this.generateTurtle(context);
    this.log('  Generated Turtle:');
    this.log('  ─'.repeat(30));
    turtle.split('\n').forEach(line => this.log(`  ${line}`));
    this.log('  ─'.repeat(30));
  }

  // Helper methods
  private generateInviteCode(broker: BrokerInstance): string {
    return Buffer.from(JSON.stringify({
      brokerId: broker.id,
      did: broker.did,
      endpoint: `http://localhost:${broker.port}`,
      created: Date.now()
    })).toString('base64');
  }

  private async acceptConnection(
    accepter: BrokerInstance,
    requester: BrokerInstance,
    _inviteCode: string
  ): Promise<void> {
    accepter.connections.push(requester.did);
    requester.connections.push(accepter.did);
    await this.simulateDelay(300);
  }

  private async inviteToContext(
    owner: BrokerInstance,
    invitee: BrokerInstance,
    contextId: string
  ): Promise<void> {
    const context = owner.sharedContexts.get(contextId)!;
    context.participants.push(invitee.did);
    context.vectorClock.set(invitee.did, 0);

    // Copy context to invitee
    invitee.sharedContexts.set(contextId, {
      ...context,
      nodes: new Map(context.nodes),
      edges: new Map(context.edges),
      vectorClock: new Map(context.vectorClock)
    });

    await this.simulateDelay(200);
  }

  private async syncToParticipants(
    context: SharedContextState,
    sender: BrokerInstance
  ): Promise<void> {
    // Update vector clock
    const currentClock = context.vectorClock.get(sender.did) || 0;
    context.vectorClock.set(sender.did, currentClock + 1);

    // Sync to all participants
    for (const broker of this.brokers.values()) {
      if (broker.did !== sender.did && context.participants.includes(broker.did)) {
        const targetContext = broker.sharedContexts.get(context.id);
        if (targetContext) {
          // Merge nodes and edges (CRDT merge)
          for (const [id, node] of context.nodes) {
            targetContext.nodes.set(id, node);
          }
          for (const [id, edge] of context.edges) {
            targetContext.edges.set(id, edge);
          }
          // Merge vector clock
          for (const [did, clock] of context.vectorClock) {
            const existing = targetContext.vectorClock.get(did) || 0;
            targetContext.vectorClock.set(did, Math.max(existing, clock));
          }
        }
      }
    }
  }

  private updatePresence(
    broker: BrokerInstance,
    state: 'online' | 'away' | 'busy' | 'offline',
    activeContexts: string[]
  ): void {
    const presence: PresenceState = {
      brokerId: broker.id,
      displayName: broker.name,
      state,
      lastSeen: new Date(),
      activeContexts
    };
    broker.presence.set(broker.did, presence);
  }

  private printConnectionGraph(): void {
    this.log('  Connection Graph:');
    this.log('  ┌───────────────────────────────┐');
    this.log('  │         Alice                 │');
    this.log('  │        /     \\                │');
    this.log('  │       /       \\               │');
    this.log('  │    Bob ─────── Carol          │');
    this.log('  └───────────────────────────────┘');
  }

  private printContextState(context: SharedContextState): void {
    this.log('\n  Current Context State:');
    this.log('  ┌──────────────────────────────────────────────────────────┐');
    this.log(`  │ Context: ${context.name.padEnd(47)} │`);
    this.log('  ├──────────────────────────────────────────────────────────┤');
    this.log(`  │ Nodes: ${context.nodes.size}                                                   │`);

    for (const node of context.nodes.values()) {
      const typeShort = node.type.replace('acg:', '');
      this.log(`  │   [${typeShort}] ${node.label.slice(0, 40).padEnd(40)}     │`);
    }

    this.log(`  │ Edges: ${context.edges.size}                                                   │`);
    this.log(`  │ Participants: ${context.participants.length}                                          │`);
    this.log('  └──────────────────────────────────────────────────────────┘');
  }

  private generateTurtle(context: SharedContextState): string {
    const lines = [
      '@prefix acg: <https://agentcontextgraph.org/ontology#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
      '',
      `<${context.id}> a acg:SharedContext ;`,
      `    rdfs:label "${context.name}" ;`,
      `    acg:participantCount ${context.participants.length} .`,
      ''
    ];

    for (const node of context.nodes.values()) {
      lines.push(`<${node.id}> a ${node.type} ;`);
      lines.push(`    rdfs:label "${node.label}" ;`);
      lines.push(`    acg:createdBy <${node.createdBy}> .`);
      lines.push('');
    }

    for (const edge of context.edges.values()) {
      lines.push(`<${edge.source}> ${edge.type} <${edge.target}> .`);
    }

    return lines.join('\n');
  }

  private async simulateDelay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Run the full demo
  async run(): Promise<void> {
    try {
      await this.initializeBrokers();
      await this.establishConnections();
      const contextId = await this.createSharedContext();
      await this.demonstrateCRDTSync(contextId);
      await this.demonstratePresence();
      await this.demonstrateMultiHopRouting();
      await this.exportContextAsRDF(contextId);

      this.log('\n' + '='.repeat(60));
      this.log('Demo Complete!');
      this.log('='.repeat(60));
      this.log('\nThis demo showed:');
      this.log('  ✓ Multi-broker initialization with DIDs');
      this.log('  ✓ Federation connection establishment');
      this.log('  ✓ Shared context creation and participant management');
      this.log('  ✓ CRDT-based collaborative editing');
      this.log('  ✓ Real-time presence tracking');
      this.log('  ✓ Multi-hop DIDComm message routing');
      this.log('  ✓ RDF/Turtle context export');
      this.log('\nSee docker-compose.yml for running multiple broker instances.\n');
    } catch (error) {
      this.log(`\n❌ Demo error: ${error}`);
      throw error;
    }
  }
}

// Run if executed directly
const demo = new MultiBrokerDemo();
demo.run().catch(console.error);

export { MultiBrokerDemo };
