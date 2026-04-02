# MemOS Cloud OpenClaw Plugin Hooks

This plugin registers the following OpenClaw lifecycle hooks to interact with MemOS Cloud:

- `before_agent_start`: Intercepts the agent startup sequence to recall relevant memories from MemOS Cloud and injects them into the agent's context.
- `agent_end`: Intercepts the agent termination sequence to capture the completed conversation turn and saves it to MemOS Cloud.
