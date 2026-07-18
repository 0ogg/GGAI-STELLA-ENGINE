/**
 * 스텔라 전체 이미지 집계 (PH5) — 폰 갤러리(카메라/업로드/SNS 사진) + 모든 세션의
 * 삽화를 한 목록으로. 폰 갤러리 앱과 SNS 게시 사진 첨부 피커가 공유한다.
 */
import { Vault } from "obsidian";
import type { StellaStore } from "../state/store";

export interface AnyGalleryImage {
  /** vault 전체 경로. */
  path: string;
  /** 캡션 — 폰 항목은 저장 캡션, 세션 삽화는 생성 프롬프트 (없으면 빈 문자열). */
  caption: string;
  /** 출처 라벨 — "스텔라 폰" 또는 시나리오 이름. */
  label: string;
  createdAt: number;
}

/** 폰 갤러리 + 전 세션 삽화를 최신순으로 모은다. 실패 항목은 조용히 건너뛴다. */
export async function collectAllGalleryImages(
  store: StellaStore,
  vault: Vault
): Promise<AnyGalleryImage[]> {
  const out: AnyGalleryImage[] = [];

  const phone = await store.getPhoneGallery().catch(() => null);
  for (const item of phone?.items ?? []) {
    if (!vault.getAbstractFileByPath(item.file)) continue;
    out.push({
      path: item.file,
      caption: item.caption,
      label: "스텔라 폰",
      createdAt: item.createdAt,
    });
  }

  const scenarios = await store
    .getScenarios()
    .catch((): Awaited<ReturnType<StellaStore["getScenarios"]>> => []);
  for (const scenario of scenarios) {
    if (scenario.sessionCount === 0) continue;
    const label = scenario.scenario.data.name || scenario.folderName;
    const sessions = await store
      .getSessions(scenario.folder)
      .catch((): Awaited<ReturnType<StellaStore["getSessions"]>> => []);
    for (const s of sessions) {
      const illus = await store
        .getSessionIllustrations(s.sessionFile)
        .catch(() => null);
      if (!illus) continue;
      for (const entry of Object.values(illus.nodes)) {
        for (const v of Object.values(entry.variants)) {
          const path = `${s.folder}/${v.path}`;
          if (!vault.getAbstractFileByPath(path)) continue;
          // 생성 프롬프트를 캡션으로 — 이미지 못 보는 모델이 무슨 사진인지 알 수 있게.
          out.push({
            path,
            caption: v.prompt?.trim() ?? "",
            label,
            createdAt: v.createdAt,
          });
        }
      }
    }
  }

  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
