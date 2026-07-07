/**
 * 배포 자동화 스크립트. `npm run deploy` = release 산출물을 배포 레포
 * (../GGAI-STELLA-ENGINE, sibling 폴더)에 복사 → 커밋 → push → manifest 버전 태그로
 * GitHub Release 생성(이미 있으면 자산만 갱신).
 *
 * 배포 레포가 로컬에 없으면 처음 한 번 clone 한다. `gh` CLI 로그인이 되어 있어야 한다.
 */
import { execSync } from "child_process";
import { copyFileSync, existsSync, readFileSync } from "fs";
import path from "path";

const PLUGIN_FOLDER = "obsidian-ggai-stella-engine";
const DEPLOY_REPO_SLUG = "0ogg/GGAI-STELLA-ENGINE";
const DEPLOY_REPO_NAME = "GGAI-STELLA-ENGINE";
const REQUIRED = ["main.js", "manifest.json"];
const OPTIONAL = ["styles.css"];

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd, stdio: "pipe" }).toString();
}

function tryRun(cmd, cwd) {
  try {
    return { ok: true, out: run(cmd, cwd) };
  } catch (e) {
    return { ok: false, out: e.stdout?.toString() ?? e.message };
  }
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const deployPath = path.resolve("..", DEPLOY_REPO_NAME);

if (!existsSync(deployPath)) {
  console.log(`[deploy] ${deployPath} 없음 → clone`);
  run(`git clone https://github.com/${DEPLOY_REPO_SLUG}.git "${deployPath}"`);
}

run("git pull origin main", deployPath);

const releaseDir = path.join("release", PLUGIN_FOLDER);
const filesToCopy = [...REQUIRED, ...OPTIONAL].filter((f) =>
  existsSync(path.join(releaseDir, f))
);
if (filesToCopy.length < REQUIRED.length) {
  console.error(`[deploy] ${releaseDir} 에 산출물이 없습니다. 'npm run release' 먼저 실행하세요.`);
  process.exit(1);
}
for (const f of filesToCopy) {
  copyFileSync(path.join(releaseDir, f), path.join(deployPath, f));
}
if (existsSync("README.md")) {
  copyFileSync("README.md", path.join(deployPath, "README.md"));
}

if (!tryRun("git config user.email", deployPath).ok) {
  run(`git config user.email "solahk0u@gmail.com"`, deployPath);
  run(`git config user.name "0ogg"`, deployPath);
}

run("git add -A", deployPath);
const commit = tryRun(`git commit -m "Release v${version}"`, deployPath);
if (!commit.ok) {
  console.log("[deploy] 변경 없음, 커밋 생략");
} else {
  run("git push origin main", deployPath);
}

const assetArgs = filesToCopy.join(" ");
const tagCheck = tryRun(`gh release view ${version} --repo ${DEPLOY_REPO_SLUG}`, deployPath);
if (tagCheck.ok) {
  console.log(`[deploy] ${version} 릴리즈가 이미 있음 → 자산만 갱신`);
  run(`gh release upload ${version} ${assetArgs} --repo ${DEPLOY_REPO_SLUG} --clobber`, deployPath);
} else {
  run(
    `gh release create ${version} ${assetArgs} --title "${version}" --notes "${manifest.name} ${version}" --repo ${DEPLOY_REPO_SLUG}`,
    deployPath
  );
}

console.log(`\n[deploy] 완료: https://github.com/${DEPLOY_REPO_SLUG}/releases/tag/${version}\n`);
