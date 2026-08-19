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

// 세션 본문 전체 재렌더(renderBodySpans)는 스크롤 복원 경로를 반드시 통과해야 한다.
// 새 재렌더 진입점이 복원을 잊으면 "스크롤이 맨 위로" 회귀가 되살아난다 —
// 같은 줄의 preserveReadingPosition(...) 이거나, 바로 앞 줄에 누가 스크롤을
// 책임지는지 밝히는 `// scroll-owner:` 주석이 있어야 한다 (회귀금지: 세션창/스크롤).
const sessionViewPath = path.join(root, "src", "views", "session-view.ts");
const sessionViewText = readFileSync(sessionViewPath, "utf8");
const sessionViewLines = sessionViewText.split(/\r?\n/);
const unowned = [];
sessionViewLines.forEach((line, i) => {
  if (!/\bthis\.renderBodySpans\(\)/.test(line)) return;
  if (/preserveReadingPosition\s*\(/.test(line)) return;
  if (/^\s*\/\/\s*scroll-owner:/.test(sessionViewLines[i - 1] ?? "")) return;
  unowned.push(i + 1);
});
assert.deepEqual(
  unowned,
  [],
  "renderBodySpans() 호출은 preserveReadingPosition 을 통과하거나 바로 앞 줄에 " +
    "`// scroll-owner:` 주석으로 스크롤 복원 주체를 밝혀야 합니다 " +
    `(src/views/session-view.ts:${unowned.join(", ")})`
);

// AI 에게 가는 본문은 `util/ai-body-text.ts` 한 창구를 거친다. 서비스/확장이 본문을
// 직접 재구성하면(`buildSpans` 등) "AI에게 숨김" 구간이 그 경로로 되살아나고, 지난 시점
// 본문을 되감아 만들면 나중에 지운 대목까지 되살아난다 — 요약·로어북 자동 생성·스텔라
// 폰이 실제로 그렇게 샜다(회귀금지: 노드 부가 정보/숨김). 표시·오프셋 계산처럼 원문이
// 필요한 자리는 바로 앞 줄(또는 같은 줄)에 `// body-raw: 이유` 주석으로 밝힌다.
const bodyRawFiles = [
  ...walk(path.join(root, "src", "services")),
  ...walk(path.join(root, "src", "extensions")),
].filter((p) => p.endsWith(".ts"));
const rawBodyCalls = /\b(?:buildSpans|spansExcludingNodes|buildNodeSegments)\s*\(/;
const unmarked = [];
for (const file of bodyRawFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!rawBodyCalls.test(line)) return;
    if (/\/\/\s*body-raw:/.test(line)) return;
    if (/^\s*\/\/\s*body-raw:/.test(lines[i - 1] ?? "")) return;
    unmarked.push(`${path.relative(root, file)}:${i + 1}`);
  });
}
assert.deepEqual(
  unmarked,
  [],
  "서비스/확장이 본문을 직접 재구성하고 있습니다. AI 에게 보낼 본문은 " +
    "util/ai-body-text.ts (sendableText/sendablePassage/hiddenNodesOf) 를 쓰고, " +
    "표시·오프셋 용도라면 앞 줄에 `// body-raw: 이유` 를 남기세요:\n" +
    unmarked.join("\n")
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
