/**
 * 스텔라 폰 (PH1) — 문자 데이터 스키마. 설계는 `스텔라폰 스펙.md`.
 *
 * 저장: `GGAI/PHONE/<personaId>/messages.json` — 페르소나 1명 = 폰 1대.
 * key 가 페르소나 파일 경로가 아니라 profile.id 인 이유: 파일 이름이 바뀌어도
 * 폰(문자함)이 유지되어야 한다.
 *
 * 문자는 세션 노드를 만들지 않는다 — 세션과의 연결은 컨텍스트 주입(기억)뿐.
 */

export interface PhoneMessage {
  id: string;
  /** persona = 폰 주인(로그인 페르소나)이 보낸 문자, other = 상대(캐릭터)가 보낸 문자. */
  from: "persona" | "other";
  text: string;
  createdAt: number;
  /** 보낼 당시 첨부한 세션 파일 (현재 세션 중인 캐릭터에게 보낸 경우). */
  sessionFile?: string;
  /** 번역 결과 (PH5) — 원문(text)은 불변, 표시 토글로 원문↔번역 전환. */
  translation?: { text: string };
  /** 첨부 사진 — 캡션은 이미지 못 보는 모델에게 정보를 주는 텍스트. */
  image?: { caption: string; asset: string };
  /**
   * 배달 예정 시각 (v2 시간차 배달) — 미래면 목록/스레드에 표시하지 않는다.
   * undefined = 즉시 배달 (v1 데이터 포함).
   */
  deliverAt?: number;
  /** 상대가 읽은 시각 (v2 읽음 표시) — 페르소나 발신 문자에만 의미. */
  readAt?: number;
}

/** 항목 단위 번역 필드 정규화 — 문자/게시글/답글 공용. */
function normalizeItemTranslation(
  raw: unknown
): { text: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = (raw as { text?: unknown }).text;
  return typeof t === "string" && t ? { text: t } : undefined;
}

export interface PhoneThread {
  id: string;
  /** scenario = 시나리오 캐릭터와의 스레드, extra = 모르는 번호 (PH2). */
  kind: "scenario" | "extra";
  /** kind=scenario — 시나리오의 stella id. */
  scenarioId?: string;
  /** kind=extra — 표시 이름 (예: "알 수 없는 번호"). */
  extraName?: string;
  messages: PhoneMessage[];
  createdAt: number;
}

export interface PhoneMessagesFile {
  version: 1;
  threads: PhoneThread[];
  /**
   * 등록된 연락처 (시나리오 stella id) — 사용자가 [연락처 등록]으로 초대한
   * 캐릭터만 문자 목록/선발신 대상이 된다 (1회 필터). undefined = 구버전
   * 파일: 문자 이력이 있는 스레드를 등록된 것으로 간주한다.
   */
  contacts?: string[];
}

export function createEmptyPhoneMessages(): PhoneMessagesFile {
  return { version: 1, threads: [] };
}

/** 느슨한 JSON → 정규화. 알 수 없는 필드는 버리고 필수 필드만 보장한다. */
export function normalizePhoneMessages(raw: unknown): PhoneMessagesFile {
  const out = createEmptyPhoneMessages();
  if (!raw || typeof raw !== "object") return out;
  const contacts = (raw as { contacts?: unknown }).contacts;
  if (Array.isArray(contacts)) {
    out.contacts = contacts.filter(
      (v): v is string => typeof v === "string" && v !== ""
    );
  }
  const threads = (raw as { threads?: unknown }).threads;
  if (!Array.isArray(threads)) return out;
  for (const t of threads) {
    if (!t || typeof t !== "object") continue;
    const th = t as Partial<PhoneThread>;
    if (typeof th.id !== "string" || !th.id) continue;
    const kind = th.kind === "extra" ? "extra" : "scenario";
    const messages: PhoneMessage[] = [];
    for (const m of Array.isArray(th.messages) ? th.messages : []) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Partial<PhoneMessage>;
      if (typeof msg.id !== "string" || typeof msg.text !== "string") continue;
      const translation = normalizeItemTranslation(msg.translation);
      const rawImage = (msg as { image?: unknown }).image;
      let image: PhoneMessage["image"];
      if (rawImage && typeof rawImage === "object") {
        const im = rawImage as { caption?: unknown; asset?: unknown };
        if (typeof im.asset === "string" && im.asset) {
          image = {
            caption: typeof im.caption === "string" ? im.caption : "",
            asset: im.asset,
          };
        }
      }
      messages.push({
        id: msg.id,
        from: msg.from === "persona" ? "persona" : "other",
        text: msg.text,
        createdAt: typeof msg.createdAt === "number" ? msg.createdAt : 0,
        ...(typeof msg.sessionFile === "string"
          ? { sessionFile: msg.sessionFile }
          : {}),
        ...(translation ? { translation } : {}),
        ...(image ? { image } : {}),
        ...(typeof msg.deliverAt === "number" ? { deliverAt: msg.deliverAt } : {}),
        ...(typeof msg.readAt === "number" ? { readAt: msg.readAt } : {}),
      });
    }
    out.threads.push({
      id: th.id,
      kind,
      ...(typeof th.scenarioId === "string" ? { scenarioId: th.scenarioId } : {}),
      ...(typeof th.extraName === "string" ? { extraName: th.extraName } : {}),
      messages,
      createdAt: typeof th.createdAt === "number" ? th.createdAt : 0,
    });
  }
  return out;
}

// ─────────────────────────── SNS (PH3) ───────────────────────────

/**
 * SNS 작성자 — 항상 "인물"이다. 시나리오는 세계(월드)이지 계정이 아니다.
 *  - character: 시나리오에 속한 이름 있는 인물 (메인 캐릭터 — id 로 시나리오 귀속).
 *  - extra: 익명 핸들/엑스트라 (world 로 출신 세계만 표시, 시나리오 귀속 없음).
 *  - persona: 폰 주인(사용자).
 *  - scenario: 시나리오 공식 계정 (레거시 겸 예약 — 프로필 카드 꾸미기와 함께 확장).
 */
export interface SnsAuthor {
  kind: "character" | "scenario" | "persona" | "extra";
  /** character/scenario = 시나리오 stella id, persona = 페르소나 profile.id. */
  id?: string;
  name: string;
  /** @핸들 (예: @mint_choco2) — 진짜 SNS 느낌. 없으면 이름만. */
  handle?: string;
  /** 인증 배지(공식/언론/유명인 계정). */
  verified?: boolean;
  /** 출신 세계(시나리오) 이름 — 표시 서브라벨 (character/extra). */
  world?: string;
  /** 귀속된 영속 계정 id (v2, accounts.json) — 핸들 매칭으로 엔진이 부여. */
  accountId?: string;
}

export interface SnsReply {
  id: string;
  author: SnsAuthor;
  text: string;
  createdAt: number;
  /** 대댓글 — 같은 게시글 안의 부모 답글 id (없으면 게시글 직접 답글). 2단까지. */
  parentId?: string;
  /** 좋아요 수 (생성 시 부여되는 기본값). */
  likes?: number;
  /** 번역 결과 (PH5) — 원문(text)은 불변, 표시 토글로 원문↔번역 전환. */
  translation?: { text: string };
}

export interface SnsPost {
  id: string;
  author: SnsAuthor;
  text: string;
  createdAt: number;
  replies: SnsReply[];
  /**
   * 첨부 사진 (PH5). caption 은 항상 있고(이미지 못 보는 모델에게는 캡션이 정보),
   * asset 은 실제 이미지가 있을 때만 (vault 경로 — 생성/업로드/삽화).
   */
  image?: { caption: string; asset?: string };
  /** 좋아요 — 생성 시 기본값(likes) + 사용자가 누른 페르소나 id 목록(likedBy). */
  likes?: number;
  likedBy?: string[];
  /**
   * 스트리밍 방송 (PH4) — 이 게시글이 세션 장면의 생중계임을 표시.
   * live 인 동안 본문(text)이 그 세션의 최근 장면으로 갱신되고, 그 자리에 없는
   * 캐릭터들이 시청자 코멘트를 단다. 종료 후에도 게시글은 피드에 남는다.
   */
  stream?: { sessionFile: string; live: boolean };
  /** 번역 결과 (PH5) — 원문(text)은 불변, 표시 토글로 원문↔번역 전환. */
  translation?: { text: string };
  /**
   * 이슈 등급 (v2, 1~5) — 1=노관심 2=일상 3=분야 이슈 4=국가 5=세계.
   * 생성 시 모델이 판정, 엔진이 클램프. undefined = 미판정(v1 데이터 = 2 취급).
   */
  issueScale?: number;
  /**
   * 붐업 (v2) — 최상단 이슈로 재부상한(또는 유지 갱신된) 시각.
   * 현재 최상단 이슈는 `SnsFeedFile.boom` 이 가리키는 1개뿐이고, 이 시각은
   * 표시 순서(max(createdAt, bumpedAt))와 "↻ 다시 화제" 배지에 쓰인다.
   */
  bumpedAt?: number;
}

/** 볼트 공용 SNS 피드 — `GGAI/PHONE/sns.json`. 모든 세계관이 네트워크를 공유한다. */
export interface SnsFeedFile {
  version: 1;
  posts: SnsPost[];
  /**
   * 현재 최상단 이슈 (v2 §6.4) — 피드에서 유일하게 "살아 있는" 붐업 글.
   * turns = 최상단 유지 배치 수 (10턴 도달 시 강제 교체). issueScale 성장은
   * 반응(댓글)을 받은 배치에만 (한도 5). quiet = 반응 없이 지나간 연속 배치 수
   * — 2 이상이면 이슈가 식어 은퇴. undefined = 아직 최상단 이슈 없음.
   */
  boom?: { postId: string; turns: number; quiet?: number };
}

export function createEmptySnsFeed(): SnsFeedFile {
  return { version: 1, posts: [] };
}

function normalizeSnsAuthor(raw: unknown): SnsAuthor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<SnsAuthor>;
  if (typeof a.name !== "string" || !a.name) return null;
  const kind =
    a.kind === "character" || a.kind === "scenario" || a.kind === "persona"
      ? a.kind
      : "extra";
  return {
    kind,
    ...(typeof a.id === "string" && a.id ? { id: a.id } : {}),
    name: a.name,
    ...(typeof a.handle === "string" && a.handle ? { handle: a.handle } : {}),
    ...(a.verified === true ? { verified: true } : {}),
    ...(typeof a.world === "string" && a.world ? { world: a.world } : {}),
    ...(typeof a.accountId === "string" && a.accountId
      ? { accountId: a.accountId }
      : {}),
  };
}

/** 느슨한 JSON → 정규화. */
export function normalizeSnsFeed(raw: unknown): SnsFeedFile {
  const out = createEmptySnsFeed();
  if (!raw || typeof raw !== "object") return out;
  const rawBoom = (raw as { boom?: unknown }).boom;
  if (rawBoom && typeof rawBoom === "object") {
    const b = rawBoom as { postId?: unknown; turns?: unknown; quiet?: unknown };
    if (typeof b.postId === "string" && b.postId) {
      out.boom = {
        postId: b.postId,
        turns:
          typeof b.turns === "number" && b.turns >= 1 ? Math.round(b.turns) : 1,
        ...(typeof b.quiet === "number" && b.quiet >= 1
          ? { quiet: Math.round(b.quiet) }
          : {}),
      };
    }
  }
  const posts = (raw as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return out;
  for (const p of posts) {
    if (!p || typeof p !== "object") continue;
    const post = p as Partial<SnsPost>;
    const author = normalizeSnsAuthor(post.author);
    if (typeof post.id !== "string" || typeof post.text !== "string" || !author) {
      continue;
    }
    const replies: SnsReply[] = [];
    for (const r of Array.isArray(post.replies) ? post.replies : []) {
      if (!r || typeof r !== "object") continue;
      const reply = r as Partial<SnsReply>;
      const rAuthor = normalizeSnsAuthor(reply.author);
      if (typeof reply.id !== "string" || typeof reply.text !== "string" || !rAuthor) {
        continue;
      }
      const rTranslation = normalizeItemTranslation(reply.translation);
      replies.push({
        id: reply.id,
        author: rAuthor,
        text: reply.text,
        createdAt: typeof reply.createdAt === "number" ? reply.createdAt : 0,
        ...(typeof reply.parentId === "string" && reply.parentId
          ? { parentId: reply.parentId }
          : {}),
        ...(typeof reply.likes === "number" ? { likes: reply.likes } : {}),
        ...(rTranslation ? { translation: rTranslation } : {}),
      });
    }
    const pTranslation = normalizeItemTranslation(post.translation);
    const rawStream = (post as { stream?: unknown }).stream;
    let stream: SnsPost["stream"];
    if (rawStream && typeof rawStream === "object") {
      const s = rawStream as { sessionFile?: unknown; live?: unknown };
      if (typeof s.sessionFile === "string" && s.sessionFile) {
        stream = { sessionFile: s.sessionFile, live: s.live === true };
      }
    }
    const rawImage = (post as { image?: unknown }).image;
    let image: SnsPost["image"];
    if (rawImage && typeof rawImage === "object") {
      const im = rawImage as { caption?: unknown; asset?: unknown };
      if (typeof im.caption === "string" && im.caption) {
        image = {
          caption: im.caption,
          ...(typeof im.asset === "string" && im.asset
            ? { asset: im.asset }
            : {}),
        };
      }
    }
    out.posts.push({
      id: post.id,
      author,
      text: post.text,
      createdAt: typeof post.createdAt === "number" ? post.createdAt : 0,
      replies,
      ...(stream ? { stream } : {}),
      ...(image ? { image } : {}),
      ...(pTranslation ? { translation: pTranslation } : {}),
      ...(typeof post.issueScale === "number"
        ? { issueScale: clampIssueScale(post.issueScale) }
        : {}),
      ...(typeof post.bumpedAt === "number" ? { bumpedAt: post.bumpedAt } : {}),
      ...(typeof post.likes === "number" ? { likes: post.likes } : {}),
      ...(Array.isArray(post.likedBy)
        ? { likedBy: post.likedBy.filter((v): v is string => typeof v === "string") }
        : {}),
    });
  }
  // 최상단 이슈 글이 삭제/정리로 사라졌으면 해제 (댕글링 방지).
  if (out.boom && !out.posts.some((p) => p.id === out.boom!.postId)) {
    delete out.boom;
  }
  return out;
}

// ─────────────────────────── SNS 영속 계정 DB (v2) ───────────────────────────

/** 이슈 등급 클램프 — 1~5 정수. */
export function clampIssueScale(v: number): number {
  return Math.min(5, Math.max(1, Math.round(v)));
}

/**
 * SNS 계정 동일성 키 — 핸들 우선, 없으면 종류+id/이름.
 * 모아보기·계정 삭제·accounts.json 매칭 공용.
 */
export function snsAuthorKey(a: SnsAuthor): string {
  if (a.handle) return `h:${a.handle.toLowerCase()}`;
  return `${a.kind}:${a.id ?? a.name.trim().toLowerCase()}`;
}

/**
 * SNS 영속 계정 (v2) — "같은 사람들이 계속 사는 SNS"의 주민.
 * 저장: `GGAI/PHONE/accounts.json` (볼트 공용). 배치 파싱 시 핸들 키로 매칭해
 * 재등장을 우선하고, followers 는 활동/이슈 등급에 따라 엔진이 완만 증감시킨다.
 */
export interface SnsAccount {
  id: string;
  /** press = 언론/공식/유명인 (등급 4~5 이슈에서만 출현). */
  kind: "character" | "extra" | "persona" | "press";
  /** kind=character — 시나리오 stella id. kind=persona — 페르소나 profile.id. */
  scenarioId?: string;
  name: string;
  handle?: string;
  verified?: boolean;
  /** 출신 세계(시나리오) 이름. */
  world?: string;
  /** 팔로워 수 — 좋아요 스케일·시청자 수의 기준. */
  followers: number;
  /** 한 줄 성향/말투 메모 — 생성 시 일관성 재료. */
  persona?: string;
  firstSeen: number;
  lastActive: number;
  postCount: number;
}

export interface PhoneAccountsFile {
  version: 1;
  accounts: SnsAccount[];
}

export function createEmptyPhoneAccounts(): PhoneAccountsFile {
  return { version: 1, accounts: [] };
}

/** 느슨한 JSON → 정규화. */
export function normalizePhoneAccounts(raw: unknown): PhoneAccountsFile {
  const out = createEmptyPhoneAccounts();
  if (!raw || typeof raw !== "object") return out;
  const accounts = (raw as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return out;
  for (const a of accounts) {
    if (!a || typeof a !== "object") continue;
    const acc = a as Partial<SnsAccount>;
    if (typeof acc.id !== "string" || !acc.id) continue;
    if (typeof acc.name !== "string" || !acc.name) continue;
    const kind =
      acc.kind === "character" || acc.kind === "persona" || acc.kind === "press"
        ? acc.kind
        : "extra";
    out.accounts.push({
      id: acc.id,
      kind,
      ...(typeof acc.scenarioId === "string" && acc.scenarioId
        ? { scenarioId: acc.scenarioId }
        : {}),
      name: acc.name,
      ...(typeof acc.handle === "string" && acc.handle
        ? { handle: acc.handle }
        : {}),
      ...(acc.verified === true ? { verified: true } : {}),
      ...(typeof acc.world === "string" && acc.world
        ? { world: acc.world }
        : {}),
      followers:
        typeof acc.followers === "number" && acc.followers >= 0
          ? Math.round(acc.followers)
          : 0,
      ...(typeof acc.persona === "string" && acc.persona
        ? { persona: acc.persona }
        : {}),
      firstSeen: typeof acc.firstSeen === "number" ? acc.firstSeen : 0,
      lastActive: typeof acc.lastActive === "number" ? acc.lastActive : 0,
      postCount:
        typeof acc.postCount === "number" && acc.postCount >= 0
          ? Math.round(acc.postCount)
          : 0,
    });
  }
  return out;
}

/** 결정적 0~1 해시 — 백필 초기 팔로워 수의 변주 (재실행해도 같은 값). */
function hash01(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0) / 0xffffffff;
}

/**
 * accounts.json 초기 구축 (v2 백필) — 기존 sns.json 의 작성자를 핸들 우선 키로
 * 스캔해 계정으로 등록한다. 파일이 없을 때 1회만 쓰이는 순수 함수.
 * makeId 는 새 계정 id 공급자 (uuid — 순수성 유지를 위해 주입).
 */
export function backfillAccountsFromSnsFeed(
  feed: SnsFeedFile,
  makeId: () => string
): PhoneAccountsFile {
  const out = createEmptyPhoneAccounts();
  const byKey = new Map<string, SnsAccount>();
  const touch = (author: SnsAuthor, at: number, isPost: boolean) => {
    const key = snsAuthorKey(author);
    let acc = byKey.get(key);
    if (!acc) {
      const kind =
        author.kind === "scenario"
          ? "press"
          : author.kind === "character" ||
              author.kind === "persona" ||
              author.kind === "extra"
            ? author.kind
            : "extra";
      acc = {
        id: `acc_${makeId()}`,
        kind,
        ...(author.id &&
        (author.kind === "character" || author.kind === "persona")
          ? { scenarioId: author.id }
          : {}),
        name: author.name,
        ...(author.handle ? { handle: author.handle } : {}),
        ...(author.verified ? { verified: true } : {}),
        ...(author.world ? { world: author.world } : {}),
        followers: 0,
        firstSeen: at,
        lastActive: at,
        postCount: 0,
      };
      byKey.set(key, acc);
      out.accounts.push(acc);
    }
    if (at && (!acc.firstSeen || at < acc.firstSeen)) acc.firstSeen = at;
    if (at > acc.lastActive) acc.lastActive = at;
    if (isPost) acc.postCount += 1;
  };
  for (const post of feed.posts) {
    touch(post.author, post.createdAt, true);
    for (const reply of post.replies) touch(reply.author, reply.createdAt, false);
  }
  // 초기 팔로워: 종류별 기준값 + 활동량 + 결정적 변주 (이후 엔진이 완만 증감).
  for (const [key, acc] of byKey) {
    const base =
      acc.kind === "press" ? 5000 : acc.kind === "character" ? 200 : 60;
    const activity = acc.postCount * 30;
    const jitter = Math.round(hash01(key) * base);
    acc.followers = base + activity + jitter;
  }
  return out;
}

/** 갱신 트리거 설정 (PH2) — 중복 선택 가능. undefined 기본값은 주석 참조. */
export interface PhoneTriggerSettings {
  /** 폰 UI를 켰을 때 (기본 켜짐). */
  onOpen?: boolean;
  /** 세션(창)이 열려 있는 동안 5~30분 랜덤 간격 (기본 꺼짐). */
  randomInSession?: boolean;
  /** 정기 갱신 — 옵시디언이 켜져 있을 때만 (기본 꺼짐). */
  periodic?: boolean;
  /** 정기 갱신 간격(분, 기본 60). */
  periodicMinutes?: number;
  /** 세션 생성문에 폰 관련 키워드가 나왔을 때 (기본 꺼짐). */
  keyword?: boolean;
  /** 기본 사전(한/영/일)에 더해 사용자가 추가한 키워드. */
  customKeywords?: string[];
}

/** 폰 전역 설정 — `PluginData.phone`. 번역(PH5)은 그 단계에서 추가. */
export interface PhonePluginData {
  /**
   * 문자 세션 기억 연동 (문자 내용을 세션 컨텍스트에 주입) on/off.
   * undefined = 켜짐 — 폰을 쓴다는 것 자체가 기억 연동을 기대하는 상태.
   */
  enabled?: boolean;
  /** SNS 세션 기억 연동 — 문자와 별개 토글 (undefined = 켜짐). */
  snsEnabled?: boolean;
  /** 폰에 로그인한 페르소나 파일 — 전역 활성 페르소나와 독립 (폰 안에서만 유효). */
  loginPersonaFile?: string;
  /** 폰 생성(문자 답장) 전용 모델 프로필. 미지정 = 기본 챗 프로필. */
  modelProfileId?: string;
  /** 폰 생성 언어 (예: "한국어"). 빈 값 = 지시 없음. */
  language?: string;
  /**
   * 폰 안 번역 (PH5) — enabled 기본 켜짐(문자/SNS 번역 표시).
   * auto = 생성 직후 자동 번역 (v2 개편, 기본 꺼짐) — 켜면 문자/SNS 생성이
   * 끝나는 대로 번역을 돌려 번역본을 바로 보여준다(항목별 버튼 대체).
   * 로어북은 폰 전용 — 세션 번역 설정과 독립. 프롬프트/모델은 전역 번역 설정 재사용.
   * aiMatching = 번역 전 로어북 AI 선별(폰 전용 토글, 세션 [확장] 탭과 독립). 선별
   * 모델/프롬프트는 전역 로어북 확장 설정을 재사용(없으면 기본값).
   */
  translation?: {
    enabled?: boolean;
    auto?: boolean;
    lorebookIds?: string[];
    aiMatching?: boolean;
  };
  /** 문자 답장 프롬프트 (phoneText 버킷) — 미지정 = 기본. */
  textPromptId?: string;
  /** 모르는 번호 문자 프롬프트 (phoneExtra 버킷). */
  extraPromptId?: string;
  /** SNS 생성 프롬프트 (phoneSns 버킷). */
  snsPromptId?: string;
  /** 답장 컨텍스트에 넣는 문자 이력 상한 (통, 기본 60 — v1 은 40). */
  replyHistoryLimit?: number;
  /** 현재 세션 첨부 시 본문 꼬리 (토큰, 기본 2000) — v2 자→토큰 통일. */
  sessionTailTokens?: number;
  /** @deprecated v1 자 단위 — v2 `sessionTailTokens` 로 대체 (라운드트립 보존용). */
  sessionTailChars?: number;
  /** @deprecated v1 — v2 `snsConfirmedCount` 로 대체 (라운드트립 보존용). */
  snsSessionCount?: number;
  /** @deprecated v1 — v2 `snsBodyTokens` 로 대체 (라운드트립 보존용). */
  snsSessionTokens?: number;
  /** SNS 확정 참가 시나리오(인물) 수 (v2, 기본 3). */
  snsConfirmedCount?: number;
  /** 확정 참가자당 최근 세션 요약 첨부 (토큰, 기본 2000 — 최근분 우선). */
  snsSummaryTokens?: number;
  /** 확정 참가자당 최근 세션 본문 첨부 (토큰, 기본 2000 — 최근분 우선). */
  snsBodyTokens?: number;
  /** 첨부 본문 기준 활성 로어북 전부 포함 (v2, undefined = 켬, 절단 없음). */
  snsIncludeLore?: boolean;
  /** 랜덤 세션 2개 추가 첨부 (v2, 기본 끔 — 각 항목 토큰은 확정값의 50%). */
  snsRandomSessions?: boolean;
  /** SNS 참가에서 제외한 시나리오 stella id 목록 (설정창 체크 해제). */
  snsExcludedScenarioIds?: string[];
  /** 갱신 1회당 최소 새 게시글 수 (v2, 기본 2 — 미달 시 1회 재시도). */
  snsMinNewPosts?: number;
  /** 배치당 신규 계정 발명 상한 (v2, 기본 3 — 넘치면 계정 등록 없이 익명 처리). */
  snsNewAccountCap?: number;
  /** 답글 알림 마지막 확인 시각 — 이보다 새 답글이 안 읽음 배지로 뜬다. */
  snsNotifSeenAt?: number;
  /** 갱신 트리거 (PH2). */
  triggers?: PhoneTriggerSettings;
  /** 미응답 수신 문자 상한 (기본 2, 0=무제한) — 답장 안 한 스레드가 이만큼 쌓이면 갱신이 쉼. */
  maxUnanswered?: number;
  /**
   * 답장 최대 지연 (분, v2 §3.2 시간차 배달 — 기본 10). 0 = 즉시 배달 모드
   * (v1 동작: 생성 즉시 표시, 읽음/읽씹 판정도 끔).
   */
  maxReplyDelayMinutes?: number;
  /** 갱신 1회당 SNS 활동(게시글/답글) 상한 (기본 6, 0=SNS 자동 갱신 끔). */
  snsPerRefresh?: number;
  /** 세션 생성문에서 방송 상황을 감지해 자동으로 방송을 시작 (PH4, 기본 꺼짐). */
  streamAutoDetect?: boolean;
  /** 스텔라튜브 사용 (v2 §7) — 끄면 노드 반응 생성 없음 (undefined = 켬). */
  tubeEnabled?: boolean;
  /** 스텔라튜브 채팅 프롬프트 (phoneTube 버킷) — 미지정 = 기본. */
  tubePromptId?: string;
  /**
   * 폰 이미지 모델 (PH5) — 카메라 촬영·SNS 사진 생성에 사용. 미지정 = 기본 이미지
   * 프로필. 이미지 프로필이 하나도 없으면 SNS 사진은 캡션 텍스트로만 표시된다.
   */
  imageProfileId?: string;
  /**
   * AI 의 사진 게시 허용 (v2 §5.2) — 끄면 SNS 배치가 photo 를 만들지 않는다
   * (프로토콜에서 제외 + 엔진 무시). undefined = 켬.
   */
  snsPhotoEnabled?: boolean;
  /**
   * 앱 간 공유 허브 (v2 §8.1) — 문자/SNS/방송이 서로의 최근 소식을 맥락으로
   * 공유한다(자기 앱 제외). undefined = 켬.
   */
  sharedContextEnabled?: boolean;
  /** 공유 다이제스트로 각 생성에 붙일 최대 분량 (토큰, 기본 1000). */
  sharedContextTokens?: number;
}

// ─────────────────────────── 폰 갤러리 (PH5) ───────────────────────────

/** 폰 갤러리 항목 — 카메라 촬영 / 사용자 업로드 / SNS 사진. */
export interface PhoneGalleryItem {
  id: string;
  /** vault 전체 경로 (GGAI/PHONE/assets/...). */
  file: string;
  /** 캡션 — 이미지 인식 안 되는 모델에게 정보를 주는 텍스트 (업로드 시 필수). */
  caption: string;
  source: "camera" | "upload" | "sns";
  createdAt: number;
  /** 즐겨찾기 — 대시보드 갤러리 분류/필터용. */
  favorite?: boolean;
}

export interface PhoneGalleryFile {
  version: 1;
  items: PhoneGalleryItem[];
}

export function createEmptyPhoneGallery(): PhoneGalleryFile {
  return { version: 1, items: [] };
}

export function normalizePhoneGallery(raw: unknown): PhoneGalleryFile {
  const out = createEmptyPhoneGallery();
  if (!raw || typeof raw !== "object") return out;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return out;
  for (const i of items) {
    if (!i || typeof i !== "object") continue;
    const it = i as Partial<PhoneGalleryItem>;
    if (typeof it.id !== "string" || typeof it.file !== "string" || !it.file) {
      continue;
    }
    out.items.push({
      id: it.id,
      file: it.file,
      caption: typeof it.caption === "string" ? it.caption : "",
      source:
        it.source === "camera" || it.source === "upload" ? it.source : "sns",
      createdAt: typeof it.createdAt === "number" ? it.createdAt : 0,
      ...(it.favorite === true ? { favorite: true } : {}),
    });
  }
  return out;
}

// ─────────────────────────── 스텔라튜브 (v2 §7) ───────────────────────────

/** 스텔라튜브 채팅 1줄 — 계정 엔진 귀속 결과를 이름/핸들로 저장. */
export interface StreamChatItem {
  id: string;
  name: string;
  handle?: string;
  text: string;
  /** 도네이션 금액 (있으면 후원 채팅). */
  donation?: number;
  /** 폰 안 번역 (v2) — 원문 불변, 표시 토글로 전환 (문자/SNS 와 동일). */
  translation?: { text: string };
}

/** 세션 노드 1개에 대한 시청자 반응 배치. */
export interface StreamNodeReaction {
  viewers: number;
  /** 모델 판정 원본 — 활성 경로에서 closing 2연속이면 방송 종료 (§7.3). */
  streamState: "on" | "closing";
  chat: StreamChatItem[];
  /** 반응 생성 시각 — 채팅 시간순 정렬/다시보기용. */
  at: number;
}

/**
 * 스텔라튜브 방송 (v2 §7) — 세션 폴더 옆 `stream.json`.
 * 노드 키로 반응을 저장해 재생성 연동이 공짜다: 재생성하면 새 sibling 노드로
 * 반응이 새로 생기고, 옛 노드의 반응은 그 노드에 남는다 (분기 보존).
 * 표시는 항상 활성 경로(root→activeLeaf) 위 노드들만.
 */
export interface SessionStreamFile {
  version: 1;
  streamId: string;
  /** 방송 주인 — 페르소나 또는 캐릭터 계정 (accounts.json 귀속). */
  streamer: { kind: "persona" | "character"; accountId?: string; name: string };
  live: boolean;
  /** 방송 시작 시점의 세션 노드 — 이 노드부터가 방송분. */
  startedNodeId: string;
  /** 방송 시작 시청자 수 (스트리머 팔로워 기반) — 클램프 기준의 뿌리. */
  startViewers: number;
  /** 노드별 시청자 반응. */
  nodes: Record<string, StreamNodeReaction>;
  startedAt: number;
  endedAt?: number;
}

/** 느슨한 JSON → 정규화. 필수 골격이 없으면 null. */
export function normalizeSessionStream(raw: unknown): SessionStreamFile | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<SessionStreamFile>;
  if (typeof s.streamId !== "string" || !s.streamId) return null;
  const st = s.streamer as Partial<SessionStreamFile["streamer"]> | undefined;
  if (!st || typeof st.name !== "string" || !st.name) return null;
  const nodes: Record<string, StreamNodeReaction> = {};
  if (s.nodes && typeof s.nodes === "object") {
    for (const [nodeId, r] of Object.entries(
      s.nodes as Record<string, unknown>
    )) {
      if (!r || typeof r !== "object") continue;
      const rr = r as Partial<StreamNodeReaction>;
      const chat: StreamChatItem[] = [];
      for (const c of Array.isArray(rr.chat) ? rr.chat : []) {
        if (!c || typeof c !== "object") continue;
        const cc = c as Partial<StreamChatItem>;
        if (typeof cc.id !== "string" || typeof cc.text !== "string") continue;
        if (typeof cc.name !== "string" || !cc.name) continue;
        const tr = cc.translation as { text?: unknown } | undefined;
        chat.push({
          id: cc.id,
          name: cc.name,
          ...(typeof cc.handle === "string" && cc.handle
            ? { handle: cc.handle }
            : {}),
          text: cc.text,
          ...(typeof cc.donation === "number" && cc.donation > 0
            ? { donation: Math.round(cc.donation) }
            : {}),
          ...(tr && typeof tr.text === "string"
            ? { translation: { text: tr.text } }
            : {}),
        });
      }
      nodes[nodeId] = {
        viewers:
          typeof rr.viewers === "number" && rr.viewers >= 0
            ? Math.round(rr.viewers)
            : 0,
        streamState: rr.streamState === "closing" ? "closing" : "on",
        chat,
        at: typeof rr.at === "number" ? rr.at : 0,
      };
    }
  }
  return {
    version: 1,
    streamId: s.streamId,
    streamer: {
      kind: st.kind === "character" ? "character" : "persona",
      ...(typeof st.accountId === "string" && st.accountId
        ? { accountId: st.accountId }
        : {}),
      name: st.name,
    },
    live: s.live === true,
    startedNodeId: typeof s.startedNodeId === "string" ? s.startedNodeId : "",
    startViewers:
      typeof s.startViewers === "number" && s.startViewers > 0
        ? Math.round(s.startViewers)
        : 10,
    nodes,
    startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
    ...(typeof s.endedAt === "number" ? { endedAt: s.endedAt } : {}),
  };
}

/** 방송 자동 감지 키워드 — 보수적으로 (오판 방지: 흔한 단어 제외). */
export const STREAM_DETECT_KEYWORDS: readonly string[] = [
  "방송", "생중계", "스트리밍", "생방송",
  "streaming", "broadcast", "live stream", "going live",
  "配信", "生放送", "生中継",
];

/** 생성문에 방송 시작 정황이 있는지 (대소문자 무시 부분 일치). */
export function matchesStreamKeywords(text: string): boolean {
  const hay = text.toLowerCase();
  return STREAM_DETECT_KEYWORDS.some((kw) => hay.includes(kw.toLowerCase()));
}

/**
 * 키워드 트리거 기본 사전 — 폰/문자/카메라/스트리밍 계열 한·영·일 3개 국어.
 * 사용자 추가분(`customKeywords`)과 합쳐 대소문자 무시 부분 일치로 검사한다.
 */
export const PHONE_DEFAULT_KEYWORDS: readonly string[] = [
  // 한국어
  "폰", "휴대폰", "핸드폰", "스마트폰", "전화", "문자", "메시지", "메세지",
  "카메라", "사진", "셀카", "SNS", "스트리밍", "방송", "생방송", "디엠",
  // English
  "phone", "smartphone", "text message", "texting", "texted", "message",
  "camera", "photo", "selfie", "streaming", "stream", "broadcast", "DM",
  // 日本語
  "携帯", "スマホ", "電話", "メッセージ", "メール", "カメラ", "写真",
  "自撮り", "配信", "放送",
];

/** 생성문에 폰 키워드가 있는지 (기본 사전 + 사용자 추가, 대소문자 무시). */
export function matchesPhoneKeywords(
  text: string,
  customKeywords: string[] | undefined
): boolean {
  const hay = text.toLowerCase();
  for (const kw of PHONE_DEFAULT_KEYWORDS) {
    if (hay.includes(kw.toLowerCase())) return true;
  }
  for (const kw of customKeywords ?? []) {
    const k = kw.trim().toLowerCase();
    if (k && hay.includes(k)) return true;
  }
  return false;
}
