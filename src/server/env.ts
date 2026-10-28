import { existsSync } from "node:fs";

// Imported first by server.ts, so .env is in place before any module reads
// process.env. Variables already set in the environment win over the file.
if (existsSync(".env")) process.loadEnvFile(".env");
