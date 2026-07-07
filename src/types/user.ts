export interface StellaUserProfile {
  id: string;
  name: string;
  description: string;
  thumbnail?: string | null;
  aliases?: string[];
  favorite?: boolean;
  /**
   * 이 페르소나 전용 시나리오들의 stella id 목록. 여기 있는 시나리오를 시작/열면
   * 활성 페르소나가 자동으로 이 페르소나로 전환된다.
   */
  scenarioIds?: string[];
  createdAt: number;
  modifiedAt: number;
}

export function createDefaultUserProfile(now = Date.now()): StellaUserProfile {
  return {
    id: "default",
    name: "User",
    description: "",
    thumbnail: null,
    aliases: [],
    favorite: false,
    createdAt: now,
    modifiedAt: now,
  };
}
