# SynapseOne workflows (git-managed)

`mcp-docs-reader.json` is the canonical text of the SynapseOne docs-reader
workflow. It is also shipped as the built-in `mcp-docs-reader` SynapseFlow
template.

- Trigger: `mcpTrigger` tool `read_synapseone_docs`.
- Input: `{ "path": "docs/api.md" }` (default `docs/README.md`).
- The workflow fetches the file from the public SynapseOne GitHub repository
  and returns it as the MCP tool result.
- Activate it; MCP clients call `POST https://api.synapseone.space/mcp` with a
  SynapseOne Bearer JWT or `X-API-Key`.
- SynapseDX and the Tier-3 repos keep their own copies of this workflow in
  their own `workflows/` directories and provision them through their allowed
  tier boundary.

The built-in template and this JSON are kept in sync by the workflow-service
tests.
