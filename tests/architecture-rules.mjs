import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

const guardedFiles = [
  path.join(root, "src", "main.ts"),
  ...walk(path.join(root, "src", "views")).filter((p) => p.endsWith(".ts")),
];

const forbiddenWrites = [
  {
    name: "View/main must not write files through app.vault",
    pattern:
      /\b(?:this\.|plugin\.)?app\.vault\.(?:create|createFolder|createBinary|modify|modifyBinary|trash|delete|rename|copy)\s*\(/g,
  },
  {
    name: "View/main must not move files through fileManager",
    pattern: /\bfileManager\.renameFile\s*\(/g,
  },
  {
    name: "View/main must not import the raw import pipeline",
    pattern: /import\s+\{[^}]*\bimportFile\b[^}]*\}\s+from\s+["'][^"']*import["']/g,
  },
];

const failures = [];
for (const file of guardedFiles) {
  const text = readFileSync(file, "utf8");
  for (const rule of forbiddenWrites) {
    for (const match of text.matchAll(rule.pattern)) {
      failures.push({
        file: path.relative(root, file),
        line: lineOf(text, match.index ?? 0),
        rule: rule.name,
        snippet: match[0],
      });
    }
  }
}

assert.deepEqual(
  failures,
  [],
  "Architecture rule violations:\n" +
    failures
      .map((f) => `${f.file}:${f.line} ${f.rule} (${f.snippet})`)
      .join("\n")
);

const storeText = readFileSync(path.join(root, "src", "state", "store.ts"), "utf8");
assert.match(storeText, /async\s+importFile\s*\(/, "Store must expose importFile().");
assert.match(
  storeText,
  /async\s+copyScenarioForSession\s*\(/,
  "Store must expose copyScenarioForSession()."
);

console.log("architecture rules harness passed");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}
