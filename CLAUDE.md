@AGENTS.md

## Claude Code notes

- Several Claude sessions often work in this repo at once (web, bot, sdk, mcp). Stay in your assigned files, and
  never stop servers or bots you did not start.
- Run your own `next dev` on a free port with its own `NEXT_DIST_DIR`, then revert Next's edits to
  `web/tsconfig.json` / `web/next-env.d.ts` and delete the dist dir.
- To check the product the way an agent would: read `/llms.txt`, then `/api/health`. The Lotus MCP server
  (`mcp/README.md`) can be added with `claude mcp add`.
- Put screenshots and scratch files in your scratchpad, not in the repo.
