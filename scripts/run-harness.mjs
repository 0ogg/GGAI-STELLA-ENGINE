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
  "message-format",
  "repetition",
  "branch-map",
  "illustration-anchors",
  "image-char-prompts",
  "card-instructions",
  "qr-jjangdol",
  "trim-incomplete",
  "write-queue",
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

  // 컴파일 결과는 임시 폴더에 있어 프로젝트 node_modules 가 안 보인다 —
  // NODE_PATH 로 알려준다(marked 같은 실제 의존성을 쓰는 테스트용).
  const env = {
    ...process.env,
    NODE_PATH: path.join(root, "node_modules"),
  };
  for (const name of testNames) {
    execFileSync(process.execPath, [path.join(outDir, "tests", `${name}.test.js`)], {
      stdio: "inherit",
      env,
    });
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
