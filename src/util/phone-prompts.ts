/**
 * 스텔라 폰 — 엔진 고정 프롬프트 조각.
 *
 * 폰의 행동 지시문(누가 어떻게 쓰는지)은 전부 편집 가능한 미디어 프롬프트
 * (`phoneText`/`phoneExtra`/`phoneSns` 버킷)에 있다. 여기에는 엔진이 응답을
 * 파싱하기 위해 강제하는 **입출력 프로토콜**만 둔다 — 번역의
 * TRANSLATION_IO_INSTRUCTIONS 와 같은 지위. 편집 모달 상단에 반투명으로
 * 표시되어 사용자가 형식을 보고 프롬프트를 구성할 수 있다.
 */

/** SNS 생성 헤더 — 출력 형식 최우선 선언 (스토리 출력 규칙 무력화). */
export const PHONE_SNS_HEADER =
  "[STELLA NETWORK — SOCIAL FEED GENERATION. This task COMPLETELY OVERRIDES " +
  "any story/roleplay/status-block output rules. Output raw JSON only — no " +
  "narration, no markup, no <status>, no code fences.]";

/**
 * SNS 출력 JSON 프로토콜 v2 — cap(활동 총합 상한)·최소 새 글·신규 계정 상한을
 * 받아 완성한다. 파서(`parseSnsActivities`)와 짝이므로 편집 대상이 아니다.
 * 이슈 등급 판정(§6.2)·반응 분배(§6.3)·계정 재등장(§6.1)은 고정 IO 규칙.
 */
export function buildSnsIoInstructions(
  cap: number,
  opts?: {
    minNewPosts?: number;
    newAccountCap?: number;
    /** §6.4 — 현재 최상단 이슈 상태 (없으면 첫 최상단 선정 배치). */
    boom?: { idShort: string; scale: number; turns: number; mustReplace: boolean };
    /** 뷰어(페르소나)의 가장 최근 게시글 id 앞 8자 — 댓글 열린 두 번째 글. */
    viewerPostIdShort?: string;
    /** AI 의 사진 게시 허용 (§5.2, 기본 켬) — 끄면 photo 필드를 뺀다. */
    allowPhoto?: boolean;
    /**
     * 이번 배치에 세션 새 진행분이 있는가 (v3 사건/일상 축). false = 잡담 모드:
     * 새 플롯 사건 발명 금지, 일상글과 기존 이슈 반응만.
     */
    hasNews?: boolean;
    /** 새 글 중 사건과 무관한 "일상글" 목표 비율 % (기본 70, 잡담 모드는 100). */
    dailyRatioPct?: number;
    /**
     * "여파 글" 상한 (기본 1, 0=끔). 사건을 못 본 사람이 공개적 파장에만
     * 반응하는 글 — 진행분이 있을 때(hasNews)만 의미가 있다.
     */
    bystanderCap?: number;
    /**
     * 배치 활동 중 캐스트(등급 1·2 = 세계의 실제 인물) 비율 하한 % (§V3-4,
     * 기본 70). 엔진이 초과 엑스트라 활동을 잘라내므로 지시와 짝이다.
     */
    namedRatioPct?: number;
    /**
     * 스텔라튜브 자동 시작 판정 허용 (§7.2) — 열린 세션 + 방송 없음일 때만.
     * castNames = 그 장면 속 인물 명부(스트리머 후보). 엔진도 이 명부로 거른다.
     */
    tubeStart?: { castNames: string[] };
  }
): string {
  const minPosts = Math.max(0, opts?.minNewPosts ?? 2);
  const newCap = Math.max(0, opts?.newAccountCap ?? 3);
  const allowPhoto = opts?.allowPhoto !== false;
  const boom = opts?.boom;
  const openIds = [
    ...(boom ? [`id=${boom.idShort} (the TOP ISSUE)`] : []),
    ...(opts?.viewerPostIdShort
      ? [`id=${opts.viewerPostIdShort} (the viewer's latest post)`]
      : []),
  ];
  return (
    `## OUTPUT — raw JSON array only. Two item shapes:\n` +
    `{"account":"@handle (existing account) OR omit and give author+handle+world for a new one",` +
    `"author":"display name","handle":"@handle","verified":false,` +
    `"world":"world name","kind":"post","issueScale":2,"text":"...","likes":34,` +
    (allowPhoto
      ? `"photo":"<optional short photo description, only if a real photo>",`
      : "") +
    `"boom":false,` +
    `"comments":[{"account":"@h","author":"name","world":"world name",` +
    `"to":null,"text":"...","likes":3}]}\n` +
    `{"account":"@h","author":"name","world":"world name",` +
    `"kind":"comment","on":"<feed id>","to":"<name or null>","text":"...","likes":0,` +
    `"issueScale":null,"boom":false}\n` +
    `Rules:\n` +
    `- Produce 1 to ${cap} activities total (each post and each comment counts one).\n` +
    (minPosts > 0
      ? `- At least ${minPosts} of them must be NEW posts (kind "post"), not comments.\n`
      : "") +
    `- REUSE the known accounts list whenever someone fitting exists — the same ` +
    `netizens keep living on this feed. Refer to them by "account":"@handle". ` +
    `Invent at most ${newCap} brand-new accounts per batch; activity by an ` +
    `unlisted person beyond that is DISCARDED, so pick from the lists.\n` +
    `- At least ${Math.min(100, Math.max(0, opts?.namedRatioPct ?? 70))}% of ` +
    `all activity (posts and comments) must come from THE CAST — the named ` +
    `people of these worlds. Extras are seasoning, not the main course; ` +
    `activity over that share is discarded.\n` +
    (openIds.length > 0
      ? `- Comments may ONLY target these OPEN posts: ${openIds.join(" and ")}. ` +
        `Every other feed item is settled — its conversation is over; it exists ` +
        `as context only. Dogpiling an open post with several comments is welcome.\n`
      : `- Do not write "comment" items this batch — no post is open for ` +
        `comments. New posts may still carry their own "comments".\n`) +
    (boom
      ? `- The current TOP ISSUE (id=${boom.idShort}, scale ${boom.scale}) has ` +
        `held the top of the feed for ${boom.turns} batch(es). It grows ONLY ` +
        `while it keeps drawing real reactions — comment on it only if people ` +
        `would genuinely still be talking about it at its scale; if it no ` +
        `longer deserves attention, leave it alone and it fades on its own. ` +
        `Set "boom":true on ONE new post (or on a comment — meaning its target ` +
        `post) ONLY IF that story is NARRATIVELY a bigger deal than the ` +
        `current top issue — judged by stakes and drama in the fiction, not by ` +
        `comparing scale numbers. If nothing truly outgrows it, set no "boom".\n` +
        (boom.mustReplace
          ? `- MANDATORY: the current top issue has run its course after ` +
            `${boom.turns} batches — the network has moved on. You MUST mark ` +
            `"boom":true on the strongest new story this batch.\n`
          : "")
      : `- The feed has no reigning top issue. Mark "boom":true on the ONE new ` +
        `post that is the biggest story of this batch.\n`) +
    // ── 사건 축 / 일상 축 (v3) ── 세션이 안 굴러가는데 SNS 만 스토리를 밀고
    // 나가던 문제의 핵심 규칙. 사건은 "새로 벌어진 일" 블록에서만 나온다.
    (opts?.hasNews === false
      ? `- NOTHING NEW has happened in the stories since the last batch. Do ` +
        `NOT invent, advance, resolve, or escalate any plot event — the ` +
        `stories move only when the player plays them. This batch is ` +
        `ordinary life: what these people are doing off-screen right now ` +
        `(meals, work, commutes, hobbies, boredom, selfies, complaints, ` +
        `cross-world small talk) plus reactions to what is already in the ` +
        `feed.\n`
      : `- ONLY the block marked "JUST HAPPENED" is news. Background blocks ` +
        `are there so nobody contradicts their own situation — never post ` +
        `about them as if they were new. Do not invent plot events beyond ` +
        `what JUST HAPPENED says; the stories move only when the player ` +
        `plays them.\n` +
        `- About ${Math.min(100, Math.max(0, opts?.dailyRatioPct ?? 70))}% of ` +
        `the new posts must be ORDINARY LIFE unrelated to those events — ` +
        `what these people are doing off-screen when the player is not ` +
        `watching. That off-screen life is the point of this feed, not ` +
        `event commentary.\n`) +
    `- Nobody writes a report on someone else's business. A person posts ` +
    `about an event only if they lived it; everyone else reacts to POSTS, ` +
    `not to events they never witnessed.\n` +
    // 여파 축 — 위 규칙을 그대로 두면 "사건의 파장을 맞은 동네 사람"이 통째로
    // 사라진다(사용자 지적). 내막은 여전히 모르고, 자기 하루가 겪은 일만 쓴다.
    (opts?.hasNews !== false && (opts?.bystanderCap ?? 1) > 0
      ? `- FALLOUT — at most ${Math.floor(opts?.bystanderCap ?? 1)} post(s) ` +
        `this batch: someone from that world who did NOT witness the event, ` +
        `writing about how its PUBLIC fallout hit THEIR OWN day — sirens all ` +
        `night, a street sealed off, the shop shut, power out, their commute ` +
        `wrecked, a rumor half-heard at work, a friend of a friend who says ` +
        `something happened. They do NOT know what actually happened, do NOT ` +
        `name people or details they could not have seen, and do NOT comment ` +
        `on those involved. It is a complaint or a scare about their own day, ` +
        `never coverage of someone else's story.\n`
      : "") +
    `- "world" is REQUIRED for any new account: the listed world that person ` +
    `belongs to. Viewers see it under the name.\n` +
    `- "issueScale" (posts, REQUIRED): how big this is as an issue, judged ` +
    `REALISTICALLY and coldly — 1 nobody cares, 2 everyday chatter, ` +
    `3 niche/community issue, 4 national issue, 5 world-scale issue. Most ` +
    `posts are 1-2. NEVER inflate; never flatter the viewer's posts.\n` +
    `- Reaction mix per post: ~80% comes from people the algorithm matched — ` +
    `interested and friendly. Dissent/argument grows with scale: none at 1-2, ` +
    `up to ~15% at 3, ~30% at 4, ~40% at 5.\n` +
    `- Commenters do NOT need to be from the post's world — this is ONE shared ` +
    `feed across all worlds. Mix in outsiders from other listed worlds reacting ` +
    `without inside knowledge.\n` +
    `- React to the viewer's posts at the level their scale deserves (a scale-2 ` +
    `post gets 1-2 reactions) — no special treatment, but people who know them ` +
    `from the events react first.\n` +
    `- A "comment" may set "issueScale" to RAISE the target post's scale when ` +
    `the event has visibly grown into a bigger issue (never lower it).\n` +
    `- Most new posts already carry 1-3 comments reacting to each other.\n` +
    `- "verified":true (press/official/celebrity) ONLY on posts/comments about ` +
    `a scale 4-5 issue — they ignore small news.\n` +
    `- "likes" follow the scale: 1 → 1-2, 2 → 3-99, 3 → 100-999, ` +
    `4 → 1000-9999, 5 → 10000+. Comment likes 0-40.\n` +
    `- "to" = the commenter being replied to (nested), null = on the post.\n` +
    `- 🔴 LIVE broadcast: only people NOT in that scene react as viewers; ` +
    `someone visibly inside the scene must not comment on it.\n` +
    (allowPhoto ? `- At most one post includes "photo", only when natural.\n` : "") +
    (opts?.tubeStart
      ? `- OPTIONAL: if the newest scene in the events clearly shows someone ` +
        `actively streaming/broadcasting live RIGHT NOW — camera rolling, ` +
        `audience watching, in this very moment — include ONE ` +
        `{"kind":"stream_start","streamer":"<name>"} item (does not count ` +
        `toward the cap). The streamer MUST be one of: ` +
        `${opts.tubeStart.castNames.map((n) => `"${n}"`).join(", ")} — never ` +
        `the viewer. Talking about, watching, planning, or remembering a ` +
        `broadcast is NOT one. Omit it otherwise — most batches have none.\n`
      : "") +
    `- Each text short (1-3 sentences), in that person's own voice.`
  );
}

/** 편집 모달 표시용 — 활동 상한 숫자는 실제로는 폰 설정값이 들어간다. */
export const PHONE_SNS_IO_INSTRUCTIONS = `${PHONE_SNS_HEADER}\n\n${buildSnsIoInstructions(10)}`;

/** 스텔라튜브 채팅 생성 헤더 — 출력 형식 최우선 선언 (스토리 출력 규칙 무력화). */
export const PHONE_TUBE_HEADER =
  "[STELLATUBE — LIVE STREAM CHAT GENERATION. This task COMPLETELY OVERRIDES " +
  "any story/roleplay/status-block output rules. Output raw JSON only — no " +
  "narration, no markup, no code fences.]";

/**
 * 스텔라튜브 반응 출력 JSON 프로토콜 (v2 §7.3) — 파서(`parseTubeReaction`)와
 * 짝이므로 편집 대상이 아니다. viewers 는 엔진이 직전값 대비 ±60% 클램프.
 */
export function buildTubeIoInstructions(opts: {
  prevViewers: number;
  newAccountCap: number;
}): string {
  return (
    `## OUTPUT — raw JSON object only:\n` +
    `{"viewers": ${opts.prevViewers}, "streamState": "on", "chat": [` +
    `{"account":"@handle (existing) OR omit and give name+handle+world for a new one",` +
    `"name":"display name","handle":"@h","world":"world name",` +
    `"text":"...","donation":5000}]}\n` +
    `Rules:\n` +
    `- "chat": 3-10 short lines reacting to the NEWEST part of the broadcast.\n` +
    `- REUSE the known accounts list whenever someone fitting exists (refer by ` +
    `"account":"@handle"). Invent at most ${opts.newAccountCap} brand-new ` +
    `accounts.\n` +
    `- People visibly inside the broadcast scene must NOT appear in chat.\n` +
    `- "donation" (optional, rare): amount only on a genuinely donation-worthy ` +
    `line — most lines have none.\n` +
    `- "viewers": current live viewer count — drift naturally from the ` +
    `previous count (${opts.prevViewers}).\n` +
    `- "streamState": "on" while the broadcast continues; "closing" ONLY when ` +
    `the scene clearly shows it wrapping up or ending. When unsure, "on".`
  );
}

/** 편집 모달 표시용 — 실제 숫자는 방송 상태값이 들어간다. */
export const PHONE_TUBE_IO_INSTRUCTIONS = `${PHONE_TUBE_HEADER}\n\n${buildTubeIoInstructions(
  { prevViewers: 1200, newAccountCap: 3 }
)}`;

/** 방송 시작 판정 헤더 — 출력 형식 최우선 선언 (스토리 출력 규칙 무력화). */
export const PHONE_STREAM_DETECT_HEADER =
  "[STELLATUBE — BROADCAST DETECTION. This task COMPLETELY OVERRIDES any " +
  "story/roleplay/status-block output rules. Output raw JSON only — no " +
  "narration, no markup, no code fences.]";

/**
 * 방송 시작 판정 프로토콜 — 키워드가 걸린 장면을 모델이 실제로 읽고 "지금 이
 * 장면에서 방송이 진행 중인가 / 누가 켰는가"를 판정한다. 파서
 * (`parseStreamDetect`)와 짝이므로 편집 대상이 아니다. 스트리머 후보 명부를
 * 함께 주고 그 안에서만 고르게 한다 — 장면 밖 인물이 스트리머가 되는 것 방지.
 */
export function buildStreamDetectIoInstructions(opts: {
  castNames: string[];
  viewerName: string;
}): string {
  const cast =
    opts.castNames.length > 0
      ? opts.castNames.map((n) => `"${n}"`).join(", ")
      : "(none listed — then answer live:false)";
  return (
    `## OUTPUT — raw JSON object only:\n` +
    `{"live": false, "streamer": null, "reason": "one short clause"}\n` +
    `Rules:\n` +
    `- "live": true ONLY IF the scene shows someone actually broadcasting/` +
    `streaming to an audience RIGHT NOW, in this moment of the scene.\n` +
    `- Answer false for: talking ABOUT a broadcast, watching someone else's ` +
    `stream, remembering or planning one, a past broadcast, a broadcast that ` +
    `already ended, or the word appearing in an unrelated sense. When in ` +
    `doubt, answer false — a wrong "true" hijacks the player's story.\n` +
    `- "streamer": the exact name of the person running the broadcast, as ` +
    `written in the scene. Known cast: ${cast}. Prefer these exact names; ` +
    `if the broadcaster is a different person clearly present in the scene ` +
    `(a side character from the lore), give their exact name as it appears ` +
    `in the text.\n` +
    `- The viewer "${opts.viewerName}" is the audience, NOT a candidate — ` +
    `never name them as the streamer.\n` +
    `- If no specific person in the scene is running the broadcast, answer ` +
    `live:false.`
  );
}

/** 편집 모달 표시용 — 실제 명부는 그 세션의 등장인물이 들어간다. */
export const PHONE_STREAM_DETECT_IO_INSTRUCTIONS = `${PHONE_STREAM_DETECT_HEADER}\n\n${buildStreamDetectIoInstructions(
  { castNames: ["<이 장면의 등장인물들>"], viewerName: "<플레이어>" }
)}`;

/** 로어북 인물 선별 헤더 — 출력 형식 최우선 선언 (스토리 출력 규칙 무력화). */
export const PHONE_CAST_HEADER =
  "[STELLA NETWORK — CAST EXTRACTION. This task COMPLETELY OVERRIDES any " +
  "story/roleplay/status-block output rules. Output raw JSON only — no " +
  "narration, no markup, no code fences.]";

/**
 * 로어북 인물 선별 프로토콜 (v3 §V3-4) — 세계관 시나리오의 로어북 엔트리에서
 * "계정을 가질 수 있는 사람"만 골라낸다. 파서(`parseSnsCast`)와 짝이므로 편집
 * 대상이 아니다. 결과는 등급 2 계정으로 계정 DB 에 영속된다.
 */
export function buildCastIoInstructions(opts: {
  world: string;
  cap: number;
}): string {
  return (
    `## OUTPUT — raw JSON array only:\n` +
    `[{"name":"exact person name","handle":"@handle","persona":"one short ` +
    `line: who they are and how they talk"}]\n` +
    `Rules:\n` +
    `- Only real INDIVIDUAL PEOPLE from "${opts.world}" who could plausibly ` +
    `hold a social-media account. Skip places, items, factions, events, ` +
    `terminology, rules, and group entries.\n` +
    `- Skip anyone already listed as a known account.\n` +
    `- "name": exactly as the lore writes it — no titles you invented.\n` +
    `- "handle": a short latin-letter handle starting with "@", plausible as ` +
    `that person's own username.\n` +
    `- "persona": one short line in the feed's language — their role and the ` +
    `way they would post. This is the only memo the feed keeps about them.\n` +
    `- At most ${opts.cap} people. If the lore holds no individual people, ` +
    `answer [].`
  );
}

/** 편집 모달 표시용 — 실제 세계 이름·상한은 설정값이 들어간다. */
export const PHONE_CAST_IO_INSTRUCTIONS = `${PHONE_CAST_HEADER}\n\n${buildCastIoInstructions(
  { world: "<세계 이름>", cap: 12 }
)}`;

/**
 * 문자 답장 출력 JSON 프로토콜 (v2 §3.2 시간차 배달) — 파서
 * (`parsePhoneReplyPlan`)와 짝이므로 편집 대상이 아니다. 답장 최대 지연이
 * 0(즉시 모드)이면 이 프로토콜 없이 v1 평문 출력을 쓴다.
 */
export function buildPhoneTextIoInstructions(
  maxDelaySec: number,
  bubbleTarget: number
): string {
  return (
    `## OUTPUT — raw JSON object only (no narration, no code fences):\n` +
    `{"read": true, "replyDelaySec": 30, "messages": [` +
    `{"text": "...", "delaySec": 4}, {"text": "...", "delaySec": 12}]}\n` +
    `- "read": false = they saw the notification but will NOT open or answer ` +
    `right now (busy mid-scene, asleep, sulking, leaving it on read). Then ` +
    `"messages" MUST be []. Use it when the fiction calls for it — being left ` +
    `on "1" is part of real texting.\n` +
    `- "replyDelaySec": seconds between reading and the first reply — 0 for an ` +
    `instant reply, up to ${maxDelaySec}. Fit the fiction: glued to their ` +
    `phone = fast, mid-conversation elsewhere or 3am = slow or read:false.\n` +
    `- Each "delaySec": typing gap (2-60s) since the previous bubble.\n` +
    `- This turn, aim for roughly ${bubbleTarget} message bubble(s). Vary the ` +
    `count naturally from turn to turn — do not simply match how many you ` +
    `sent before.`
  );
}
