#!/usr/bin/env node
// Compatibility shim: Claude Code registrations (~/.claude.json) and README instructions point at
// this path. The server lives in ./server.ts (Node runs it directly). New registrations should use
// server.ts; this file stays so existing ones keep working.
import "./server.ts";
