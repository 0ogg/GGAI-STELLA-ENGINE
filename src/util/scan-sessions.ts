import { TFolder, Vault } from "obsidian";
import type { StellaSession } from "../types/session";

export interface SessionListItem {
  /** 예: "GGAI/SCENARIOS/Natasha/SESSIONS/세션1" */
  folder: string;
  /** 마지막 세그먼트 — 사용자가 보는 폴더명. */
  folderName: string;
  /** 예: "GGAI/SCENARIOS/Natasha/SESSIONS/세션1/session.json" */
  sessionFile: string;
  session: StellaSession;
}

export interface ScanSessionsOptions {
  /**
   * 이미 메모리에 있는 세션 객체를 돌려주는 조회 함수. 값이 있으면 그 파일은 **읽지 않는다**.
   *
   * 목록이 쓰는 건 meta(이름/즐겨찾기/시각)뿐이고, 캐시 객체는 디스크와 같거나 더 최신이다
   * (생성 중 새 노드는 아직 저장 전이라 메모리에만 있다). 어차피 호출부가 캐시 객체를
   * 쓰므로 읽은 내용은 버려진다 — 장편 세션 여러 개면 저장할 때마다 수 MB 를 읽고 버리는
   * 셈이라 파싱까지 통째로 건너뛴다. 캐시 참조 보호 정책은 `store.refreshSessions` 참조.
   */
  reuse?: (sessionFile: string) => StellaSession | undefined;
}

/**
 * 주어진 시나리오 폴더 아래의 `SESSIONS/*` 를 스캔해
 * `session.json` 이 있는 폴더만 반환한다.
 */
export async function scanSessions(
  vault: Vault,
  scenarioFolder: string,
  opts?: ScanSessionsOptions
): Promise<SessionListItem[]> {
  const root = vault.getAbstractFileByPath(`${scenarioFolder}/SESSIONS`);
  if (!(root instanceof TFolder)) return [];

  const items: SessionListItem[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const path = `${child.path}/session.json`;
    if (!(await vault.adapter.exists(path))) continue;

    // 캐시 적중 = 읽기·파싱 생략 (존재 확인은 그대로 통과시켜 판정 의미는 불변).
    const cached = opts?.reuse?.(path);
    if (cached) {
      items.push({
        folder: child.path,
        folderName: child.name,
        sessionFile: path,
        session: cached,
      });
      continue;
    }

    try {
      const text = await vault.adapter.read(path);
      const session = JSON.parse(text) as StellaSession;
      items.push({
        folder: child.path,
        folderName: child.name,
        sessionFile: path,
        session,
      });
    } catch (err) {
      console.warn(`[GGAI Stella] session.json 로드 실패: ${path}`, err);
    }
  }
  return items;
}
