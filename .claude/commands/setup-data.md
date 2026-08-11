---
description: Connect Heap Connect warehouse data sources to the Heap MCP server
---

Invoke the `setup_data` prompt from the connected Heap MCP server (it appears as `/mcp__<server-key>__setup_data`, e.g. `/mcp__heap__setup_data`) and follow its guided flow to register a BigQuery, Snowflake, or Redshift data source.

If the Heap MCP server is not connected yet, first help the user add it to their MCP client config (see the README's Quick start), then invoke the prompt.
