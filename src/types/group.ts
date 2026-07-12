/**
 * 그룹 JSON 스키마 (G1 소설 그룹).
 *
 * 그룹은 여러 시나리오(캐릭터)를 한 세션에 모으는 **얇은 껍데기**다.
 * `GGAI/GROUPS/[그룹명]/group.json` 에 멤버 목록 + 설정만 담고, 세션 구조는
 * 기존(시나리오 세션)을 그대로 재사용한다 — 세션은 `meta.groupId` 로 그룹에 귀속.
 *
 * 멤버는 시나리오를 **stella.id 로 참조**한다(시나리오 이동/이름변경에 강건).
 * 발화자 시스템(수다스러움 등, G2)·멤버 프로필 확장은 멤버 구조에 필드를 더해 얹는다.
 */

/** 그룹 멤버 1명 — 시나리오 참조 + (후속) 발화자 설정. */
export interface StellaGroupMember {
  /** 멤버 시나리오의 stella.id (StellaScenarioExtension.id). */
  scenarioId: string;
}

export interface StellaGroup {
  schemaVersion: 1;
  /** 그룹 고유 UUID — 이름 중복 구분용. 세션 meta.groupId 가 이 값을 참조. */
  id: string;
  /** 표시용 이름. 폴더명과 독립. */
  name: string;
  favorite: boolean;
  createdAt: number;
  modifiedAt: number;
  /** 마지막 플레이 시각 (epoch ms, 0 = 미플레이). */
  lastPlayedAt: number;
  playCount: number;
  /** 멤버 시나리오들. 순서 = 표시 순서. */
  members: StellaGroupMember[];
  /**
   * 그룹 챗 — 유저 발화 뒤 자동으로 이어지는 최대 AI 발화 수 (누적 대화 상한, G2/G3).
   * 미설정/0 = 기본(멤버 수, 최대 3). 값을 키우면 캐릭터끼리 더 오래 대화한다.
   * [계속 진행] 버튼은 이 상한과 무관하게 한 라운드를 더 연다.
   */
  autoChainMax?: number;
  /**
   * 그룹 챗 — 같은 캐릭터가 연속으로 말할 수 있는 최대 횟수 (중복 발화 상한, G3).
   * 미설정 = 1(매 발화 다른 캐릭터). 2 이상이면 한 캐릭터가 몰아 말하거나 말싸움 가능.
   */
  maxConsecutiveSpeaker?: number;
}
