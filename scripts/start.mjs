#!/usr/bin/env node
/**
 * Cross-platform production start.
 *
 * `NODE_ENV=production node server/index.js` only works in POSIX shells.
 * This wrapper sets the variable in JavaScript so `npm start` behaves the
 * same in PowerShell, cmd.exe, macOS, and Linux.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "production";
await import("../server/index.js");
