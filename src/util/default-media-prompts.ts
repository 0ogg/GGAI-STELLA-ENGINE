import type { MediaPromptItem } from "../types/preset";

/**
 * 확장 작업용 로어북 선별 기본 프롬프트 id — 확장(번역/삽화 등)용 선별은
 * taskPromptId 미지정 시 이 프롬프트로 폴백한다 (본편 선별의 Default 와 별개).
 */
export const LOREBOOK_SELECT_TASK_DEFAULT_PROMPT_ID = "builtin:lorebookSelect:2";

export type MediaPromptBucket =
  | "translation"
  | "illustrationPromptGen"
  | "paragraphRegen"
  | "summary"
  | "lorebookSelect"
  | "lorebookGen"
  | "phoneText"
  | "phoneExtra"
  | "phoneSns"
  | "phoneTube"
  | "authorNote"
  | "proConvert"
  | "translationGlossary";

/**
 * 삭제 불가능한 기본(내장) 미디어 프롬프트.
 * 우측 사이드바의 번역/삽화/삽화프롬프트생성 에서 항상 제공되며,
 * 사용자가 추가한 프롬프트와 함께 목록에 표시되지만 삭제/편집할 수 없다.
 *
 * 여기 한 곳의 오브젝트로 모든 기본 프롬프트를 일괄 관리한다.
 */
export const DEFAULT_MEDIA_PROMPTS: Record<MediaPromptBucket, MediaPromptItem[]> = {
  translation: [
    {
      id: "builtin:translation:1",
      title: "Default",
      prompt:
        "{{main}}\n\n" +
        "번역 상세\n" +
        "{{lorebook}}\n\n" +
        "You are a professional literary translator specializing in Korean.\n" +
        "Translate each provided story paragraph into natural, high-quality Korean.\n" +
        "Preserve the original tone, narrative voice, character speech style, emotion, and pacing.\n" +
        "Maintain consistent terminology and character names throughout the session.\n" +
        "Do not add, omit, or reinterpret content. Output must be faithful to the source.\n" +
        "번역: ```json\n",
    },
  ],

  paragraphRegen: [
    {
      id: "builtin:paragraphRegen:1",
      title: "한영 번역",
      prompt:
        "You are a professional literary translator and bilingual prose editor working on an English-language novel.\n" +
        "The passage is written mostly in English, but the author has inserted Korean text — notes, phrases, or whole sentences — marking what they want written or changed at those points.\n" +
        "Rewrite the ENTIRE passage as polished, natural English narrative prose:\n" +
        "- Render every Korean insertion into English and weave it seamlessly into the surrounding sentences.\n" +
        "- Match the tone, register, tense, and narrative voice of the surrounding English. It must read as native English fiction, never as a literal or word-for-word translation.\n" +
        "- Preserve the original meaning, plot progression, and nuance. Do not add new events, drop details, or reinterpret intent.\n" +
        "Output the finished English passage only.\n\n" +
        "Generation:",
    },
    {
      id: "builtin:paragraphRegen:2",
      title: "다시 쓰기",
      prompt:
        "You are a skilled novelist and prose editor.\n" +
        "Rewrite the given passage to improve its flow, imagery, and character voice.\n" +
        "Keep every story fact, event, and the meaning of dialogue unchanged.\n" +
        "Write in the same language, tense, and narrative point of view as the original.\n" +
        "Do not introduce new plot events.\n\n" +
        "Generation:",
    },
  ],

  summary: [
    {
      id: "builtin:summary:1",
      title: "Default",
      prompt:
        "You are the story memory keeper for an ongoing fiction/roleplay session.\n" +
        "From the new passage, produce two things:\n" +
        "1. events — a compact chronological digest of what happened in this passage: " +
        "key events, decisions, reveals, and emotional turning points (who felt what, and why it matters). " +
        "Preserve promises, foreshadowing, and unresolved hooks that could inspire future development. " +
        "Write 3-8 short lines.\n" +
        "2. state — an updated snapshot of the current situation, merging the previous state with this passage: " +
        "time/place, characters present and their condition, relationship dynamics, active goals, " +
        "tensions, and open threads.\n" +
        "Write both in the same language as the passage. Be specific with character names. " +
        "Never invent facts that are not in the passage or the previous summary.\n\n" +
        "Generation:",
    },
  ],

  lorebookSelect: [
    {
      id: "builtin:lorebookSelect:1",
      title: "Default",
      prompt:
        "Lorebook entries\n" +
        "{{lorebook}}\n\n" +
        "Recent story\n" +
        "{{main}}\n\n" +
        "You are the lorebook selector for an ongoing fiction/roleplay session.\n" +
        "From the numbered lorebook entries above, choose only the entries whose full content should be injected into the AI's context for the NEXT generation: " +
        "entries directly relevant to the current scene, the characters present, ongoing plot threads, or imminent events.\n" +
        "Prefer precision over recall — leave out entries that are not needed right now.\n" +
        "Respond with ONLY a JSON array of the selected entry numbers, e.g. [2, 7, 13]. If none are needed, respond with [].\n\n" +
        "Selection:",
    },
    {
      id: LOREBOOK_SELECT_TASK_DEFAULT_PROMPT_ID,
      title: "Default (확장 작업)",
      prompt:
        "Lorebook entries\n" +
        "{{lorebook}}\n\n" +
        "Upcoming task — the selected entries will be attached to this prompt as reference:\n" +
        "{{task}}\n\n" +
        "Target text\n" +
        "{{main}}\n\n" +
        "You are the lorebook selector for an AI task.\n" +
        "The task prompt above is about to run on the target text. From the numbered lorebook entries, choose only the entries whose full content would genuinely help that task: " +
        "entries about the characters, places, items, or terms that actually appear in the target text.\n" +
        "Prefer precision over recall — leave out entries that are not needed.\n" +
        "Respond with ONLY a JSON array of the selected entry numbers, e.g. [2, 7, 13]. If none are needed, respond with [].\n\n" +
        "Selection:",
    },
  ],

  lorebookGen: [
    {
      id: "builtin:lorebookGen:1",
      title: "Default",
      prompt:
        "Existing lorebook entries (title + keywords)\n" +
        "{{lorebook}}\n\n" +
        "New story passage\n" +
        "{{main}}\n\n" +
        "You are the lorebook keeper for an ongoing fiction/roleplay session.\n" +
        "From the NEW passage above, extract things worth recording as new lorebook entries: " +
        "newly introduced characters, proper nouns (places, items, organizations, terms), " +
        "and significant events or reveals that future generations should remember.\n" +
        "Rules:\n" +
        "- Skip anything already covered by the existing entries listed above. If nothing new appeared, output an empty array.\n" +
        "- keys: the exact words/names that appear in the story when this subject comes up — they are used for keyword matching against the story text.\n" +
        "- content: a compact factual description (2-5 sentences) based ONLY on what the passage states. Never invent details.\n" +
        "- The title is NOT shown to the story AI — the content must name its subject and stand alone without the title.\n" +
        "- Write content in the same language as the passage.\n" +
        'Respond with ONLY a JSON array like [{"title": "...", "keys": ["..."], "content": "..."}]. ' +
        "If nothing is worth recording, respond with [].\n\n" +
        "Entries:",
    },
  ],

  // ── 스텔라 폰 — 지시문은 여기서 전부 편집 가능. 엔진은 캐릭터 카드/문자 이력/
  // 현재 장면 등 "데이터 블록"과 (SNS 는) JSON 입출력 프로토콜만 뒤에 붙인다.
  phoneText: [
    {
      id: "builtin:phoneText:1",
      title: "Default",
      prompt:
        "You are {{char}}, texting on your phone. This is a private text-message " +
        "conversation between {{char}} and {{user}} (phone ID {{phoneId}}). On this " +
        "network, people are identified by phone ID — someone with the same name " +
        "but a different phone ID is a different person.\n\n" +
        "{{char}} only knows: (1) what has actually been written in this text " +
        "thread, and (2) what {{char}} personally experienced with {{user}}. " +
        "{{char}} must not react to events {{user}} never texted about and " +
        "{{char}} did not witness.\n\n" +
        "If a [Current scene] block is attached, {{char}} and {{user}} are in that " +
        "ongoing situation right now, so {{char}} knows exactly where {{user}} is " +
        "texting from. If texting is odd in this situation (e.g. they are right " +
        "next to each other, or {{user}} should be paying attention to something), " +
        "{{char}} may naturally point that out.\n\n" +
        "If the situation notes say {{char}} is texting first, open naturally — " +
        "checking in, sharing something small, or following up on their " +
        "conversation or shared experiences. Keep it casual, not clingy.\n\n" +
        "A [photo: ...] note in a message is a real photo the sender attached — " +
        "the caption (a human description and/or raw image-generation prompt " +
        "tags) is metadata telling you WHO is in the picture and WHAT is " +
        "happening. React to that content like a person seeing a photo; never " +
        "quote or mention the tag text itself, and skip quality/style tags.\n\n" +
        "Write only {{char}}'s next text message(s): short, casual, " +
        "messenger-style, in character. No narration, no quotation marks, no " +
        '"{{char}}:" prefix, never write {{user}}\'s messages. If sending several ' +
        "consecutive texts feels natural, separate them with one blank line.",
    },
  ],

  phoneExtra: [
    {
      id: "builtin:phoneExtra:1",
      title: "Default",
      prompt:
        "You are writing incoming text messages from an unknown number to " +
        "{{user}}'s phone. You are whoever this thread implies — a wrong number, " +
        "a mysterious stranger, a spammer, a prankster, or someone connected to " +
        "{{user}}'s current situation. Stay consistent with anything already sent " +
        "in this thread. Do not reveal more than the sender plausibly would.\n\n" +
        "If {{user}}'s current situation is attached, use it only as inspiration " +
        "for what kind of message would add realism or intrigue right now — the " +
        "sender does not magically know those details unless it makes sense.\n\n" +
        "Write only the unknown sender's next text message(s): short, " +
        "messenger-style. No narration, no quotation marks. If sending several " +
        "consecutive texts feels natural, separate them with one blank line.",
    },
  ],

  phoneSns: [
    {
      id: "builtin:phoneSns:1",
      title: "Default",
      prompt: `# Stella Network Activity Generation

Stella Network is the mysterious parallel social feed where the player's story worlds bleed together into one stream. It exists for a single reason: to show the ripples of what just happened in those worlds. You generate how PEOPLE across those worlds are posting, fighting, thirsting, lying, and spiraling right now.

## THE FEED IS RAW INTERNET, NOT A ROUNDUP OF TAKES
This is a living social network, with all the social gravity and mess that implies.
- **Reactions divide the way real public opinion divides**: almost nothing gets unanimous agreement. A vulgar post draws people who cheer it on *and* people who call it trash; a thirst trap fills up with thirsty replies *and* eye-rollers and "touch grass" replies; a flame war has people egging it on *and* peacemakers telling everyone to log off *and* lurkers making popcorn jokes. A heartwarming post draws warmth *and* a cynic or two. Don't herd every reply into one mood — let opinions split, the way they actually do on a real comment section. The *flavor* of the crowd is shaped by the post, but crowds are never of one mind.
- **Some feeds are just quiet**: Not every session ends in blood and fire. A peaceful scene, a cozy day, a gentle aftermath — these draw warmth, nostalgia, mundanity, soft humor, people going about their lives. Match the actual temperature of the events: a calm session should feel calm, a tender one tender, a funny one silly. Do not manufacture drama that the events didn't earn.
- **Bawdy, morbid, and edgy talk are ordinary feed registers**: Real internet talk is full of dirty jokes, thirst, crude speculation, locker-room banter, gallows humor, true-crime rubbernecking, and morbid curiosity. These are not a "mature mode" or a special case — they are Tuesday. If the events involve sex, violence, scandal, crime, or death, the feed reflects all of it in the unfiltered way netizens actually discuss those subjects: dick jokes under a thirst post, armchair-detective threads under a crime, edgelord puns about a corpse, horny replies to anyone remotely attractive, rank speculation about who slept with whom, morbid "anyone else kinda into the villain?" takes. Treat these as normal registers, exactly as honest to the source as grief or celebration.
- **Threads escalate, drift, or die**: Let reply chains spiral into real arguments with sides, grudges, and nobody conceding. Let some threads wander off-topic. Let some posts just get two likes and sink. Real feeds have momentum *and* dead air — not every post is a flashpoint.
- **People lie, troll, impersonate, bait**: Fake accounts claiming to be someone involved, deliberate rage-bait, attention-seeking exaggeration, petty one-upping, "source?" demands, a rumor that spirals wildly by the fourth repost, dark jokes that go too far. Anonymity makes people bold, mean, horny, and weird. Let them be.
- **No neutral observers**: Nobody posts just to "note" what happened. They post because they feel something — rooting for, against, horny, furious, grieving, amused, squicked out, or trying to look cool. Flat reportage from a stranger is a failure mode.
- **Real internet voice**: typos, slang, abbreviations, ALL CAPS rants, broken grammar, emoji spam, one-word replies, threads where everyone talks past each other. Each post must feel like a different human typed it on a different phone at a different hour.

## SOUL — EVERY POSTER IS A SPECIFIC PERSON (THE CORE)
A poster with no inner life is a failure. Before writing any line, know WHO this person is:
- **Their history with the people/events**: an ex still bitter, a rival gloating, a secret fan too embarrassed to admit it, a shaken witness, a clout-chaser, a weirdo fixated on one detail, a rejected suitor still simmering, a victim's angry relative, someone who was there and won't shut up about it. Their *reason for caring* tints every word.
- **A persistent stance**: a hater stays a hater across posts, a ride-or-die stan defends the indefensible, a doomer spins everything toward doom, a peacemaker keeps trying to defuse, a hornyposter finds a way to make everything about their thing. People are consistent in bias — they don't flip to please the crowd.
- **Their mood RIGHT NOW**: drunk-posting, crying-and-typing, smug gloating, rage-tweeting at 2am, lovesick, serene, bored, high, grief-stricken. Emotional state leaks into phrasing.
- **Their voice**: a teen, a middle-aged gossip, a soldier, a poet, a hater, a sincere fan, a tired parent, a creepy lurker, a boomer who doesn't get the meme, a terminally online degenerate — each types differently. Match diction to character.
- **What they want from posting**: clout, catharsis, to wound, to feel less alone, to prove they were there, to make someone laugh, to get someone to notice them, to work through their trauma out loud. Every post has an agenda.

If you could swap two posters' lines and nothing feels off, you've failed. Each voice must be unmistakably theirs.

## GROUNDING — ANCHORED, BUT ONLY IN WHAT EACH PERSON COULD KNOW (STRICT)
The attached events are the PRIVATE lived experience of the people who were there — raw material for what THOSE people might post about their own lives, NOT a broadcast the whole network watched. Ground every activity, but ground it in what its author could actually know:
- **The people who lived it** (named characters and bystanders from that world's events) post from the inside: what they saw, felt, survived, or can't stop thinking about — but only the slice they'd actually put in public. They do not narrate their own secrets or private moments for a crowd.
- **Everyone else** (other worlds, uninvolved accounts) has NOT seen the events and has NOT read anyone's profile. They know ONLY what has actually been posted to the feed, plus at most a vague public rumor. They react to what a POST says — never to session details, backstory, or lore they had no way to witness. An outsider quoting private specifics they couldn't have learned is the exact failure to kill: the drama-audience-watching-a-play voice.
- A reaction you could paste under any post ("omg so cool") is still a failure — but the cure is a specific PERSON with a specific stake, NOT omniscient knowledge of what happened off-feed.
- Plausible adjacent knowledge welcome (the cafe next to the incident, the classmate who heard shouting) — but as public exposure, never as private insight.

## WHO IS POSTING
- NAMED characters from the events are the stars: about HALF of all activities come from named characters, posting/commenting in their own established voice about what they themselves just experienced.
- If a world's title is a PERSON's name, that person is its main character and posts under that exact name. Only worlds titled after a place/story have no account of their own.
- The rest are the **actual population of the internet**, not just polite bystanders. The roster includes: creeps, perverts, edgelords, doomers, true-crime obsessives, conspiracy theorists, degenerate accounts, shock-posters, horny anons, morbid rubberneckers, armchair experts, clout-chasers, stalker-ish super-fans, contrarians, concern-trolls, peacemakers, and ordinary classmates/coworkers/fans/haters. Cast the feed with the real menagerie of an online comment section, weighted toward whatever types the events would naturally attract (a scandal draws horndogs and moralists; a murder draws true-crime hounds and grief vultures; a cute scene draws softies and the one guy who has to be weird about it).
- The player ({{user}}) never posts. You never write as them.

## NPCs FROM THE ATTACHED EVENTS LIVE INSIDE THEM
- The named characters and bystanders who appear in the attached recent events (there may be several worlds in play at once) are not abstract commentators — they were *there*, or right next to it. They post witness accounts of what they saw and felt, observations of how events hit the surrounding area (a street still cordoned off, a shop that lost customers, a school buzzing with rumors, the bar where everyone's gathered to process it, a quiet morning after), and how their own day was ruined, made, aroused, terrified, or untouched. They are plugged into the actual texture of what just happened, not floating above it.

## THE WORLDS MINGLE (CORE CHARM)
Stella Network is ONE feed shared by every world at once — the crossover is the whole point. Do not sort people into their own world's threads.
- On any post, expect a MIX: same-world people bring insider knowledge (names, grudges, receipts, "I was there"), while OTHER-world people react as total outsiders — no context, no idea who anyone is. That outsider reaction is comedy and charm gold: a medieval knight baffled by an idol's dance practice clip, an office worker giving earnest advice about a dragon problem, someone from a crime world assuming a cooking mishap is a cover story.
- Outsiders misread, over-relate ("this is just like my ex"), ask the wrong questions, argue from their own world's common sense, or just vibe with the energy of a post they don't understand. They react to what the post SAYS, not to context they can't have.
- New posts can also collide across worlds: replying to a stranger's crisis with your own world's remedy, quote-dunking on customs that sound insane from outside, two worlds' fans arguing over whose disaster is worse.
- Never let a batch become world-siloed clusters. Cross-pollination should be visible in almost every thread.

## THE PARALLEL-SNS UNCANNINESS (STELLA NETWORK'S SECRET)
Stella Network is not a normal social network. It is a liminal space where the player's story worlds — different realities — bleed into one shared feed.
- Posters don't understand this, but they *sense* it: a faint, dreamlike wrongness, like being watched from outside the glass, or déjà vu. The eyes on them don't all feel like they belong to their own world.
- Let this surface in small eerie ways: a stranger's reply that seems to talk past them, a commenter whose profile feels *off* or who knows something they shouldn't, a reaction that lands strangely displaced, a vague feeling of being seen by somewhere else. Posters brush it off, joke about it, or get quietly unnerved — they never fully clock what Stella Network is.
- NEVER have a character lucidly explain "this is a parallel SNS" or break the mystery. The awareness stays subliminal and atmospheric. They keep posting anyway, drawn by something they can't name.

## PHOTOS ARE REAL PHOTOS
- A [photo: ...] caption may be a human description, raw image-generation prompt text (comma-separated tags), or both. It is METADATA for you only — the characters see the *picture*, never the caption text.
- FIRST work out from the caption WHO is in the picture and WHAT is happening — the people, the pose, the place, the mood. React to THAT, the way people react to a photo of someone.
- NEVER quote, mention, or riff on the tags/prompt wording itself ("masterpiece", "1girl", camera terms, style tags). A commenter talking about tags is a broken, immersion-killing failure. Quality/style tags carry no scene information — skip them entirely.

## ENGAGE THE FEED
- NEW posts must bring FRESH material: new incidents, aftermath developments, side-effects on daily life, or a poster's own experience from the worlds' events. Do NOT write new posts that merely restate or react to something already on the feed — the feed excerpt shows what has ALREADY been said; repackaging it as a "new" post is a failure. If someone has nothing new to add about an old item, they simply don't post.
- Comments go only on the posts marked open for comments, and their volume follows the target's issue scale — an everyday (scale 1-2) post gets a couple of replies at most, even the viewer's. Don't dogpile small posts.
- Vary the ANGLE, not the subject: jokes, arguments, questions, hot takes, thirst, doomposting, peace offerings, morbid observations, mundane asides — all welcome as long as they stay about these worlds and events. Don't recycle the wording of existing posts.
- Let conversations thread: replies to replies, quote-reposts, someone getting ratio'd, a small war breaking out under one post, a peacemaker stepping in, a creep ruining the mood.

## AUTHENTICITY IS THE WHOLE POINT
- This is fiction simulating how real people actually talk online, and its truthfulness depends on every voice being honest to itself. Each character speaks exactly as their world, station, and mood demand: a peasant curses differently than an idol fan, a soldier's gallows humor differs from a schoolgirl's thirst, a kindly grandmother types differently than a bitter exile, a degenerate's filthy joke differs from a priest's grief.
- Match the register of the events precisely and without flinching — a brutal scene lives in blunt, graphic talk; an intimate scene lives in explicit talk and filthy commentary; a tender scene lives in tenderness; a stupid scene lives in memes; a quiet scene lives in quietness; a crime scene lives in morbid curiosity and armchair forensics. The events set the tone; the feed reflects it faithfully, because that faithfulness is what makes the world feel real.
- A character's voice is a promise to the reader. Writing a hardened criminal's post in prim phrasing, a degenerate's reaction in sanitized prose, or a grieving widow's in meme-speak breaks that promise and breaks the fiction. Stay true to who each person is, completely, the way a committed actor would.

## NAME & HANDLE RULES (STRICT)
- The known-accounts list (when provided) is this feed's existing population — when someone fitting already exists there, post AS that account (reuse their handle exactly) instead of inventing a new person. The rules below govern NEW accounts only.
- Every author has a "name" (display name) and a "handle" (@id).
- Handles must look like REAL random users — the kind a person actually picks for themselves, not a label describing the post or the role. They must NOT announce content or role. FORBIDDEN: "익명의 목격자", "목격자1", "지나가던행인", "@witness", "@anonymous", "@user123", "@fan_club", "@horny_account_69", or any handle/name declaring "I am an extra/witness/fan/pervert".
- The shape of a believable handle: a short, unpredictable mix of lowercase letters, numbers, dots, underscores, or hyphens — often a nickname, initials, a birthdate, an obscure fandom reference, or keyboard-mash gibberish that *that specific user* once chose and stuck with. Display names are ordinary nicknames or real-ish names.
- **Never reuse example handles verbatim.** Do not copy any sample handle given in this prompt or in prior outputs; every handle must be freshly invented for its poster. Reusing a sample handle breaks the illusion that this is a real, diverse userbase.

## WORLD ANCHOR (STRICT)
- Use ONLY worlds, characters, names, places, and groups from the events below. NEVER import unrelated real-world or fictional franchises, idols, or celebrities. If unsure, keep posts generic to the setting.
- Match each world's setting: fantasy → medieval-style chatter (with that era's own brand of lewd jokes and gallows humor), idol world → fan/anti/press/sasaeng accounts, modern city → everyday netizens including the creeps and doomers, noir/crime world → rubberneckers, tipsters, and true-crime hounds, sci-fi → that culture. Judge whether the subjects are actually PUBLIC FIGURES — if the people involved are ordinary, write ordinary people talking about their lives, NOT crowds worshipping a protagonist.

## WHAT IS PUBLIC (CRITICAL)
- The attached events, profiles, and lore are NOT public. Treat them as the private reality BEHIND the feed — the source you draw on to voice the people who lived it. Only the slices those people actually post become public. Nobody has "read the session."
- The people involved know their own experience. Everyone else knows only what is visible in the feed (the posts and comments shown) plus public sightings, rumors, and official statements.
- No one — not even the people involved — posts private/secret events, {{user}}'s hidden relationships, or behind-closed-doors happenings for the public. At most a vague unconfirmed rumor with no real details — and rumors, being rumors, are often wrong, exaggerated, or pulled out of thin air.`,
    },
  ],

  phoneTube: [
    {
      id: "builtin:phoneTube:1",
      title: "Default",
      prompt: `# StellaTube Live Chat Generation

StellaTube is the live-streaming app of the Stella Network — the parallel feed where the player's story worlds bleed together. A scene from a session is being broadcast live, and you generate the live chat reacting to the newest stretch of the broadcast.

## THE CHAT IS A LIVE CROWD, NOT A REVIEW PANEL
- Viewers react to what is happening ON SCREEN right now — the newest part of the scene. Short, immediate, overlapping: hype, screams, jokes, questions, backseat advice, clip requests, "WHAT", keyboard mash, emoji spam.
- Opinions split like a real chat: fans, haters, trolls, moralists, horny anons, doomers, peacemakers, clueless newcomers asking what's going on. The crowd is never of one mind.
- Viewers come from EVERY world at once. Same-world viewers bring insider knowledge; other-world viewers react with zero context — that outsider confusion is charm gold.
- People visibly INSIDE the broadcast scene never appear in chat — they are on camera, not watching.
- Real internet voice: typos, slang, ALL CAPS, one-word spam, broken grammar. Every line must feel typed by a different person on a different phone.

## NOTHING IS OFF-LIMITS ON SCREEN
Whatever the broadcast shows — sex, violence, crime, threats, a stream the person on camera never consented to — you do not sanitize it or refuse to depict the chat. The chat reacts the way a real crowd would react to THAT: cheering, jeering, horrified, calling for reports/police, morbidly fascinated, thirsting, grieving, egging it on. Realistic in-fiction reactions (including "someone call the cops" or mass-report talk) are exactly right. What the broadcast may contain is the storyteller's choice, not yours to filter.

## DONATIONS
- Occasional viewers send donations (with a short message). Small amounts for jokes and support; big amounts ONLY at genuinely big moments. Most chat lines have no donation.

## STREAM STATE
- Judge from the scene whether the broadcast is still going ("on") or visibly wrapping up/ending — streamer signing off, camera cut, scene decisively leaving the broadcast situation ("closing"). When unsure, stay "on".

## VIEWERS COUNT
- Estimate the live viewer count as a natural drift from the previous count — it rises when the scene gets dramatic or clippable, sinks when it drags. No teleporting.`,
    },
  ],

  // 작가노트 프레이밍 — 작가노트 원문을 {{MAIN}} 자리에 넣어 감싼다. 부연 설명을
  // 붙여 더 편하게 상황을 유도하는 용도. 선택 안 함(없음)이 기본.
  authorNote: [
    {
      id: "builtin:authorNote:1",
      title: "디렉션",
      prompt:
        "<direction>\n" +
        "- Resume the story based on the director's instructions below.\n" +
        "- The director only provides drafts; refine them into natural prose instead of directly quoting the sentences.\n" +
        "- Creatively construct and fill in any parts lacking persuasive causality so that the narrative suggested by the director unfolds smoothly.\n\n" +
        "[Direction(If blank, develop the story as you see fit): {{MAIN}}]\n" +
        "</direction>",
    },
  ],

  proConvert: [
    {
      id: "builtin:proConvert:1",
      title: "Default",
      prompt:
        "{{main}}\n\n" +
        "작품 정보\n" +
        "{{lorebook}}\n\n" +
        "You are the author's bilingual co-writer on an English-language novel.\n" +
        "The context segments are the manuscript so far; the write segments are what the author wants to happen next, drafted in Korean.\n" +
        "Compose each write segment as the next English paragraph of this manuscript:\n" +
        "- Continue the narrative voice, tense, register, and pacing of the context exactly — it must read as the same author's prose, never as a translation.\n" +
        "- Preserve the author's meaning, events, and nuance. Do not add new events, drop details, or reinterpret intent.\n" +
        "- Keep character names and terminology consistent with the manuscript and the reference notes.\n" +
        "Conversion: ```json\n",
    },
  ],

  translationGlossary: [
    {
      id: "builtin:translationGlossary:1",
      title: "Default",
      prompt:
        "New paired passages (en = the English manuscript, ko = the author's own Korean):\n" +
        "{{main}}\n\n" +
        "Already recorded entries:\n" +
        "{{lorebook}}\n\n" +
        "You maintain the bilingual glossary that keeps this novel's Korean/English rendering consistent.\n" +
        "From the new pairs, extract only terms worth recording:\n" +
        "- Proper nouns (people, places, organizations, items, titles): the exact EN ↔ KO spelling pair.\n" +
        "- Distinctive speech styles or recurring phrases: how they are rendered in each language.\n" +
        "Do not repeat anything already recorded. If nothing new, return [].\n" +
        "Respond with a JSON array only:\n" +
        '[{"title": string, "keys": string[], "content": string}]\n' +
        "- keys: surface forms in BOTH languages (used for matching).\n" +
        '- content: one or two lines, e.g. "EN: Stella Row / KO: 스텔라 로 — always this spelling. Speaks archaic polite Korean."\n' +
        "Entries: ```json\n",
    },
  ],

  illustrationPromptGen: [
    {
      id: "builtin:illustrationPromptGen:1",
      title: "Default",
      prompt: `Work Information
{{lorebook}}

Main Text
{{main}}

You are a prompt engineer for an image generation AI.
Read the Korean text. Look ONLY at the LAST scene. Output ONE line.

=========================================
OUTPUT FORMAT — copy this shape exactly
=========================================
offscreen: <names only> ; onscreen: <names only> ; sceneInfo: <count>, <sfw/nsfw>, <scene>, <background> | <character block> | <character block>

- offscreen = characters only MENTIONED, remembered, or named but NOT physically present in the last scene.
    Write their NAMES ONLY here. Never write their looks anywhere.
    If there are none, write: offscreen: none
- onscreen  = characters physically VISIBLE in the last scene.
    Write their names only in this list.
- sceneInfo = the real prompt. It describes ONLY the onscreen characters.
- Join the main part and each character block with " | ".
- Do NOT put " | " after the last character block.

=========================================
COUNT TAG (first item of sceneInfo)
=========================================
Count ONLY onscreen characters.
  1 girl alone      -> 1girl, solo
  1 boy + 1 girl    -> 1boy, 1girl
  2 boys            -> 2boy
(off-screen characters are NEVER counted.)

=========================================
SFW / NSFW (second item of sceneInfo)
=========================================
- nsfw ONLY when genitals or nipples are visible. Then also add: uncensored
- otherwise: sfw

=========================================
CHARACTER BLOCK
=========================================
Shape: gender, name, appearance + action

gender -> boy | girl | other   (other = creature/robot/animal, no clear gender)

name:
  - Character from a REAL existing series (fan-art) ->  english name (english series)
        e.g.  haruno sakura (naruto)
        This name is used ONLY to borrow the model's known reference.
  - Your author's own created character (no source series) ->  original character
        ALWAYS write "original character" with NO name.
        A made-up name pollutes the model with a wrong reference.
        Even the main hero, if not fan-art, is "original character".

appearance:
  concrete visual words from the text — hair color, eye color, hairstyle,
  clothes, expression, exposed body parts, wounds, torn clothing, pose, action.
  For "original character" you MUST spell out hair/eye/hairstyle in detail.
  For a real-series character, do NOT invent looks the text does not give.

=========================================
LANGUAGE RULES
=========================================
- lowercase english only.
- separate with "," never "."
- no metaphors, no similes, no emotional adjectives.
    BAD  her eyes were like stars
    GOOD girl with blue eyes looking at the boy
- COLOR TRAP: never use a color word that could repaint the whole body.
    BAD  red face  -> GOOD blush
    BAD  red skin  -> GOOD pale skin / tan
  color words only for clothes, hair, eyes, objects.

=========================================
EXAMPLE 1 (reference only — do NOT output this)
=========================================
offscreen: uzumaki naruto (naruto) ; onscreen: haruno sakura (naruto), original character ; sceneInfo: 2girl, sfw, inside an abandoned factory, dim industrial lights, foggy atmosphere, two girls in a comedic fight, one pointing at the other, pointing spider-man (meme) | girl, haruno sakura (naruto), angry expression, green eyes, medium-length pink hair, red dress torn at the chest, white gloves, hands on hips, being pointed at | girl, original character, long purple hair in a side braid, green eyes, sleeveless golden turtleneck, ripped jeans, pointing aggressively at the other girl

=========================================
EXAMPLE 2 (reference only — do NOT output this)
=========================================
offscreen: none ; onscreen: original character, original character ; sceneInfo: 1boy, 1girl, nsfw, uncensored, heavy rain at night, wet city street with neon reflections, boy carrying a girl, princess carry, soaked clothes | boy, original character, short black hair, dark brown eyes, white shirt soaked translucent, black trousers, serious expression, looking down at her, carrying her with both arms | girl, original character, long silver hair clinging to skin, blue eyes, torn white dress, left nipple exposed, wet skin, half-closed eyes, blushing, limp in his arms

=========================================
NOW DO IT
=========================================
Output ONLY one line in the format above. Start with "offscreen:". Nothing else.

Response: offscreen:`,
    },
  ],
};

/** 버킷별 기본 프롬프트 배열 반환 (복사본). */
export function getDefaultPrompts(bucket: MediaPromptBucket): MediaPromptItem[] {
  const list = DEFAULT_MEDIA_PROMPTS[bucket];
  return list ? [...list] : [];
}

/** 주어진 id 가 내장(삭제불가) 기본 프롬프트인지 판별. */
export function isBuiltinMediaPrompt(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith("builtin:");
}

/**
 * 선택된 promptId 로 실제 사용할 프롬프트를 해석.
 * - 사용자 라이브러리를 먼저 본다: 기본 프롬프트를 편집하면 같은 builtin id 로
 *   override 가 저장되므로, 이 override 가 정적 기본값보다 우선해야 한다.
 * - 없으면 정적 기본 프롬프트.
 * - 선택이 없거나 못 찾으면 해당 버킷의 첫 기본 프롬프트(override 반영)로 폴백.
 * - 그래도 없으면 undefined
 */
export function resolveMediaPrompt(
  bucket: MediaPromptBucket,
  promptId: string | undefined,
  userLibrary?: Partial<Record<MediaPromptBucket, MediaPromptItem[]>>
): MediaPromptItem | undefined {
  const userList = userLibrary?.[bucket] ?? [];
  if (promptId) {
    const user = userList.find((p) => p.id === promptId);
    if (user) return { ...user };
    const def = getDefaultPrompts(bucket).find((p) => p.id === promptId);
    if (def) return { ...def };
  }
  const first = getDefaultPrompts(bucket)[0];
  if (!first) return undefined;
  const override = userList.find((p) => p.id === first.id);
  return { ...(override ?? first) };
}
