/**
 * 배포 자동화 스크립트. `npm run deploy` = 소스가 이미 커밋/푸시된 상태에서,
 * manifest.json 버전 태그로 GitHub Release 를 만들고 release/ 산출물을 자산으로 올린다
 * (이미 있는 버전이면 자산만 갱신).
 *
 * 소스 레포와 배포 레포가 하나로 합쳐졌으므로(2026-07-07) 별도 클론/커밋 단계는 없다.
 * `gh` CLI 로그인이 되어 있어야 한다.
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";

const PLUGIN_FOLDER = "obsidian-ggai-stella-engine";
const REPO_SLUG = "0ogg/GGAI-STELLA-ENGINE";
const REQUIRED = ["main.js", "manifest.json"];
const OPTIONAL = ["styles.css"];

function run(cmd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { stdio: "pipe" }).toString();
}

function tryRun(cmd) {
  try {
    return { ok: true, out: run(cmd) };
  } catch (e) {
    return { ok: false, out: e.stdout?.toString() ?? e.message };
  }
}

const dirty = run("git status --porcelain").trim();
if (dirty) {
  console.error(
    "[deploy] 커밋되지 않은 변경이 있습니다. 먼저 커밋(git commit)하고 다시 실행하세요.\n" +
      dirty,
  );
  process.exit(1);
}

const branch = run("git rev-parse --abbrev-ref HEAD").trim();
run(`git push origin ${branch}`);

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;

const releaseDir = path.join("release", PLUGIN_FOLDER);
const filesToUpload = [...REQUIRED, ...OPTIONAL].filter((f) =>
  existsSync(path.join(releaseDir, f)),
);
if (filesToUpload.length < REQUIRED.length) {
  console.error(`[deploy] ${releaseDir} 에 산출물이 없습니다. 'npm run release' 먼저 실행하세요.`);
  process.exit(1);
}

const assetArgs = filesToUpload.map((f) => `"${path.join(releaseDir, f)}"`).join(" ");
const tagCheck = tryRun(`gh release view ${version} --repo ${REPO_SLUG}`);
if (tagCheck.ok) {
  console.log(`[deploy] ${version} 릴리즈가 이미 있음 → 자산만 갱신`);
  run(`gh release upload ${version} ${assetArgs} --repo ${REPO_SLUG} --clobber`);
} else {
  run(
    `gh release create ${version} ${assetArgs} --title "${version}" --notes "${manifest.name} ${version}" --repo ${REPO_SLUG}`,
  );
}

console.log(`\n[deploy] 완료: https://github.com/${REPO_SLUG}/releases/tag/${version}\n`);
