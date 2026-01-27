# Tool Authoring Example

This example shows how an agent (or admin) can register a tool in the broker registry. Tools are intended to be surfaced as affordances through Context Graphs rather than a global list.

## Files

- register-tool.json

## Suggested flow

1. Register the tool:
   - POST /broker/tools with register-tool.json
2. Ensure policy and credential gating for the registration affordance.
3. Surface a corresponding affordance in /context for eligible agents.

## Notes

- Categories must match the broker ToolCategory enum (developer, custom, etc.).
- Tool schemas should be versioned and traced like other affordances.
