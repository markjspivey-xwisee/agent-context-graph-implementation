# Getting Started with Agent Context Graph

This guide will help you set up and start using the Agent Context Graph (ACG) system.

## Prerequisites

- Node.js 20 or later
- npm 9 or later
- Git

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/markjspivey-xwisee/agent-context-graph.git
cd agent-context-graph
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Run the Server

```bash
npm start
```

The server starts on `http://localhost:3000`.

### 4. Verify Installation

```bash
curl http://localhost:3000/health
# Returns: {"status":"healthy","timestamp":"..."}
```

## Running with Docker

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Core Concepts

### Abstract Agent Types (AAT)

AATs define behavioral contracts for agents:

| Type | Purpose | Constraints |
|------|---------|-------------|
| **Observer** | Watch and report | No side effects |
| **Planner** | Create plans | Cannot execute |
| **Executor** | Execute plans | Requires approval |
| **Arbiter** | Approve/deny actions | Singleton |
| **Archivist** | Store knowledge | Append-only |

### Context Graphs

A Context Graph provides an agent with:
- Available **affordances** (actions they can take)
- Current **situation** awareness
- Required **credentials**

Example request:
```bash
curl -X POST http://localhost:3000/context \
  -H "Content-Type: application/json" \
  -d '{
    "agentDID": "did:key:z6MkExample...",
    "agentType": "planner",
    "goal": "Research AI safety papers",
    "capabilities": ["web_search", "document_analysis"]
  }'
```

### Traversing Affordances

Execute an action from the Context Graph:
```bash
curl -X POST http://localhost:3000/traverse \
  -H "Content-Type: application/json" \
  -d '{
    "contextId": "ctx_abc123",
    "affordanceId": "aff_search_001",
    "parameters": {"query": "RLHF alignment techniques"}
  }'
```

## Personal Broker

Each user has a Personal Broker that manages:
- **Conversations** - Chat history across channels
- **Memory** - Facts, preferences, procedures
- **Contacts** - DID-based address book
- **Presence** - Online status

### Start a Conversation

```bash
# Create conversation
curl -X POST http://localhost:3000/broker/conversations \
  -H "Content-Type: application/json" \
  -d '{"title": "Research Discussion"}'

# Send message
curl -X POST http://localhost:3000/broker/conversations/{id}/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "What are the latest AI safety papers?", "role": "user"}'
```

### Store Memory

```bash
curl -X POST http://localhost:3000/broker/memory \
  -H "Content-Type: application/json" \
  -d '{
    "type": "preference",
    "content": "User prefers morning meetings",
    "importance": 0.8,
    "tags": ["schedule", "preference"]
  }'
```

## Social Federation

Connect your broker with others:

### Create a Connection

```bash
# Request connection
curl -X POST http://localhost:3000/social/connections/request \
  -H "Content-Type: application/json" \
  -d '{"toBrokerId": "broker-bob-123", "message": "Lets collaborate!"}'

# Or create an invite link
curl -X POST http://localhost:3000/social/invites \
  -H "Content-Type: application/json" \
  -d '{"maxUses": 5, "expiresInHours": 24}'
```

### Create a Group

```bash
curl -X POST http://localhost:3000/social/groups \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI Safety Researchers",
    "description": "Collaborative research group",
    "isPublic": false
  }'
```

## Shared Contexts

Create collaborative workspaces:

```bash
# Create shared context
curl -X POST http://localhost:3000/contexts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Research Project",
    "description": "AI Safety Research",
    "syncStrategy": "crdt"
  }'

# Add a node
curl -X POST http://localhost:3000/contexts/{id}/nodes \
  -H "Content-Type: application/json" \
  -d '{
    "type": "Finding",
    "data": {"title": "Key insight", "confidence": 0.9}
  }'

# Add an edge
curl -X POST http://localhost:3000/contexts/{id}/edges \
  -H "Content-Type: application/json" \
  -d '{
    "sourceId": "node_1",
    "targetId": "node_2",
    "type": "supports"
  }'
```

## Real-time Sync

Connect via WebSocket for live updates:

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

// Authenticate
ws.send(JSON.stringify({
  type: 'auth',
  payload: { brokerId: 'broker-abc123' }
}));

// Subscribe to context changes
ws.send(JSON.stringify({
  type: 'subscribe',
  payload: { channel: 'context', contextId: 'ctx-xyz789' }
}));

// Receive updates
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Update:', message);
};
```

## SPARQL Queries

Query the RDF trace store:

```bash
curl -X POST http://localhost:3000/sparql \
  -H "Content-Type: application/json" \
  -d '{
    "query": "SELECT ?agent ?action WHERE { ?activity prov:wasAssociatedWith ?agent ; prov:used ?action } LIMIT 10"
  }'
```

## CLI Commands

```bash
# Validate context graphs
npm run cli validate examples/golden-path/planner-context.json

# Check federation status
npm run cli federate status

# List checkpoints
npm run cli checkpoint list

# Interactive chat
npm run cli chat
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `LOG_LEVEL` | Logging level | info |
| `DATA_DIR` | Data directory | ./data |
| `ANTHROPIC_API_KEY` | For agent reasoning | - |

## Next Steps

1. **Explore the Dashboard**: Open `http://localhost:3000` in your browser
2. **Read the API Docs**: See [protocol/API.md](../protocol/API.md) for complete endpoint reference
3. **Try the Examples**: Check `examples/` for workflow demos
4. **Run the Tests**: `npm run test:run`

## Troubleshooting

### Build Errors

```bash
# Clear cache and rebuild
rm -rf node_modules dist
npm install
npm run build
```

### Port Already in Use

```bash
# Use a different port
PORT=3001 npm start
```

### WebSocket Connection Failed

Ensure no firewall is blocking WebSocket connections on port 3000.

## Getting Help

- [GitHub Issues](https://github.com/markjspivey-xwisee/agent-context-graph/issues)
- [API Documentation](../protocol/API.md)
- [Architecture Guide](../architecture/ARCHITECTURE_INDEX.md)
