import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const outDir = await mkdtemp(path.join(tmpdir(), "stella-harness-"));
const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
const architectureEntry = path.join(root, "tests", "architecture-rules.mjs");
const testEntry = path.join(root, "tests", "session-view-logic.test.ts");
const compiledEntry = path.join(outDir, "tests", "session-view-logic.test.js");

try {
  execFileSync(process.execPath, [architectureEntry], { cwd: root, stdio: "inherit" });

  execFileSync(
    process.execPath,
    [
      tscBin,
      "--module",
      "CommonJS",
      "--target",
      "ES2020",
      "--moduleResolution",
      "node",
      "--skipLibCheck",
      "--strictNullChecks",
      "--esModuleInterop",
      "--rootDir",
      root,
      "--outDir",
      outDir,
      testEntry,
    ],
    { cwd: root, stdio: "inherit" }
  );

  execFileSync(process.execPath, [compiledEntry], { stdio: "inherit" });
} finally {
  await rm(outDir, { recursive: true, force: true });
}
