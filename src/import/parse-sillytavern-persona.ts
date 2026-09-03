/**
 * ST 페르소나 백업(personas.js `onBackupPersonas`) 파싱.
 * shape: { personas: {avatarId: name}, persona_descriptions: {avatarId: {description, ...}}, default_persona: avatarId }
 * 아바타 이미지는 백업 JSON에 들어있지 않다(파일명만 있고 실제 그림은 없음) — 가져오지 않는다.
 * position/depth/role/lorebook 연결도 스텔라의 `{{persona}}` 매크로/기본 위치 규약과
 * 개념이 달라 가져오지 않는다.
 */
export interface ParsedPersona {
  name: string;
  description: string;
  isDefault: boolean;
}

export function parseSillyTavernPersonas(data: any): ParsedPersona[] {
  const personas =
    data?.personas && typeof data.personas === "object" ? data.personas : {};
  const descriptions =
    data?.persona_descriptions && typeof data.persona_descriptions === "object"
      ? data.persona_descriptions
      : {};
  const defaultKey =
    typeof data?.default_persona === "string" ? data.default_persona : null;

  const out: ParsedPersona[] = [];
  for (const [avatarId, rawName] of Object.entries<any>(personas)) {
    const name =
      typeof rawName === "string" && rawName.trim() ? rawName.trim() : "User";
    const descriptor = descriptions[avatarId];
    const description =
      descriptor && typeof descriptor === "object" && typeof descriptor.description === "string"
        ? descriptor.description
        : "";
    out.push({ name, description, isDefault: avatarId === defaultKey });
  }
  return out;
}
