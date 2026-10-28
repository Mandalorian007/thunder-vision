// node-pty 1.1.0 ships its macOS spawn-helper prebuilds without the execute bit,
// which makes every spawn fail with "posix_spawnp failed".
import { chmodSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("node-pty/package.json"));

for (const arch of ["darwin-arm64", "darwin-x64"]) {
  const helper = join(root, "prebuilds", arch, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
