#!/usr/bin/env tsx
/**
 * Multi-Agent Federation Workflow Example
 *
 * Demonstrates a collaborative workflow where multiple personal brokers
 * work together on a shared context using federation, CRDTs, and
 * real-time synchronization.
 *
 * Scenario: Research Team Collaboration
 * - Alice (Research Lead) creates a shared research context
 * - Bob (Analyst) joins and adds findings
 * - Carol (Editor) joins and organizes content
 * - All changes sync in real-time with CRDT conflict resolution
 */

import { PersonalBroker, PersonalBrokerRegistry } from '../src/services/personal-broker.js';
import { SocialFederationService } from '../src/services/social-federation.js';
import { SharedContextService } from '../src/services/shared-context.js';
import { DIDCommMessagingService } from '../src/services/didcomm-messaging.js';
import { ActivityPubBridge } from '../src/services/activitypub-bridge.js';

// ANSI colors for console output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

function log(actor: string, message: string, color: keyof typeof colors = 'reset'): void {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${colors.dim}[${timestamp}]${colors.reset} ${colors.bold}${actor}:${colors.reset} ${colors[color]}${message}${colors.reset}`);
}

function section(title: string): void {
  console.log();
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}  ${title}${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log();
}

async function runFederationWorkflow(): Promise<void> {
  console.log();
  console.log(`${colors.magenta}${colors.bold}`);
  console.log('  ╔═══════════════════════════════════════════════════════╗');
  console.log('  ║   ACG Multi-Agent Federation Workflow Demo            ║');
  console.log('  ║   Research Team Collaboration Scenario                ║');
  console.log('  ╚═══════════════════════════════════════════════════════╝');
  console.log(`${colors.reset}`);

  // ==========================================================================
  // Initialize Services
  // ==========================================================================
  section('1. Initializing Services');

  const registry = new PersonalBrokerRegistry();
  const federation = new SocialFederationService();
  const sharedContexts = new SharedContextService();

  log('System', 'Services initialized', 'green');

  // ==========================================================================
  // Create Personal Brokers
  // ==========================================================================
  section('2. Creating Personal Brokers');

  // Alice - Research Lead
  const alice = registry.createBroker({
    displayName: 'Alice (Research Lead)',
    ownerDID: 'did:key:alice123',
    timezone: 'America/New_York',
    locale: 'en-US'
  });
  log('Alice', 'Personal broker created', 'cyan');

  // Bob - Analyst
  const bob = registry.createBroker({
    displayName: 'Bob (Analyst)',
    ownerDID: 'did:key:bob456',
    timezone: 'America/Chicago',
    locale: 'en-US'
  });
  log('Bob', 'Personal broker created', 'yellow');

  // Carol - Editor
  const carol = registry.createBroker({
    displayName: 'Carol (Editor)',
    ownerDID: 'did:key:carol789',
    timezone: 'America/Los_Angeles',
    locale: 'en-US'
  });
  log('Carol', 'Personal broker created', 'magenta');

  // ==========================================================================
  // Create Social Profiles
  // ==========================================================================
  section('3. Setting Up Social Federation');

  const aliceProfile = federation.createProfile(alice);
  log('Alice', `Profile created: ${aliceProfile.displayName}`, 'cyan');

  const bobProfile = federation.createProfile(bob);
  log('Bob', `Profile created: ${bobProfile.displayName}`, 'yellow');

  const carolProfile = federation.createProfile(carol);
  log('Carol', `Profile created: ${carolProfile.displayName}`, 'magenta');

  // ==========================================================================
  // Establish Connections
  // ==========================================================================
  section('4. Establishing Federation Connections');

  // Alice creates an invite for the team
  const invite = federation.createInviteLink(alice.id, {
    maxUses: 5,
    expiresInHours: 24
  });
  log('Alice', `Created invite link: ${invite.code}`, 'cyan');

  // Bob uses the invite
  const bobConnection = await federation.useInviteLink(invite.code, bob);
  log('Bob', `Connected to Alice's network`, 'yellow');

  // Carol uses the invite
  const carolConnection = await federation.useInviteLink(invite.code, carol);
  log('Carol', `Connected to Alice's network`, 'magenta');

  // ==========================================================================
  // Create Shared Research Context
  // ==========================================================================
  section('5. Creating Shared Research Context');

  const researchContext = sharedContexts.createContext(alice.id, {
    name: 'AI Safety Research Project',
    description: 'Collaborative research on AI alignment and safety',
    syncStrategy: 'crdt',
    conflictResolution: 'auto_merge',
    isPublic: false
  });
  log('Alice', `Created shared context: ${researchContext.name}`, 'cyan');

  // Grant access to Bob and Carol
  sharedContexts.grantAccess(researchContext.id, alice.id, bob.id, 'write');
  log('Alice', `Granted write access to Bob`, 'cyan');

  sharedContexts.grantAccess(researchContext.id, alice.id, carol.id, 'write');
  log('Alice', `Granted write access to Carol`, 'cyan');

  // ==========================================================================
  // Team Joins the Context
  // ==========================================================================
  section('6. Team Joining Shared Context');

  const aliceReplica = sharedContexts.joinContext(researchContext.id, alice.id);
  log('Alice', 'Joined the research context', 'cyan');

  const bobReplica = sharedContexts.joinContext(researchContext.id, bob.id);
  log('Bob', 'Joined the research context', 'yellow');

  const carolReplica = sharedContexts.joinContext(researchContext.id, carol.id);
  log('Carol', 'Joined the research context', 'magenta');

  // Update presence
  sharedContexts.updatePresence(researchContext.id, alice.id, { state: 'active' });
  sharedContexts.updatePresence(researchContext.id, bob.id, { state: 'active' });
  sharedContexts.updatePresence(researchContext.id, carol.id, { state: 'active' });

  const participants = sharedContexts.getActiveParticipants(researchContext.id);
  log('System', `Active participants: ${participants.map(p => p.brokerId.split(':')[0]).join(', ')}`, 'green');

  // ==========================================================================
  // Collaborative Research Workflow
  // ==========================================================================
  section('7. Collaborative Research Workflow');

  // Alice adds the project root node
  const projectNode = sharedContexts.addNode(
    researchContext.id,
    alice.id,
    'Project',
    {
      title: 'AI Safety Research 2024',
      status: 'in_progress',
      deadline: '2024-06-30'
    }
  );
  log('Alice', 'Created project root node', 'cyan');

  // Alice adds research areas
  const alignmentNode = sharedContexts.addNode(
    researchContext.id,
    alice.id,
    'ResearchArea',
    {
      name: 'AI Alignment',
      priority: 'high',
      lead: 'alice'
    }
  );
  log('Alice', 'Added AI Alignment research area', 'cyan');

  const interpretabilityNode = sharedContexts.addNode(
    researchContext.id,
    alice.id,
    'ResearchArea',
    {
      name: 'Interpretability',
      priority: 'high',
      lead: 'bob'
    }
  );
  log('Alice', 'Added Interpretability research area', 'cyan');

  // Create edges
  sharedContexts.addEdge(researchContext.id, alice.id, projectNode!.id, alignmentNode!.id, 'hasArea');
  sharedContexts.addEdge(researchContext.id, alice.id, projectNode!.id, interpretabilityNode!.id, 'hasArea');

  // Bob adds his research findings
  const finding1 = sharedContexts.addNode(
    researchContext.id,
    bob.id,
    'Finding',
    {
      title: 'RLHF Limitations Analysis',
      summary: 'RLHF shows promise but has known reward hacking vulnerabilities',
      confidence: 0.85,
      citations: ['Christiano et al. 2017', 'Stiennon et al. 2020']
    }
  );
  log('Bob', 'Added finding: RLHF Limitations Analysis', 'yellow');

  const finding2 = sharedContexts.addNode(
    researchContext.id,
    bob.id,
    'Finding',
    {
      title: 'Constitutional AI Results',
      summary: 'Constitutional AI provides promising direction for value alignment',
      confidence: 0.78,
      citations: ['Bai et al. 2022']
    }
  );
  log('Bob', 'Added finding: Constitutional AI Results', 'yellow');

  // Link findings to research areas
  sharedContexts.addEdge(researchContext.id, bob.id, alignmentNode!.id, finding1!.id, 'hasFinding');
  sharedContexts.addEdge(researchContext.id, bob.id, alignmentNode!.id, finding2!.id, 'hasFinding');

  // Carol adds editorial notes and organization
  const noteNode = sharedContexts.addNode(
    researchContext.id,
    carol.id,
    'EditorialNote',
    {
      content: 'Need to reconcile terminology between sections',
      priority: 'medium',
      assignee: 'bob',
      status: 'open'
    }
  );
  log('Carol', 'Added editorial note about terminology', 'magenta');

  sharedContexts.addEdge(researchContext.id, carol.id, finding1!.id, noteNode!.id, 'hasNote');

  // Carol organizes content into chapters
  const chapterNode = sharedContexts.addNode(
    researchContext.id,
    carol.id,
    'Chapter',
    {
      number: 1,
      title: 'Introduction to AI Alignment',
      status: 'draft',
      wordCount: 0
    }
  );
  log('Carol', 'Created Chapter 1: Introduction to AI Alignment', 'magenta');

  sharedContexts.addEdge(researchContext.id, carol.id, projectNode!.id, chapterNode!.id, 'hasChapter');
  sharedContexts.addEdge(researchContext.id, carol.id, chapterNode!.id, alignmentNode!.id, 'covers');

  // ==========================================================================
  // Simulate Concurrent Edits with CRDT Resolution
  // ==========================================================================
  section('8. Concurrent Edit Simulation (CRDT)');

  // Both Bob and Carol update the same finding simultaneously
  log('Bob', 'Updating finding confidence...', 'yellow');
  log('Carol', 'Updating finding status...', 'magenta');

  // Bob updates confidence
  const bobUpdate = sharedContexts.updateNode(
    researchContext.id,
    bob.id,
    finding1!.id,
    { confidence: 0.90 }
  );

  // Carol updates summary (concurrent)
  const carolUpdate = sharedContexts.updateNode(
    researchContext.id,
    carol.id,
    finding1!.id,
    { summary: 'RLHF shows promise but has well-documented reward hacking vulnerabilities' }
  );

  log('System', 'CRDT auto-merged concurrent updates!', 'green');

  // ==========================================================================
  // View Final Context State
  // ==========================================================================
  section('9. Final Context State');

  const allNodes = sharedContexts.getNodes(researchContext.id);
  const allEdges = sharedContexts.getEdges(researchContext.id);

  console.log(`${colors.bold}Context Summary:${colors.reset}`);
  console.log(`  Name: ${researchContext.name}`);
  console.log(`  Nodes: ${allNodes.length}`);
  console.log(`  Edges: ${allEdges.length}`);
  console.log(`  Sync Strategy: ${researchContext.syncStrategy}`);
  console.log(`  Version: ${researchContext.version}`);

  console.log();
  console.log(`${colors.bold}Nodes by Type:${colors.reset}`);
  const nodesByType: Record<string, number> = {};
  for (const node of allNodes) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(nodesByType)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log();
  console.log(`${colors.bold}Edges by Type:${colors.reset}`);
  const edgesByType: Record<string, number> = {};
  for (const edge of allEdges) {
    edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(edgesByType)) {
    console.log(`  ${type}: ${count}`);
  }

  // ==========================================================================
  // Team Notifications
  // ==========================================================================
  section('10. Federation Notifications');

  // Create some team notifications
  const aliceNotifications = federation.getNotifications(alice.id);
  const bobNotifications = federation.getNotifications(bob.id);
  const carolNotifications = federation.getNotifications(carol.id);

  log('Alice', `Has ${aliceNotifications.length} notifications`, 'cyan');
  log('Bob', `Has ${bobNotifications.length} notifications`, 'yellow');
  log('Carol', `Has ${carolNotifications.length} notifications`, 'magenta');

  // ==========================================================================
  // Export Context as JSON-LD
  // ==========================================================================
  section('11. Exporting Context');

  const exported = sharedContexts.exportContextAsJSON(researchContext.id);
  console.log(`${colors.dim}Context exported as JSON-LD (${JSON.stringify(exported).length} bytes)${colors.reset}`);

  // ==========================================================================
  // Stats Summary
  // ==========================================================================
  section('12. Workflow Complete');

  const contextStats = sharedContexts.getStats();
  console.log(`${colors.bold}Final Statistics:${colors.reset}`);
  console.log(`  Total Contexts: ${contextStats.totalContexts}`);
  console.log(`  Total Nodes: ${contextStats.totalNodes}`);
  console.log(`  Total Edges: ${contextStats.totalEdges}`);
  console.log(`  Active Replicas: ${contextStats.activeReplicas}`);

  console.log();
  console.log(`${colors.green}${colors.bold}Workflow completed successfully!${colors.reset}`);
  console.log();
}

// ==========================================================================
// DIDComm Messaging Example
// ==========================================================================

async function runDIDCommExample(): Promise<void> {
  section('13. DIDComm Encrypted Messaging (Bonus)');

  // Create DIDComm services for each participant
  const aliceDIDComm = new DIDCommMessagingService({
    did: 'did:key:alice123',
    serviceEndpoint: 'https://alice.example/didcomm'
  });

  const bobDIDComm = new DIDCommMessagingService({
    did: 'did:key:bob456',
    serviceEndpoint: 'https://bob.example/didcomm'
  });

  // Register each other's DID documents
  aliceDIDComm.registerDIDDocument('did:key:bob456', bobDIDComm.getDIDDocument()!);
  bobDIDComm.registerDIDDocument('did:key:alice123', aliceDIDComm.getDIDDocument()!);

  // Alice sends an encrypted message to Bob
  const message = aliceDIDComm.createBasicMessage(
    'Hey Bob, great work on the RLHF analysis! Can we discuss the reward hacking section?',
    ['did:key:bob456']
  );

  log('Alice', 'Created encrypted DIDComm message', 'cyan');

  // Encrypt and send
  const encrypted = await aliceDIDComm.encryptMessage(message, ['did:key:bob456']);
  log('Alice', `Message encrypted (${JSON.stringify(encrypted).length} bytes)`, 'cyan');

  // Bob decrypts
  const decrypted = await bobDIDComm.decryptMessage(encrypted);
  log('Bob', `Decrypted message: "${decrypted.body.content}"`, 'yellow');

  // Bob replies with a signed message
  const reply = bobDIDComm.createBasicMessage(
    'Thanks Alice! Happy to discuss. Should we set up a sync call?',
    ['did:key:alice123'],
    { thid: message.id }
  );

  const signed = bobDIDComm.signMessage(reply);
  log('Bob', 'Created signed reply message', 'yellow');

  // Alice verifies
  const { valid, message: verifiedMessage } = aliceDIDComm.verifySignedMessage(signed, 'did:key:bob456');
  if (valid && verifiedMessage) {
    log('Alice', `Verified reply: "${verifiedMessage.body.content}"`, 'cyan');
  }

  console.log();
  console.log(`${colors.dim}DIDComm provides end-to-end encryption and cryptographic signatures${colors.reset}`);
  console.log(`${colors.dim}for secure agent-to-agent communication in federated contexts.${colors.reset}`);
}

// ==========================================================================
// ActivityPub Federation Example
// ==========================================================================

async function runActivityPubExample(): Promise<void> {
  section('14. ActivityPub Federation (Bonus)');

  const apBridge = new ActivityPubBridge({
    domain: 'acg.example',
    baseUrl: 'https://acg.example'
  });

  // Create an ActivityPub actor for Alice
  const aliceActor = apBridge.createActor('alice-broker', {
    username: 'alice',
    displayName: 'Alice (Research Lead)',
    summary: 'AI Safety researcher. Building federated agent systems.'
  });

  log('Alice', `ActivityPub actor created: ${aliceActor.preferredUsername}@acg.example`, 'cyan');

  // Alice posts a note about the research
  const note = apBridge.createNote(aliceActor.id,
    'Excited to announce our team\'s progress on AI alignment research! ' +
    'We\'re using federated context graphs for collaborative knowledge building. ' +
    '#AISafety #Research #ACG',
    {
      tags: [
        { type: 'Hashtag', name: '#AISafety', href: 'https://acg.example/tags/AISafety' },
        { type: 'Hashtag', name: '#Research', href: 'https://acg.example/tags/Research' },
        { type: 'Hashtag', name: '#ACG', href: 'https://acg.example/tags/ACG' }
      ]
    }
  );

  log('Alice', 'Created ActivityPub note with hashtags', 'cyan');

  // Generate WebFinger response
  const webfinger = apBridge.generateWebFinger('alice');
  log('System', `WebFinger subject: ${webfinger.subject}`, 'green');

  const stats = apBridge.getStats();
  console.log();
  console.log(`${colors.dim}ActivityPub enables federation with Mastodon, Pleroma, and other${colors.reset}`);
  console.log(`${colors.dim}fediverse platforms (${stats.actors} actors registered).${colors.reset}`);
}

// ==========================================================================
// Main
// ==========================================================================

async function main(): Promise<void> {
  try {
    await runFederationWorkflow();
    await runDIDCommExample();
    await runActivityPubExample();

    console.log();
    console.log(`${colors.magenta}${colors.bold}`);
    console.log('  ╔═══════════════════════════════════════════════════════╗');
    console.log('  ║   Demo Complete! The ACG Federation System supports:  ║');
    console.log('  ║   • Personal Brokers with memory & conversations      ║');
    console.log('  ║   • Social connections with invite links              ║');
    console.log('  ║   • Shared contexts with CRDT real-time sync          ║');
    console.log('  ║   • DIDComm v2 encrypted messaging                    ║');
    console.log('  ║   • ActivityPub for fediverse integration             ║');
    console.log('  ╚═══════════════════════════════════════════════════════╝');
    console.log(`${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}Error:${colors.reset}`, error);
    process.exit(1);
  }
}

main();
