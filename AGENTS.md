# mcp-server instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Use npm only and commit this repository's own `package-lock.json` when application code begins.
- Do not add application code until Phase 4 is explicitly started.
- Use stable meta-tools rather than one MCP tool per Facet.
- Pin and re-verify the official MCP SDK/protocol version before implementation.
- Never implement a second execution or payment state machine here.
