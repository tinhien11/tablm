#!/usr/bin/env node
// Gateway entrypoint - kept at src/gateway.ts so the built dist/gateway.js path
// stays stable for the installed launchers. All logic lives in src/gateway/server.ts.
import "./gateway/server.js";
