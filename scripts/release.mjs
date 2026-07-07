/**
 * 배포용 산출물 준비 스크립트 (정식 배포용 빌드).
 *
 * `npm run release` = 프로덕션 빌드 후 이 스크립트가 `release/<플러그인명>/` 에
 * 배포용 산출물(main.js, manifest.json, styles.css)만 깨끗이 모은다. 테스트 vault
 * 복사와 무관한, GitHub 배포 레포에 올릴 "완성 산출물 폴더"를 만든다.
 *
 * 여기서는 GitHub 로 푸시하지 않는다 (정식 배포 전 안전장치). 완성되면
 * `release/<플러그인명>` 폴더를 통째로 배포 레포(GGAI-STELLA-ENGINE)에 올리면 된다.
 * 사용자는 그 폴더를 `.obsidian/plugins/` 에 폴더째 넣어 설치한다.
 */
import { access, copyFile, mkdir, readFile, rm } from "fs/promises";
import path from "path";

/** 배포 레포 안에 들어갈 플러그인 폴더명 (= vault 설치 폴더명). */
const PLUGIN_FOLDER = "obsidian-ggai-stella-engine";
/** 배포 레포 이름 (안내용). */
const DEPLOY_REPO = "GGAI-STELLA-ENGINE";
/** 반드시 있어야 하는 산출물. */
const REQUIRED = ["main.js", "manifest.json"];
/** 있으면 담고 없으면 건너뛰는 산출물 (스타일 없는 플러그인 대응). */
const OPTIONAL = ["styles.css"];

const outDir = path.join("release", PLUGIN_FOLDER);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const copied = [];
const missingRequired = [];
for (const f of REQUIRED) {
  if (await exists(f)) {
    await copyFile(f, path.join(outDir, f));
    copied.push(f);
  } else {
    missingRequired.push(f);
  }
}
for (const f of OPTIONAL) {
  if (await exists(f)) {
    await copyFile(f, path.join(outDir, f));
    copied.push(f);
  }
}

console.log(`\n[release] ${manifest.name} v${manifest.version}`);
console.log(`[release] → ${outDir}/`);
for (const f of copied) console.log(`  ✓ ${f}`);
for (const f of missingRequired) console.log(`  ⚠ 빠짐(빌드 먼저 필요): ${f}`);

if (missingRequired.length > 0) {
  console.error("\n[release] 필수 산출물이 빠졌습니다. `npm run build` 후 다시 실행하세요.\n");
  process.exit(1);
}

console.log(
  `\n다음 단계: '${outDir}' 폴더를 ${DEPLOY_REPO} 레포에 올리세요.` +
    `\n(정식 배포 전이면 아직 푸시하지 마세요.)\n`
);
