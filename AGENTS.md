# mcp-server instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Use npm only and commit this repository's own `package-lock.json` when application code begins.
- ADR-0011 permits local stdio MCP meta-tools for the supervised Demo Track before formal Phase 4. Hosted MCP/OAuth remains deferred.
- Use stable meta-tools rather than one MCP tool per Facet.
- Pin and re-verify the official MCP SDK/protocol version before implementation.
- Never implement a second execution or payment state machine here.
