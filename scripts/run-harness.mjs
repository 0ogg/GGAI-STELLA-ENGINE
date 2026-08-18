import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const outDir = await mkdtemp(path.join(tmpdir(), "stella-harness-"));
const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
const architectureEntry = path.join(root, "tests", "architecture-rules.mjs");
const testNames = [
  "session-view-logic",
  "translate-key-scope",
  "pending-reflections",
  "variables",
  "lorebook-template",
  "safe-html",
  "repetition",
  "branch-map",
];
const testEntries = testNames.map((n) => path.join(root, "tests", `${n}.test.ts`));

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
      ...testEntries,
    ],
    { cwd: root, stdio: "inherit" }
  );

  for (const name of testNames) {
    execFileSync(process.execPath, [path.join(outDir, "tests", `${name}.test.js`)], {
      stdio: "inherit",
    });
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
