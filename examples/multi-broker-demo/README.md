# Multi-Broker Federation Demo

This demo showcases the Agent Context Graph federation capabilities with three broker instances working together.

## Overview

The demo simulates a real-world federation scenario where:
- **Alice**, **Bob**, and **Carol** each run their own personal broker
- They establish connections via invite codes
- They create shared contexts for collaboration
- Changes sync in real-time via CRDT merge
- Presence is tracked across the federation
- Messages route through DIDComm encryption

## Running the Demo

### Option 1: Single Process Simulation

```bash
cd examples/multi-broker-demo
npx ts-node demo.ts
```

### Option 2: Docker Multi-Broker Setup

```bash
# Start three broker instances
docker-compose up alice bob carol

# In separate terminals, view logs
docker-compose logs -f alice
docker-compose logs -f bob
docker-compose logs -f carol
```

### Option 3: Manual Multi-Process

```bash
# Terminal 1 - Alice
PORT=3001 BROKER_NAME=alice npm start

# Terminal 2 - Bob
PORT=3002 BROKER_NAME=bob npm start

# Terminal 3 - Carol
PORT=3003 BROKER_NAME=carol npm start
```

## Demo Flow

1. **Initialize Brokers** - Each broker starts with its own DID
2. **Establish Connections** - Form a federation triangle
3. **Create Shared Context** - Alice creates a project planning context
4. **Collaborative Editing** - All three add nodes concurrently
5. **CRDT Sync** - Changes merge without conflicts
6. **Presence Tracking** - See who's online and active
7. **Multi-Hop Routing** - Messages route through federation
8. **RDF Export** - Export context as Turtle/RDF

## Architecture

```
   ┌─────────┐
   │  Alice  │
   │  :3001  │
   └────┬────┘
        │
   ┌────┴────┐
   │         │
┌──┴──┐   ┌──┴──┐
│ Bob │───│Carol│
│:3002│   │:3003│
└─────┘   └─────┘
```

## Key Technologies

- **DID:Key** - Decentralized identifiers for broker identity
- **DIDComm v2** - Encrypted peer-to-peer messaging
- **CRDTs** - Conflict-free replicated data types for sync
- **WebSocket** - Real-time presence and notifications
- **RDF/Turtle** - Semantic context export

## Example Output

```
[12:34:56.789] =====================================
[12:34:56.789] Multi-Broker Federation Demo
[12:34:56.789] =====================================

[12:34:56.790] 📦 Step 1: Initializing broker instances...
[12:34:56.791]   ✓ Alice's broker started on port 3001
[12:34:56.791]     DID: did:key:z6Mk...
[12:34:56.792]   ✓ Bob's broker started on port 3002
[12:34:56.792]   ✓ Carol's broker started on port 3003

[12:34:56.793] 🔗 Step 2: Establishing federation connections...
[12:34:57.294]   ✓ Alice ↔ Bob connection established
[12:34:57.795]   ✓ Bob ↔ Carol connection established
[12:34:58.296]   ✓ Alice ↔ Carol connection established

[12:34:58.297] 📋 Step 3: Creating shared context...
[12:34:58.497]   ✓ Alice created shared context: "Project Alpha Planning"
```

## Next Steps

- Add more agents to the federation
- Implement group policy controls
- Add semantic search across federated contexts
- Build visualization dashboard for federation topology
