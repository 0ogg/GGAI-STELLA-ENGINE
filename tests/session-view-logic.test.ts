import assert from "node:assert/strict";
import type { StellaLorebook, StellaLorebookEntry } from "../src/types/lorebook";
import type { Span, StellaSession } from "../src/types/session";
import { defaultLorebookEntry } from "../src/types/lorebook";
import type { AgentDefinition } from "../src/types/agent";
import {
  extractAgentOutput,
  renderAgentPrompt,
  runAgent,
  runAgentBatch,
} from "../src/services/agent-runner";
import { parseNovelAILorebook } from "../src/import/parse-novelai";
import { buildContext, buildFallbackPreset } from "../src/util/context-builder";
import { paramsToOverride } from "../src/util/generation-params";
import { buildSummaryPrompt } from "../src/util/generate-summary";
import { applyMacros } from "../src/util/macros";
import { normalizeMessagesForChat } from "../src/util/normalize-messages";
import {
  buildSessionLog,
  hasSameTextState,
} from "../src/util/session-view-logic";
import {
  createEmptySessionIllustrations,
  createEmptySessionTranslations,
} from "../src/types/media";
import { createEmptySessionSummaries } from "../src/types/summary";
import {
  collectAnchorChain,
  composeSummaryContext,
  countGenerationsSince,
  extractNewPassage,
  parseSummaryResponse,
  planSummaryBoundaries,
  recordSummaryAnchor,
} from "../src/util/summarize-session";
import { buildSpans, spansToText } from "../src/util/session-text";
import {
  buildChatLog,
  buildChatMessages,
  CHAT_MESSAGE_SEPARATOR,
  chatRoleOfKind,
} from "../src/util/chat-messages";
import {
  buildChatEpisodeTailNodes,
  createBlankSession,
  planChatEpisodeTail,
} from "../src/util/new-session";
import { buildChatImportSession } from "../src/util/build-chat-import";
import {
  applyChatTurnNames,
  buildTextCompletionPrompt,
  trimChatCompletionOutput,
} from "../src/util/text-completion-prompt";
import type { ChatMessage } from "../src/util/context-builder";
import {
  SESSION_SEED_CHUNK_CHARS,
  splitTextByBudget,
} from "../src/util/split-passage";
import { getChildren } from "../src/util/session-tree";
import { buildNodeSegments } from "../src/util/node-segments";
import { recordIllustrationVariant } from "../src/util/illustrations";
import {
  completedParagraphsAfter,
  computeIllustrationAnchors,
  inlineAnchorOffset,
} from "../src/util/illustration-anchors";
import {
  anchorEndsParagraph,
  anchorSkipFinal,
  anchorSkipStreaming,
  buildAnchorInstruction,
  currentParagraphLength,
  extractAnchorSentence,
} from "../src/util/continuation-anchor";
import {
  buildTranslationRequest,
  chunkParagraphs,
  collectParagraphs,
  collectUntranslatedParagraphs,
  collectUntranslatedParagraphsFrom,
  getActiveTranslation,
  hashText,
  listTranslationVariants,
  parseTranslationResponse,
  pruneTranslationVariants,
  recordTranslationVariant,
  setActiveTranslationVariant,
  tokenizeParagraphs,
} from "../src/util/translate-paragraphs";

function makeSession(): StellaSession {
  return {
    schemaVersion: 1,
    meta: {
      id: "session",
      name: "Session",
      scenarioId: "scenario",
      mode: "novel",
      createdAt: 1,
      modifiedAt: 1,
      lastPlayedAt: 1,
      favorite: false,
      rootId: "root",
      activeLeafId: "leaf",
    },
    nodes: {
      root: {
        id: "root",
        parent: null,
        kind: "root",
        patches: [{ op: "append", spans: [{ author: "ai", text: "Hello" }] }],
        createdAt: 1,
      },
      leaf: {
        id: "leaf",
        parent: "root",
        kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: "Hi" }] }],
        createdAt: 2,
      },
    },
  };
}

function cloneSession(session: StellaSession): StellaSession {
  return JSON.parse(JSON.stringify(session)) as StellaSession;
}

function makeLorebook(
  entries: Partial<StellaLorebookEntry>[],
  recursiveScanning = false
): StellaLorebook {
  return {
    meta: {
      id: "lb",
      name: "Lorebook",
      description: "",
      thumbnail: null,
      scanDepth: null,
      tokenBudget: null,
      recursiveScanning,
      _source: "sillytavern",
    },
    entries: entries.map((entry, idx) => ({
      ...defaultLorebookEntry("sillytavern"),
      uid: `entry-${idx}`,
      name: "",
      addMemo: false,
      ...entry,
    })),
  };
}

const asyncTests: Promise<void>[] = [];

{
  const base = defaultLorebookEntry("novelai");
  const book = parseNovelAILorebook(
    {
      lorebookVersion: 6,
      entries: [
        {
          id: "nai-entry",
          displayName: "Always Active",
          text: "Imported NovelAI lore.",
          keys: ["keyword"],
          searchRange: 1000,
          enabled: true,
          forceActivation: true,
          category: "folder-id",
          keyRelative: true,
          nonStoryActivatable: true,
          contextConfig: {
            prefix: "",
            suffix: "\n",
            tokenBudget: 1,
            reservedTokens: 0,
            budgetPriority: 400,
            trimDirection: "trimBottom",
            insertionType: "newline",
            maximumTrimType: "sentence",
            insertionPosition: -1,
          },
          advancedConditions: [{ type: "random", chance: 50 }],
          loreBiasGroups: [{ phrases: ["ignored"], enabled: true }],
        },
      ],
      categories: [
        {
          id: "folder-id",
          name: "Folder",
          createSubcontext: true,
        },
      ],
      order: ["nai-entry"],
    },
    "NovelAI Sample"
  );
  const entry = book.entries[0];

  assert.equal(book.meta.name, "NovelAI Sample");
  assert.equal(book.meta._source, "novelai");
  assert.equal(entry.uid, "nai-entry");
  assert.equal(entry.name, "Always Active");
  assert.deepEqual(entry.keys, ["keyword"]);
  assert.equal(entry.content, "Imported NovelAI lore.");
  assert.equal(entry.enabled, true);
  assert.equal(entry.constant, true);
  assert.equal(entry.scanDepth, 1000);

  // NAI contextConfig is not ST position/depth. Unsupported placement,
  // category, and condition fields are imported as normal lorebook defaults.
  assert.equal(entry.position, base.position);
  assert.equal(entry.depth, base.depth);
  assert.equal(entry.role, base.role);
  assert.equal(entry.order, base.order);
  assert.equal(entry.group, "");
  assert.equal(entry.addMemo, false);
}

const testAgent: AgentDefinition = {
  id: "test-agent",
  name: "Test Agent",
  description: "Test",
  phase: "post_processing",
  enabledByDefault: false,
  promptTemplate: "Main={{mainResponse}} Recent={{recentContext}} Style={{style}}",
};

{
  assert.equal(
    renderAgentPrompt(testAgent, {
      mainResponse: "body",
      recentContext: "before",
      style: "quiet",
    }),
    "Main=body Recent=before Style=quiet"
  );
  assert.equal(
    extractAgentOutput(
      `<agent_output id="test-agent">\nfirst\n</agent_output>`,
      "test-agent"
    ),
    "first"
  );
}

asyncTests.push((async () => {
  const calls: any[] = [];
  const fakeAI = {
    async chat(req: any) {
      calls.push(req);
      return {
        text: "single result",
        stopReason: "end",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
  const result = await runAgent(
    testAgent,
    { mainResponse: "body", recentContext: "before", style: "quiet" },
    fakeAI as any,
    "profile"
  );
  assert.deepEqual(result, {
    agentId: "test-agent",
    output: "single result",
    tokensUsed: 15,
  });
  assert.equal(calls[0].profileId, "profile");
  assert.equal(calls[0].paramsOverride.maxTokens, 500);
  assert.equal(calls[0].messages[0].content.includes("Main=body"), true);
})());

asyncTests.push((async () => {
  const agents: AgentDefinition[] = [
    { ...testAgent, id: "a" },
    { ...testAgent, id: "b" },
  ];
  const fakeAI = {
    async chat() {
      return {
        text:
          `<agent_output id="a">alpha</agent_output>\n` +
          `<agent_output id="b">beta</agent_output>`,
        stopReason: "end",
        usage: { inputTokens: 20, outputTokens: 8 },
      };
    },
  };
  const result = await runAgentBatch(agents, {}, fakeAI as any);
  assert.deepEqual(result, [
    { agentId: "a", output: "alpha", tokensUsed: 28 },
    { agentId: "b", output: "beta", tokensUsed: 28 },
  ]);
})());

{
  const variables = { score: "2" };
  const out = applyMacros(
    [
      "{{setvar::chapter::3}}Chapter {{getvar::chapter}}",
      "{{addvar::score::5}}{{score}}",
      "{{incvar::score}}{{getvar::score}}",
      "{{decvar::score}}{{getvar::score}}",
      "{{// hidden note}}done",
    ].join(" / "),
    { variables }
  );

  assert.equal(out, "Chapter 3 / 7 / 8 / 7 / done");
  assert.deepEqual(variables, { score: "7", chapter: "3" });
}

{
  assert.equal(
    applyMacros("Style: {{choice:style}} / {{choice:Writing Style}}", {
      choices: {
        style: "lyrical",
        "Writing Style": "lyrical",
      },
    }),
    "Style: lyrical / lyrical"
  );
}

{
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(applyMacros("{{roll:2d6}}", {}), "1+1=2");
    assert.equal(applyMacros("{{dice:1d20}}", {}), "1");
    assert.equal(applyMacros("{{random:5:7}}", {}), "5");
    assert.equal(applyMacros("{{random::calm@1::tense@3}}", {}), "calm");

    Math.random = () => 0.99;
    assert.equal(applyMacros("{{random::calm@1::tense@3}}", {}), "tense");
  } finally {
    Math.random = originalRandom;
  }
}

{
  const variables = {};
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "sys",
          kind: "text",
          identifier: "sys",
          name: "System",
          role: "system",
          content: "{{setvar::mood::quiet}}{{getvar::mood}}",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [],
    variables,
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(out.messages.some((m) => m.content === "quiet"), true);
  assert.deepEqual(variables, { mood: "quiet" });
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      choices: [
        {
          id: "style",
          name: "Writing Style",
          multiSelect: false,
          random: false,
          options: [
            { id: "plain", label: "Plain", value: "plain prose" },
            { id: "lyrical", label: "Lyrical", value: "lyrical prose" },
          ],
        },
        {
          id: "tags",
          name: "Tags",
          multiSelect: true,
          random: false,
          options: [
            { id: "slow", label: "Slow", value: "slow pacing" },
            { id: "tense", label: "Tense", value: "tense mood" },
          ],
        },
      ],
      prompts: [
        {
          id: "sys",
          kind: "text",
          identifier: "sys",
          name: "System",
          role: "system",
          content: "{{choice:Writing Style}}\n{{choice:tags}}",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [],
    choiceValues: { style: ["lyrical"], tags: ["slow", "tense"] },
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(
    out.messages.some(
      (m) => m.content === "lyrical prose\nslow pacing\ntense mood"
    ),
    true
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "summary",
          kind: "marker",
          identifier: "chatSummary",
          name: "Chat Summary",
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [{ role: "assistant", content: "Current story." }],
    summary: "Earlier events were summarized here.",
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(
    out.messages.some(
      (m) =>
        m.source?.label === "Chat Summary" &&
        m.content === "Earlier events were summarized here."
    ),
    true
  );
}

{
  const prompt = buildSummaryPrompt({
    text: "A long scene.",
    previousSummary: "Earlier summary.",
    maxTokens: 300,
  });
  assert.equal(prompt.includes("Earlier summary."), true);
  assert.equal(prompt.includes("A long scene."), true);
  assert.equal(prompt.includes("300"), true);
}

{
  const spans: Span[] = [
    { author: "ai", text: "A" },
    { author: "ai", text: " continued" },
    { author: "user", text: "U" },
    { author: "ai", text: "B" },
  ];

  assert.deepEqual(buildSessionLog(spans, "chat"), [
    { role: "assistant", content: "A continued" },
    { role: "user", content: "U" },
    { role: "assistant", content: "B" },
  ]);

  // 이어쓰기 보정용 trailing user 턴은 더 이상 붙지 않는다 — 본문은 assistant 로 끝난다.
  assert.deepEqual(buildSessionLog(spans, "novel"), [
    { role: "assistant", content: "A continuedUB" },
  ]);

  assert.deepEqual(buildSessionLog(spans, "novel", { novelChatRoleMode: "split" }), [
    { role: "assistant", content: "A continued" },
    { role: "user", content: "U" },
    { role: "assistant", content: "B" },
  ]);
}

{
  const spans: Span[] = [
    { author: "ai", text: "A" },
    { author: "user", text: "U\n\n" },
  ];

  assert.deepEqual(buildSessionLog(spans, "novel"), [
    { role: "assistant", content: "AU\n\n" },
  ]);

  assert.deepEqual(buildSessionLog(spans, "novel", { novelChatRoleMode: "split" }), [
    { role: "assistant", content: "A" },
    { role: "user", content: "U\n\n" },
  ]);
}

{
  // 빈 메시지 제거 + 연속 role 병합. trailing user 턴은 주입하지 않는다.
  const messages = normalizeMessagesForChat([
    { role: "system", content: "S" },
    { role: "assistant", content: "A" },
    { role: "assistant", content: "B" },
    { role: "user", content: "  " },
  ]);

  assert.deepEqual(messages, [
    { role: "system", content: "S" },
    { role: "assistant", content: "A\n\nB" },
  ]);
}

{
  const base = makeSession();
  const metaOnly = cloneSession(base);
  metaOnly.meta.memory = "changed";
  metaOnly.meta.authorNote = "changed";
  metaOnly.meta.modifiedAt = 2;
  assert.equal(hasSameTextState(base, metaOnly), true);

  const differentLeaf = cloneSession(base);
  differentLeaf.meta.activeLeafId = "root";
  assert.equal(hasSameTextState(base, differentLeaf), false);

  const differentNode = cloneSession(base);
  const patch = differentNode.nodes.leaf.patches[0];
  assert.equal(patch.op, "append");
  if (patch.op === "append") patch.spans[0].text = "Changed";
  assert.equal(hasSameTextState(base, differentNode), false);
}

{
  const lorebook: StellaLorebook = {
    meta: {
      id: "lb",
      name: "Lorebook",
      description: "",
      thumbnail: null,
      scanDepth: null,
      tokenBudget: null,
      recursiveScanning: false,
      _source: "sillytavern",
    },
    entries: [
      {
        uid: "entry",
        name: "Constant entry",
        keys: [],
        secondaryKeys: [],
        useRegex: false,
        caseSensitive: null,
        matchWholeWords: null,
        selective: false,
        selectiveLogic: 0,
        content: "Lore that must reach the prompt.",
        enabled: true,
        constant: true,
        probability: 100,
        position: "after_char",
        depth: 4,
        role: "system",
        order: 100,
        scanDepth: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        group: "",
        groupWeight: 100,
        addMemo: true,
        _source: "sillytavern",
      },
    ],
  };
  const out = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [lorebook],
    sessionLog: [{ role: "assistant" as const, content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(out.matchedLorebookEntries.includes("Constant entry"), true);
  assert.equal(
    out.messages.some((m) => m.content.includes("Lore that must reach the prompt.")),
    true
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Missing marker fallback",
          content: "Lore survives without a world-info marker.",
          constant: true,
          position: "after_char",
        },
      ]),
    ],
    sessionLog: [{ role: "assistant" as const, content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  const loreIdx = out.messages.findIndex((m) =>
    m.content.includes("Lore survives without a world-info marker.")
  );
  const storyIdx = out.messages.findIndex((m) => m.content === "Story body.");
  assert.notEqual(loreIdx, -1);
  assert.notEqual(storyIdx, -1);
  assert.equal(loreIdx < storyIdx, true);
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "before",
          kind: "marker",
          identifier: "worldInfoBefore",
          name: "Lorebook Before",
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
        {
          id: "after",
          kind: "marker",
          identifier: "worldInfoAfter",
          name: "Lorebook After",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Before",
          content: "Lorebook before body.",
          constant: true,
          position: "before_char",
        },
        {
          name: "After",
          content: "Lorebook after body.",
          constant: true,
          position: "after_char",
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  // Prompt marker order is the source of truth: chatHistory expands exactly
  // where the identifier sits, even if a lorebook marker is after it.
  const beforeIdx = out.messages.findIndex((m) =>
    m.content.includes("Lorebook before body.")
  );
  const storyIdx = out.messages.findIndex((m) => m.content === "Story body.");
  const afterIdx = out.messages.findIndex((m) =>
    m.content.includes("Lorebook after body.")
  );
  assert.notEqual(beforeIdx, -1);
  assert.notEqual(storyIdx, -1);
  assert.notEqual(afterIdx, -1);
  assert.deepEqual(
    [beforeIdx < storyIdx, storyIdx < afterIdx],
    [true, true]
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "after",
          kind: "marker",
          identifier: "worldInfoAfter",
          name: "Lorebook After",
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          content: "Lorebook follows prompt order.",
          constant: true,
          position: "after_char",
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  const loreIdx = out.messages.findIndex((m) =>
    m.content.includes("Lorebook follows prompt order.")
  );
  const storyIdx = out.messages.findIndex((m) => m.content === "Story body.");
  assert.notEqual(loreIdx, -1);
  assert.notEqual(storyIdx, -1);
  assert.equal(loreIdx < storyIdx, true);
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "wi",
          kind: "marker",
          identifier: "worldInfoAfter",
          name: "Lorebook",
          enabled: false,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          content: "Disabled marker should suppress this.",
          constant: true,
          position: "after_char",
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(
    out.messages.some((m) => m.content.includes("Disabled marker should suppress this.")),
    false
  );
}

{
  const out = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook(
        [
          {
            name: "Seed",
            content: "The relic is called Solstice.",
            constant: true,
            position: "after_char",
          },
          {
            name: "Recursive hit",
            keys: ["Solstice"],
            content: "Solstice opens the old gate.",
            constant: false,
            position: "after_char",
          },
        ],
        true
      ),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(out.matchedLorebookEntries.includes("Recursive hit"), true);
  assert.equal(
    out.messages.some((m) => m.content.includes("Solstice opens the old gate.")),
    true
  );
}

{
  const out = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Lower group weight",
          content: "This grouped entry should lose.",
          constant: true,
          group: "mood",
          groupWeight: 10,
          order: 200,
        },
        {
          name: "Higher group weight",
          content: "This grouped entry should win.",
          constant: true,
          group: "mood",
          groupWeight: 50,
          order: 100,
        },
        {
          name: "Ungrouped",
          content: "Ungrouped entries should remain.",
          constant: true,
          group: "",
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(out.matchedLorebookEntries.includes("Higher group weight"), true);
  assert.equal(out.matchedLorebookEntries.includes("Lower group weight"), false);
  assert.equal(out.matchedLorebookEntries.includes("Ungrouped"), true);
  assert.equal(
    out.messages.some((m) => m.content.includes("This grouped entry should win.")),
    true
  );
  assert.equal(
    out.messages.some((m) => m.content.includes("This grouped entry should lose.")),
    false
  );
}

{
  const first = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Sticky dragon",
          keys: ["dragon"],
          content: "Dragon lore stays warm.",
          sticky: 2,
          constant: false,
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "A dragon appears." }],
    turnNumber: 10,
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });
  assert.equal(first.matchedLorebookEntries.includes("Sticky dragon"), true);

  const second = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Sticky dragon",
          keys: ["dragon"],
          content: "Dragon lore stays warm.",
          sticky: 2,
          constant: false,
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "No keyword here." }],
    timingStates: first.updatedTimingStates,
    turnNumber: 11,
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });
  assert.equal(second.matchedLorebookEntries.includes("Sticky dragon"), true);
  assert.equal(second.updatedTimingStates?.["lb:entry-0"]?.stickyRemaining, 1);
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "sys",
          kind: "text",
          identifier: "sys",
          name: "System",
          role: "system",
          content: "Prompt text.",
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Depth entry",
          content: "Injected lore.",
          constant: true,
          position: "at_depth",
          depth: 0,
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(
    out.messages.find((m) => m.content === "Prompt text.")?.contextKind,
    "prompt"
  );
  assert.equal(
    out.messages.find((m) => m.content === "Story body.")?.contextKind,
    "history"
  );
  assert.equal(
    out.messages.find((m) => m.content === "Injected lore.")?.contextKind,
    "injection"
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
        {
          id: "after",
          kind: "marker",
          identifier: "worldInfoAfter",
          name: "Lorebook After",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Depth entry",
          content: "Depth lore after story.",
          constant: true,
          position: "at_depth",
          depth: 0,
        },
        {
          name: "After entry",
          content: "Marker lore after history.",
          constant: true,
          position: "after_char",
        },
      ]),
    ],
    sessionLog: [
      { role: "assistant", content: "Story body." },
    ],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  const storyIdx = out.messages.findIndex((m) => m.content === "Story body.");
  const depthIdx = out.messages.findIndex((m) =>
    m.content.includes("Depth lore after story.")
  );
  const afterIdx = out.messages.findIndex((m) =>
    m.content.includes("Marker lore after history.")
  );
  assert.notEqual(storyIdx, -1);
  assert.notEqual(depthIdx, -1);
  assert.notEqual(afterIdx, -1);
  assert.equal(storyIdx < depthIdx, true);
  assert.equal(depthIdx < afterIdx, true);
}

{
  const first = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Cooldown constant",
          content: "Cooldown lore.",
          constant: true,
          cooldown: 2,
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    turnNumber: 10,
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });
  assert.equal(first.matchedLorebookEntries.includes("Cooldown constant"), true);

  const second = buildContext({
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Cooldown constant",
          content: "Cooldown lore.",
          constant: true,
          cooldown: 2,
        },
      ]),
    ],
    sessionLog: [{ role: "assistant", content: "Story body." }],
    timingStates: first.updatedTimingStates,
    turnNumber: 11,
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });
  assert.equal(second.matchedLorebookEntries.includes("Cooldown constant"), false);
  assert.equal(second.updatedTimingStates?.["lb:entry-0"]?.cooldownRemaining, 1);
}

{
  const delayed = {
    preset: buildFallbackPreset(),
    scenario: { name: "Char" },
    lorebooks: [
      makeLorebook([
        {
          name: "Delayed constant",
          content: "Delayed lore.",
          constant: true,
          delay: 2,
        },
      ]),
    ],
    sessionLog: [{ role: "assistant" as const, content: "Story body." }],
    tokenBudget: 10000,
    countTokens: (s: string) => s.length,
  };

  assert.equal(
    buildContext({ ...delayed, turnNumber: 1 }).matchedLorebookEntries.includes("Delayed constant"),
    false
  );
  assert.equal(
    buildContext({ ...delayed, turnNumber: 2 }).matchedLorebookEntries.includes("Delayed constant"),
    true
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "desc",
          kind: "marker",
          identifier: "charDescription",
          name: "Character Description",
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: {
      name: "Ari",
      description: "{{char}} writes letters to {{user}}.",
    },
    persona: { name: "Sola", description: "A careful reader." },
    lorebooks: [],
    sessionLog: [{ role: "assistant", content: "{{user}} enters the archive." }],
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.equal(
    out.messages.some((m) => m.content === "Ari writes letters to Sola."),
    true
  );
  assert.equal(
    out.messages.some((m) => m.content === "Sola enters the archive."),
    true
  );
  assert.equal(
    out.messages.some((m) => m.source?.label === "Scenario: description"),
    true
  );
  assert.equal(
    out.messages.some((m) => m.source?.label === "Session body"),
    true
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "mem",
          kind: "marker",
          identifier: "memory",
          name: "Memory",
          enabled: true,
        },
        {
          id: "an",
          kind: "marker",
          identifier: "authorNote",
          name: "Author's Note",
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    mode: "novel",
    sessionLog: [
      {
        role: "assistant",
        content: ["P1", "P2", "P3", "P4", "P5"].join("\n\n"),
      },
    ],
    memory: "Memory before body.",
    authorNote: "Author note inside body.",
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  const memoryIdx = out.messages.findIndex((m) => m.source?.type === "memory");
  const beforeIdx = out.messages.findIndex(
    (m) => m.source?.label === "Session body before author's note"
  );
  const noteIdx = out.messages.findIndex((m) => m.source?.type === "authorNote");
  const afterIdx = out.messages.findIndex(
    (m) => m.source?.label === "Session body after author's note"
  );
  assert.equal(memoryIdx !== -1 && beforeIdx !== -1, true);
  assert.equal(memoryIdx < beforeIdx, true);
  assert.equal(beforeIdx < noteIdx, true);
  assert.equal(noteIdx < afterIdx, true);
  assert.equal(out.messages[beforeIdx].content, "P1");
  assert.equal(out.messages[afterIdx].content, "P2\n\nP3\n\nP4\n\nP5");
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    mode: "novel",
    sessionLog: [
      {
        role: "assistant",
        content: ["P1", "P2", "P3", "P4", "P5"].join("\n\n"),
      },
    ],
    memory: "Memory without marker.",
    authorNote: "Author note without marker.",
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  const memoryIdx = out.messages.findIndex((m) => m.source?.type === "memory");
  const beforeIdx = out.messages.findIndex(
    (m) => m.source?.label === "Session body before author's note"
  );
  const noteIdx = out.messages.findIndex((m) => m.source?.type === "authorNote");
  const afterIdx = out.messages.findIndex(
    (m) => m.source?.label === "Session body after author's note"
  );
  assert.equal(out.messages[memoryIdx]?.content, "Memory without marker.");
  assert.equal(out.messages[noteIdx]?.content, "Author note without marker.");
  assert.equal(memoryIdx !== -1 && beforeIdx !== -1, true);
  assert.equal(memoryIdx < beforeIdx, true);
  assert.equal(beforeIdx < noteIdx, true);
  assert.equal(noteIdx < afterIdx, true);
}

{
  const sessionLog = buildSessionLog(
    [
      { author: "ai", text: "Visible story body." },
      { author: "user", text: "User edit." },
    ],
    "novel"
  );
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "sys",
          kind: "text",
          identifier: "sys",
          name: "System",
          role: "system",
          content: "S".repeat(1000),
          enabled: true,
        },
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog,
    tokenBudget: 1,
    countTokens: (s) => s.length,
  });

  assert.equal(
    out.messages.some(
      (m) => m.role === "assistant" && m.content === "Visible story body.User edit."
    ),
    false
  );
}

{
  const sessionLog = buildSessionLog(
    [
      { author: "ai", text: "Assistant body." },
      { author: "user", text: "User edit." },
    ],
    "novel",
    { novelChatRoleMode: "split" }
  );
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    mode: "novel",
    novelChatRoleMode: "split",
    sessionLog,
    tokenBudget: 10000,
    countTokens: (s) => s.length,
  });

  assert.deepEqual(
    out.messages
      .filter((m) => m.source?.type === "chat")
      .map((m) => ({ role: m.role, content: m.content })),
    [
      { role: "assistant", content: "Assistant body." },
      { role: "user", content: "User edit." },
    ]
  );
}

{
  const sessionLog = buildSessionLog(
    [
      { author: "ai", text: "Assistant body." },
      { author: "user", text: "User edit." },
    ],
    "novel"
  );
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog,
    tokenBudget: 1,
    countTokens: (s) => (s.startsWith("User edit.") ? 1 : 1000),
  });
  const assistantIdx = out.messages.findIndex(
    (m) => m.role === "assistant" && m.content === "Assistant body.User edit."
  );
  assert.equal(assistantIdx, -1);
}

{
  const longBody = "A".repeat(136590);
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [{ role: "assistant", content: longBody }],
    tokenBudget: 4096,
    countTokens: (s) => s.length,
  });

  assert.equal(out.tokensUsed <= 4096, true);
  assert.equal(
    out.messages.some((m) => m.content === longBody),
    false
  );
  // 잘림 마커를 본문에 끼우지 않는다 — 최근 끝부분만 남긴다.
  assert.equal(
    out.messages.some((m) => m.content.includes("[...truncated...]")),
    false
  );
  assert.equal(
    out.messages.some((m) => /^A+$/.test(m.content) && m.content.length > 0),
    true
  );
}

{
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    mode: "chat",
    sessionLog: [
      { role: "user", content: "old-" + "A".repeat(300) },
      { role: "assistant", content: "middle-" + "B".repeat(300) },
      { role: "user", content: "recent" },
      { role: "assistant", content: "latest" },
    ],
    tokenBudget: 250,
    countTokens: (s) => s.length,
  });

  // 경계 메시지는 앞을 버리고 끝(최근)만 남긴다 — 마커 없이.
  const truncated = out.messages.find((m) => m.content.endsWith("B"));
  assert.equal(truncated?.role, "assistant");
  assert.equal(truncated?.content.startsWith("middle-"), false); // 앞부분 버림
  assert.equal(truncated?.content.includes("[...truncated...]"), false); // 마커 없음
  assert.equal(truncated?.content.endsWith("B"), true);
  assert.equal(truncated?.source?.detail?.includes("truncated to fit budget"), true);
  assert.equal(
    out.messages.some((m) => m.content.startsWith("old-")),
    false
  );
  assert.equal(
    out.messages.some((m) => m.role === "user" && m.content === "recent"),
    true
  );
  assert.equal(
    out.messages.some((m) => m.role === "assistant" && m.content === "latest"),
    true
  );
  assert.equal(out.droppedLogTurns, 1);
}

{
  // 소설(병합) 모드: 본문이 한 덩어리라 예산 초과 시 최근(끝)을 남기고 앞을 버린다.
  const body =
    "OPENING-" + "a".repeat(400) + "\n\nMIDDLE-" + "b".repeat(400) + "\n\nENDING-" + "c".repeat(80);
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    mode: "novel",
    sessionLog: [{ role: "assistant", content: body }],
    tokenBudget: 250,
    countTokens: (s) => s.length,
  });

  // 앞(OPENING)은 버려지고, 최근 끝(ENDING)만 남는다 — 마커 없이.
  const bodyMsg = out.messages.find((m) => m.role === "assistant");
  assert.equal(bodyMsg?.content.includes("OPENING-"), false);
  assert.equal(bodyMsg?.content.includes("[...truncated...]"), false);
  assert.equal(bodyMsg?.content.endsWith("c"), true);
}

{
  // 회귀: split 모드 + 본문 끝에 오는 at_depth(depth 0) 로어북 + 예산 압박에서도
  // 가장 최근 본문(ENDMARK)이 유실되면 안 된다. (requiredTail 재정렬이 이미 들어간
  // 최근 턴을 제거해 버리던 버그.)
  const depthLore: StellaLorebook = {
    meta: {
      id: "lb",
      name: "LB",
      description: "",
      thumbnail: null,
      scanDepth: null,
      tokenBudget: null,
      recursiveScanning: false,
      _source: "sillytavern",
    },
    entries: [
      {
        uid: "e",
        name: "AtDepth0",
        keys: [],
        secondaryKeys: [],
        useRegex: false,
        caseSensitive: null,
        matchWholeWords: null,
        selective: false,
        selectiveLogic: 0,
        content: "DEPTH0-LORE",
        enabled: true,
        constant: true,
        probability: 100,
        position: "at_depth",
        depth: 0,
        role: "system",
        order: 100,
        scanDepth: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: false,
        group: "",
        groupWeight: 100,
        addMemo: false,
        _source: "sillytavern",
      },
    ],
  };
  const turns: { author: "ai" | "user"; text: string }[] = [];
  for (let i = 1; i <= 8; i++) {
    turns.push({ author: i % 2 ? "ai" : "user", text: `TURN${i} ` + "x".repeat(200) + ".\n\n" });
  }
  turns.push({ author: "ai", text: "ENDMARK last generated paragraph." });
  const log = buildSessionLog(turns, "novel", { novelChatRoleMode: "split" });
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        { id: "chat", kind: "marker", identifier: "chatHistory", name: "Chat History", enabled: true },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [depthLore],
    mode: "novel",
    novelChatRoleMode: "split",
    sessionLog: log,
    authorNote: "NOTE",
    tokenBudget: 900,
    countTokens: (s) => s.length,
  });
  assert.equal(
    out.messages.some((m) => m.content.includes("ENDMARK")),
    true
  );
}

{
  // 비-본문(메모리/작가노트/로어북/시스템)은 본문보다 먼저 확보돼야 한다. 본문이
  // 예산을 크게 넘겨도 이들이 밀려나면 안 되고, 본문만 최근부터 남는 예산을 채운다.
  const lore: StellaLorebook = {
    meta: { id: "lb", name: "LB", description: "", thumbnail: null, scanDepth: null, tokenBudget: null, recursiveScanning: false, _source: "sillytavern" },
    entries: [
      {
        uid: "e", name: "AtDepth", keys: [], secondaryKeys: [], useRegex: false, caseSensitive: null,
        matchWholeWords: null, selective: false, selectiveLogic: 0, content: "IMPORTANT-LORE", enabled: true,
        constant: true, probability: 100, position: "at_depth", depth: 2, role: "system", order: 100,
        scanDepth: null, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
        group: "", groupWeight: 100, addMemo: false, _source: "sillytavern",
      },
    ],
  };
  const hugeBody = "START-of-story. " + "word ".repeat(2000) + "END-of-story.";
  const out = buildContext({
    preset: {
      meta: { id: "p", name: "P", favorite: false },
      prompts: [
        { id: "sys", kind: "text", identifier: "main", name: "Main", role: "system", content: "SYSTEM-PROMPT.", enabled: true },
        { id: "chat", kind: "marker", identifier: "chatHistory", name: "CH", enabled: true },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [lore],
    mode: "novel",
    sessionLog: [{ role: "assistant" as const, content: hugeBody }],
    memory: "MEMORY-CONTENT-must-survive.",
    authorNote: "AUTHORNOTE-must-survive.",
    tokenBudget: 500,
    countTokens: (s) => s.length,
  });
  const all = out.messages.map((m) => m.content).join("\n");
  assert.equal(all.includes("MEMORY-CONTENT"), true);
  assert.equal(all.includes("AUTHORNOTE-must-survive"), true);
  assert.equal(all.includes("IMPORTANT-LORE"), true);
  assert.equal(all.includes("SYSTEM-PROMPT"), true);
  assert.equal(all.includes("END-of-story"), true); // 본문 최근부는 유지
  assert.equal(all.includes("START-of-story"), false); // 본문 도입부는 트리밍
}

{
  const within = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [{ role: "assistant", content: "A".repeat(650) }],
    tokenBudget: 1000,
    maxOutputTokens: 300,
    countTokens: (s) => s.length,
  });
  assert.equal(within.adjustedMaxOutputTokens, 300);

  const crowded = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [{ role: "assistant", content: "A".repeat(850) }],
    tokenBudget: 1000,
    maxOutputTokens: 300,
    countTokens: (s) => s.length,
  });
  // 입력이 붐벼도 출력 토큰은 줄이지 않는다 — 요청값 유지.
  assert.equal(crowded.adjustedMaxOutputTokens, 300);
  assert.deepEqual(
    paramsToOverride(
      { maxContext: 1000, maxOutputTokens: 300, temperature: 0.8 },
      "text",
      crowded.adjustedMaxOutputTokens
    ),
    { temperature: 0.8, max_tokens: 300 }
  );
  assert.deepEqual(
    paramsToOverride(
      { maxContext: 1000, maxOutputTokens: 300, temperature: 0.8 },
      "chat",
      crowded.adjustedMaxOutputTokens
    ),
    { temperature: 0.8, maxTokens: 300 }
  );

  const unsetOutput = buildContext({
    preset: {
      meta: { id: "p", name: "Preset", favorite: false },
      prompts: [
        {
          id: "chat",
          kind: "marker",
          identifier: "chatHistory",
          name: "Chat History",
          enabled: true,
        },
      ],
    },
    scenario: { name: "Char" },
    lorebooks: [],
    sessionLog: [{ role: "assistant", content: "A".repeat(650) }],
    tokenBudget: 1000,
    countTokens: (s) => s.length,
  });
  // 요청값이 없으면 기본 출력 토큰(1024)을 그대로 쓴다.
  assert.equal(unsetOutput.adjustedMaxOutputTokens, 1024);
  assert.deepEqual(
    paramsToOverride(
      { maxContext: 1000, temperature: 0.8 },
      "text",
      unsetOutput.adjustedMaxOutputTokens
    ),
    { temperature: 0.8, max_tokens: 1024 }
  );
}

{
  // 문단 토큰화 — 구분자 보존, 같은 내용 문단은 해시 공유.
  const text = 'AA.\n\n"BB."\nCC.\n\n"BB."';
  const tokens = tokenizeParagraphs(text);
  assert.equal(
    tokens.map((t) => (t.kind === "separator" ? t.text : t.source)).join(""),
    text
  );
  const paras = tokens.filter(
    (t): t is { kind: "paragraph"; hash: string; source: string } =>
      t.kind === "paragraph"
  );
  assert.equal(paras.length, 4);
  assert.equal(paras[1].hash, paras[3].hash); // 중복 문단 = 같은 해시
  assert.deepEqual(
    collectParagraphs(text).map((para) => para.source),
    ["AA.", "\"BB.\"", "CC."]
  );
  assert.deepEqual(tokenizeParagraphs(""), []);

  // 미번역 수집 + 요청 조립 (직전 문맥 포함).
  const translations = createEmptySessionTranslations();
  recordTranslationVariant(translations, { source: "AA.", text: "가가.", now: 1 });
  const untranslated = collectUntranslatedParagraphs(text, translations);
  assert.deepEqual(
    untranslated.map((para) => para.source),
    ["\"BB.\"", "CC."]
  );
  const req = buildTranslationRequest(text, untranslated);
  // 첫 대상 앞의 번역된 문단은 context 로 포함된다.
  assert.deepEqual(
    req.map((seg) => [seg.role, seg.source]),
    [
      ["context", "AA."],
      ["translate", "\"BB.\""],
      ["translate", "CC."],
    ]
  );

  // 자동 번역 경계 — fromOffset 이후에 끝나는 미번역 문단만 (과거 본문 제외).
  // text = 'AA.\n\n"BB."\nCC.\n\n"BB."' 에서 CC. 는 offset 11~14.
  assert.deepEqual(
    collectUntranslatedParagraphsFrom(text, translations, 12).map((p) => p.source),
    ['CC.', '"BB."']
  );
  // 끝 이후 offset 이면 아무것도 없음.
  assert.deepEqual(
    collectUntranslatedParagraphsFrom(text, translations, text.length),
    []
  );

  // 청크 분할 — 문단 수 / 글자 수 중 먼저 차는 기준. 거대 단일 문단은 혼자 한 청크.
  const mk = (source: string) => ({ hash: hashText(source), source });
  assert.deepEqual(
    chunkParagraphs([mk("aa"), mk("bb"), mk("cc"), mk("dd")], 2, 1000).map(
      (chunk) => chunk.map((p) => p.source)
    ),
    [["aa", "bb"], ["cc", "dd"]]
  );
  assert.deepEqual(
    chunkParagraphs([mk("aaaa"), mk("bbbb"), mk("cc")], 10, 6).map((chunk) =>
      chunk.map((p) => p.source)
    ),
    [["aaaa"], ["bbbb", "cc"]]
  );
  assert.deepEqual(
    chunkParagraphs([mk("xxxxxxxxxx"), mk("y")], 10, 4).map((chunk) =>
      chunk.map((p) => p.source)
    ),
    [["xxxxxxxxxx"], ["y"]]
  );
  assert.deepEqual(chunkParagraphs([], 8, 3000), []);
}

{
  // 번역 응답 파싱 — 순수 JSON / 코드펜스 / 필드 누락 / 실패.
  assert.deepEqual(
    parseTranslationResponse('[{"id":"a","translation":"안녕"}]'),
    [{ id: "a", translation: "안녕" }]
  );
  assert.deepEqual(
    parseTranslationResponse(
      'Here:\n```json\n[{"id":"a","translation":"안녕"},{"id":"b","translation":"세계"}]\n```'
    ),
    [
      { id: "a", translation: "안녕" },
      { id: "b", translation: "세계" },
    ]
  );
  assert.deepEqual(
    parseTranslationResponse('[{"id":"a","translation":"안녕"},{"id":"b"}]'),
    [{ id: "a", translation: "안녕" }]
  );
  assert.equal(parseTranslationResponse("no json here"), null);
}

{
  // variant 기록 — 키는 문단 원문 해시. 첫 번역은 ai-translation, 재번역은 regen.
  const translations = createEmptySessionTranslations();
  const v1 = recordTranslationVariant(translations, {
    source: "원문 문단.",
    text: "v1",
    now: 10,
  });
  const hash = hashText("원문 문단.");
  assert.equal(v1.kind, "ai-translation");
  assert.equal(v1.sourceHash, hash);
  assert.equal(translations.paragraphs[hash].source, "원문 문단.");
  assert.equal(getActiveTranslation(translations, hash)?.text, "v1");

  const v2 = recordTranslationVariant(translations, {
    source: "원문 문단.",
    text: "v2",
    now: 20,
  });
  assert.equal(v2.kind, "translation-regen");
  const v3 = recordTranslationVariant(translations, {
    source: "원문 문단.",
    text: "v3",
    kind: "user-edit",
    now: 30,
  });
  assert.equal(v3.kind, "user-edit");
  assert.equal(getActiveTranslation(translations, hash)?.text, "v3");
  // 원문이 바뀌면 다른 키 — 기존 번역과 분리.
  assert.equal(getActiveTranslation(translations, hashText("원문 문단!")), null);
}

{
  // buildNodeSegments — replace/delete 편집이 섞여도 최종 본문을 정확히 재구성하고
  // 각 구간을 마지막으로 쓴 노드에 귀속시킨다 (번역 치환 표시의 기반).
  const session: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "s3",
      name: "S3",
      scenarioId: "sc",
      mode: "novel",
      createdAt: 1,
      modifiedAt: 1,
      lastPlayedAt: 1,
      favorite: false,
      rootId: "root",
      activeLeafId: "d",
    },
    nodes: {
      root: {
        id: "root",
        parent: null,
        kind: "root",
        patches: [{ op: "append", spans: [{ author: "ai", text: "AAAA. " }] }],
        createdAt: 1,
      },
      a: {
        id: "a",
        parent: "root",
        kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: "BBBB. " }] }],
        createdAt: 2,
      },
      // a 의 가운데를 교체 → a 가 두 조각으로 쪼개짐.
      b: {
        id: "b",
        parent: "a",
        kind: "user-edit",
        patches: [
          { op: "replace", from: 8, to: 10, spans: [{ author: "user", text: "XY" }] },
        ],
        createdAt: 3,
      },
      // 루트 앞부분 삭제.
      c: {
        id: "c",
        parent: "b",
        kind: "user-edit",
        patches: [{ op: "delete", from: 0, to: 2 }],
        createdAt: 4,
      },
      d: {
        id: "d",
        parent: "c",
        kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: "CCCC." }] }],
        createdAt: 5,
      },
    },
  };

  const segments = buildNodeSegments(session, "d");
  // 세그먼트 이어붙이기 = buildSpans 본문과 정확히 동일.
  assert.equal(
    segments.map((s) => s.text).join(""),
    spansToText(buildSpans(session, "d"))
  );
  // 귀속: root 잘린 앞부분 → a 앞조각 → b 교체분 → a 뒷조각 → d 추가분.
  assert.deepEqual(segments, [
    { nodeId: "root", text: "AA. " },
    { nodeId: "a", text: "BB" },
    { nodeId: "b", text: "XY" },
    { nodeId: "a", text: ". " },
    { nodeId: "d", text: "CCCC." },
  ]);
  // append 체인만 있을 때는 노드별 한 구간씩.
  assert.deepEqual(buildNodeSegments(session, "a"), [
    { nodeId: "root", text: "AAAA. " },
    { nodeId: "a", text: "BBBB. " },
  ]);
  assert.deepEqual(buildNodeSegments(session, "missing"), []);
}

{
  // 되돌리기 / 정렬 / 다이어트.
  const translations = createEmptySessionTranslations();
  const v1 = recordTranslationVariant(translations, { source: "P", text: "v1", now: 10 });
  recordTranslationVariant(translations, { source: "P", text: "v2", now: 20 });
  recordTranslationVariant(translations, { source: "P", text: "v3", now: 30 });
  const hash = hashText("P");

  assert.deepEqual(
    listTranslationVariants(translations, hash).map((v) => v.text),
    ["v1", "v2", "v3"]
  );
  assert.deepEqual(listTranslationVariants(translations, "unknown"), []);

  assert.equal(setActiveTranslationVariant(translations, hash, v1.id), true);
  assert.equal(getActiveTranslation(translations, hash)?.text, "v1");
  assert.equal(setActiveTranslationVariant(translations, hash, "no-such"), false);
  assert.equal(setActiveTranslationVariant(translations, "missing", v1.id), false);

  assert.equal(pruneTranslationVariants(translations, hash), 2);
  assert.deepEqual(
    listTranslationVariants(translations, hash).map((v) => v.id),
    [v1.id]
  );
  assert.equal(getActiveTranslation(translations, hash)?.text, "v1");
  assert.equal(pruneTranslationVariants(translations, hash), 0);
  assert.equal(pruneTranslationVariants(translations, "missing"), 0);

  // sourceHash 는 원문이 같으면 같고 다르면 다르다.
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
}

{
  // 인라인 삽화 앵커 규칙 — 노드 기여 끝 지점 → 문단 경계.
  const text = "A.\n\nB.";
  // 기여가 구분자 안/직전에서 끝남(문단 완성) → 구분자 건너뛰고 다음 문단 시작.
  assert.equal(inlineAnchorOffset(text, 3), 4);
  assert.equal(inlineAnchorOffset(text, 2), 4);
  // 본문 끝 미완 꼬리에서 끝남 → 그 문단 앞.
  assert.equal(inlineAnchorOffset(text, 6), 4);
  // 문단 중간에서 끝남 + 앞에 구분자 없음 → 본문 맨 앞.
  assert.equal(inlineAnchorOffset("ABC", 2), 0);
  // 본문 끝 줄바꿈에서 끝남 → 본문 끝.
  assert.equal(inlineAnchorOffset("A.\n", 3), 3);
  assert.equal(inlineAnchorOffset("", 0), 0);

  // 완성 문단 수(자동 인라인 밀도 게이트) — 꼬리 미완 문단은 세지 않는다.
  assert.equal(completedParagraphsAfter("A.\nB.\nC", 0), 2);
  assert.equal(completedParagraphsAfter("A.\nB.\nC", 3), 1);
  assert.equal(completedParagraphsAfter("A.\n\nB.\n", 0), 2);
  assert.equal(completedParagraphsAfter("A.", 0), 0);
}

{
  // computeIllustrationAnchors — 활성 경로의 삽화 노드마다 앵커, 저장 상태 없이 계산.
  // 본문: "알파 문단.\n\n베타 문단 끝.\n\n감마 문단."
  //  - root 는 "베타 " 중간에서 끝남 → 베타 문단 앞(offset 8).
  //  - a 는 본문 끝(미완 꼬리 취급)에서 끝남 → 감마 문단 앞(offset 18).
  const session: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "s4",
      name: "S4",
      scenarioId: "sc",
      mode: "novel",
      createdAt: 1,
      modifiedAt: 1,
      lastPlayedAt: 1,
      favorite: false,
      rootId: "root",
      activeLeafId: "a",
    },
    nodes: {
      root: {
        id: "root",
        parent: null,
        kind: "root",
        patches: [
          { op: "append", spans: [{ author: "ai", text: "알파 문단.\n\n베타 " }] },
        ],
        createdAt: 1,
      },
      a: {
        id: "a",
        parent: "root",
        kind: "ai-continue",
        patches: [
          { op: "append", spans: [{ author: "ai", text: "문단 끝.\n\n감마 문단." }] },
        ],
        createdAt: 2,
      },
      // root 기여 전체 삭제 브랜치 — root 앵커가 사라져야 한다.
      b: {
        id: "b",
        parent: "a",
        kind: "user-edit",
        patches: [{ op: "delete", from: 0, to: 11 }],
        createdAt: 3,
      },
    },
  };
  const illustrations = createEmptySessionIllustrations();
  recordIllustrationVariant(illustrations, { nodeId: "root", path: "assets/r.png" });
  recordIllustrationVariant(illustrations, { nodeId: "a", path: "assets/a.png" });
  // 삽화 없는 노드는 앵커 없음 + offset 오름차순.
  assert.deepEqual(computeIllustrationAnchors(session, illustrations, "a"), [
    { nodeId: "root", offset: 8 },
    { nodeId: "a", offset: 18 },
  ]);
  // 노드 기여가 편집으로 전부 사라지면 인라인 앵커도 없다 (갤러리에는 유지).
  assert.deepEqual(computeIllustrationAnchors(session, illustrations, "b"), [
    { nodeId: "a", offset: 7 },
  ]);
  // 삽화가 하나도 없으면 빈 배열.
  assert.deepEqual(
    computeIllustrationAnchors(session, createEmptySessionIllustrations(), "a"),
    []
  );
}

{
  // 세션 요약 — 노드 앵커 누적 (summaries.json 순수 로직).
  const session: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "s",
      name: "S",
      scenarioId: "sc",
      mode: "novel",
      createdAt: 1,
      modifiedAt: 1,
      lastPlayedAt: 1,
      favorite: false,
      rootId: "root",
      activeLeafId: "c",
    },
    nodes: {
      root: {
        id: "root",
        parent: null,
        kind: "root",
        patches: [{ op: "append", spans: [{ author: "ai", text: "Start." }] }],
        createdAt: 1,
      },
      a: {
        id: "a",
        parent: "root",
        kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: " A." }] }],
        createdAt: 2,
      },
      b: {
        id: "b",
        parent: "a",
        kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: " B." }] }],
        createdAt: 3,
      },
      c: {
        id: "c",
        parent: "b",
        kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: " C." }] }],
        createdAt: 4,
      },
      // c 의 재생성 형제 — 다른 분기.
      d: {
        id: "d",
        parent: "b",
        kind: "ai-regen",
        patches: [{ op: "append", spans: [{ author: "ai", text: " D." }] }],
        createdAt: 5,
      },
    },
  };

  const summaries = createEmptySessionSummaries();
  recordSummaryAnchor(summaries, {
    nodeId: "b",
    events: "E1",
    state: "S1",
    now: 10,
  });
  recordSummaryAnchor(summaries, {
    nodeId: "c",
    fromNodeId: "b",
    events: "E2",
    state: "S2",
    now: 20,
  });

  // 경로 위 앵커 수집 — c 경로는 [b, c], 재생성 분기 d 경로는 [b] 만 (c 자동 제외).
  assert.deepEqual(
    collectAnchorChain(session, summaries, "c").map((x) => x.nodeId),
    ["b", "c"]
  );
  assert.deepEqual(
    collectAnchorChain(session, summaries, "d").map((x) => x.nodeId),
    ["b"]
  );

  // {{summary}} 합성 — 사건 요약 시간순 나열 + 마지막 앵커의 현재 상황.
  assert.equal(
    composeSummaryContext(collectAnchorChain(session, summaries, "c")),
    JSON.stringify({ pastEvents: ["E1", "E2"], currentState: "S2" }, null, 2)
  );
  assert.equal(
    composeSummaryContext(collectAnchorChain(session, summaries, "d")),
    JSON.stringify({ pastEvents: ["E1"], currentState: "S1" }, null, 2)
  );
  assert.equal(composeSummaryContext([]), "");

  // 요약 주기 카운트 — 마지막 앵커 이후의 AI 생성 노드만.
  assert.equal(countGenerationsSince(session, "c"), 3); // 앵커 없음 → a,b,c
  assert.equal(countGenerationsSince(session, "c", "b"), 1); // c
  assert.equal(countGenerationsSince(session, "d", "b"), 1); // d
  assert.equal(countGenerationsSince(session, "b", "b"), 0);

  // 새 패시지 추출 — 앵커 시점 본문과의 공통 접두사 이후.
  const textAtB = spansToText(buildSpans(session, "b"));
  const textAtC = spansToText(buildSpans(session, "c"));
  assert.equal(extractNewPassage(textAtB, textAtC), " C.");
  assert.equal(extractNewPassage("", textAtC), textAtC);
  // 앞부분이 편집으로 바뀌면 바뀐 지점부터 다시 패시지로 잡힌다.
  assert.equal(extractNewPassage("AB.CD", "AB!CD"), "!CD");

  // 같은 노드 재기록은 createdAt 유지 + 내용 갱신.
  const updated = recordSummaryAnchor(summaries, {
    nodeId: "c",
    fromNodeId: "b",
    events: "E2'",
    state: "S2'",
    now: 30,
  });
  assert.equal(updated.createdAt, 20);
  assert.equal(updated.updatedAt, 30);
  assert.equal(summaries.anchors["c"].events, "E2'");

  // 응답 파싱 — 코드펜스/앞뒤 잡음 허용, 형식 불일치는 null.
  assert.deepEqual(parseSummaryResponse('{"events":"e","state":"s"}'), {
    events: "e",
    state: "s",
  });
  assert.deepEqual(
    parseSummaryResponse('```json\n{"events":"e","state":"s"}\n```'),
    { events: "e", state: "s" }
  );
  assert.equal(parseSummaryResponse('{"events":"e"}'), null);
  assert.equal(parseSummaryResponse("not json"), null);
  assert.equal(parseSummaryResponse('{"events":"","state":"  "}'), null);
}

{
  // 이어쓰기 이음새 보정 — 앵커(마지막 문장) 추출.
  assert.equal(
    extractAnchorSentence("첫 문장이다. 마지막 문장이다."),
    "마지막 문장이다."
  );
  // 종결 부호 + 닫는 따옴표 조합.
  assert.equal(
    extractAnchorSentence('그가 물었다. "정말 가려고?" 나는 고개를 끄덕였다.'),
    "나는 고개를 끄덕였다."
  );
  // 줄바꿈도 문장 경계다.
  assert.equal(extractAnchorSentence("앞 문단 끝\n새 문단 시작"), "새 문단 시작");
  // 소수점은 경계가 아니다.
  assert.equal(
    extractAnchorSentence("무게를 쟀다. 정확히 3.5킬로그램이었다"),
    "정확히 3.5킬로그램이었다"
  );
  // 인용 삽입의 홀로 있는 따옴표는 문장을 가르지 않는다.
  assert.equal(
    extractAnchorSentence('먼저 왔다. 그가 "안녕" 하고 인사했다'),
    '그가 "안녕" 하고 인사했다'
  );
  // 말줄임표(…) / "..." 연속 부호도 경계.
  assert.equal(extractAnchorSentence("그래서… 그는 떠났다"), "그는 떠났다");
  assert.equal(extractAnchorSentence("글쎄... 모르겠다"), "모르겠다");
  // 일본어: 마침표(。) 뒤 공백이 없어도 문장 경계.
  assert.equal(
    extractAnchorSentence("「行くぞ」と彼は言った。彼女は黙って頷いた。"),
    "彼女は黙って頷いた。"
  );
  // 중국어: 물음표/마침표 전각 부호도 공백 없이 경계.
  assert.equal(
    extractAnchorSentence("他站了起来。她看着窗外，轻声问。"),
    "她看着窗外，轻声问。"
  );
  // 일본어 말줄임표는 문장 중간 포즈 — 무공백 …에서 문장을 쪼개지 않는다
  // (조각 앵커를 받은 모델이 완결 발화로 오해해 이음새가 깨진다).
  assert.equal(
    extractAnchorSentence("扉が開いた。そうか……彼は目を閉じた。"),
    "そうか……彼は目を閉じた。"
  );
  // 여는 따옴표 + 말줄임으로 시작하는 미완 대사 — 「…부터 통째로 앵커.
  assert.equal(
    extractAnchorSentence("一瞬で鉄になった。\n\n「…ご主人様？"),
    "「…ご主人様？"
  );
  // 종결 부호 + 전각 닫는 괄호(。」) 뒤에 바로 이어지는 문장.
  assert.equal(
    extractAnchorSentence("「もう行こう。」彼は歩き出した。"),
    "彼は歩き出した。"
  );
  // 마지막 문장이 너무 짧으면 앞 문장까지 포함.
  assert.equal(extractAnchorSentence("긴 문장이 있었다. 끝."), "긴 문장이 있었다. 끝.");
  // 미완성 꼬리(종결 부호 없음)도 그대로 앵커가 된다 + 뒤 공백 제거.
  assert.equal(extractAnchorSentence("완결. 그는 천천히 손을  \n"), "그는 천천히 손을");
  // 빈 본문 → null.
  assert.equal(extractAnchorSentence("   \n  "), null);
  // 경계가 전혀 없는 초장문은 뒤에서 단어 경계로 자른다.
  const longRun = "가나다라 ".repeat(100).trim();
  const capped = extractAnchorSentence(longRun)!;
  assert.ok(capped.length <= 240);
  assert.ok(longRun.endsWith(capped));
  assert.ok(!capped.startsWith(" "));

  // 지시문에는 앵커 문장이 그대로 들어간다.
  assert.ok(buildAnchorInstruction("마지막 문장.").includes("마지막 문장."));
  // 문단이 이미 길면 "곧 문단을 닫으라"는 지시가 덧붙고, 짧으면 없다.
  assert.ok(
    buildAnchorInstruction("마지막 문장.", 300).includes("already long")
  );
  assert.ok(
    !buildAnchorInstruction("마지막 문장.", 50).includes("already long")
  );
  // 마지막 문단 실질 글자 수 — 마지막 줄바꿈 이후만 센다.
  assert.equal(currentParagraphLength("앞 문단\n가나다 라마"), 5);
  assert.equal(currentParagraphLength("줄바꿈 없는 본문"), 7);
  assert.equal(currentParagraphLength("앞 문단\n꼬리  \n  "), 2);

  const anchor = "그는 천천히 문을 열었다.";
  // 정확 반복 → 반복 제거 후 이어지는 부분만.
  assert.equal(
    anchorSkipFinal(anchor + " 차가운 바람이 불어왔다.", anchor),
    anchor.length
  );
  // 선행 공백/따옴표 잡음 + 공백 차이 허용.
  const fuzzy = '  "그는  천천히 문을 열었다. 바람이 불었다.';
  const skipFuzzy = anchorSkipFinal(fuzzy, anchor);
  assert.equal(fuzzy.slice(skipFuzzy).trimStart(), "바람이 불었다.");
  // 반복 없이 바로 이어쓴 응답은 그대로(0) 사용.
  assert.equal(anchorSkipFinal("차가운 바람이 불어왔다.", anchor), 0);
  // 앵커 꼬리만 부분 반복한 경우 그만큼 제거.
  const partial = "문을 열었다. 바람이 불었다.";
  assert.equal(partial.slice(anchorSkipFinal(partial, anchor)), " 바람이 불었다.");
  // 스트리밍: 데이터 부족이면 판정 보류(null), 앵커가 다 들어오면 즉시 판정.
  assert.equal(anchorSkipStreaming("그는 천천히", anchor), null);
  assert.equal(anchorSkipStreaming(anchor + " 바람", anchor), anchor.length);
  // 반복 없이 충분히 길어지면 0 으로 확정 (본문 표시 시작).
  assert.equal(anchorSkipStreaming("전혀 다른 내용".repeat(60), anchor), 0);

  // 이음새 줄바꿈 허용 판정 — 완결 문장/대사면 새 문단 가능(줄바꿈 보존).
  assert.equal(anchorEndsParagraph("彼は部屋を出た。"), true);
  assert.equal(anchorEndsParagraph("「もう行こう」"), true);
  assert.equal(anchorEndsParagraph("「行くぞ」と彼は言った。"), true);
  assert.equal(anchorEndsParagraph("He left the room."), true);
  assert.equal(anchorEndsParagraph("そうか……"), true);
  assert.equal(anchorEndsParagraph('"Yes, I am."'), true);
  // 아포스트로피(')를 미종결 따옴표로 오검출하지 않는다.
  assert.equal(anchorEndsParagraph("He didn't know what to say."), true);
  // 문장/대사 중간이면 이음새 줄바꿈을 걷어낸다.
  assert.equal(anchorEndsParagraph("近くにあるカグツチアカデミーの生徒"), false);
  assert.equal(anchorEndsParagraph("「…ご主人様？"), false); // 대사 미종결
  assert.equal(anchorEndsParagraph('"Are you sure?'), false); // 큰따옴표 미종결
  assert.equal(anchorEndsParagraph("（…なんでこうなった"), false);
}

// ── 대형 첫 본문 분할 + 요약 앵커 경계 계산 ─────────────────────────
{
  // 짧은 텍스트는 그대로 하나.
  assert.deepEqual(splitTextByBudget("짧은 본문", 1600), ["짧은 본문"]);
  assert.deepEqual(splitTextByBudget("", 1600), []);

  // 문단 여러 개의 대형 본문 — 이어붙이면 원문과 바이트 동일해야 한다.
  const paras: string[] = [];
  for (let i = 0; i < 40; i++) {
    paras.push(`문단 ${i} ` + "가나다라마".repeat(30));
  }
  const big = paras.join("\n\n");
  const chunks = splitTextByBudget(big, 1600);
  assert.ok(chunks.length > 1, "대형 본문은 여러 조각으로 나뉘어야 한다");
  assert.equal(chunks.join(""), big, "조각을 이으면 원문과 동일해야 한다");
  for (const c of chunks) {
    assert.ok(c.trim() !== "", "공백뿐인 조각이 없어야 한다");
    assert.ok(c.length <= Math.floor(1600 * 1.5), "조각은 한도 근처여야 한다");
  }

  // 문단 경계가 전혀 없는 초장문도 하드 분할 후 재조립 동일.
  const noBreak = "가".repeat(5000);
  const hard = splitTextByBudget(noBreak, 1600);
  assert.ok(hard.length >= 3);
  assert.equal(hard.join(""), noBreak);

  // 요약 앵커 경계 계산 — 대원칙: 경계 1개 = 요청 1번 = 앵커 1개.
  const chain: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "s", name: "s", scenarioId: "scn", mode: "novel",
      createdAt: 1, modifiedAt: 1, lastPlayedAt: 1, favorite: false,
      rootId: "r", activeLeafId: "a12",
    },
    nodes: {
      r: { id: "r", parent: null, kind: "root", patches: [], createdAt: 1 },
    },
  };
  let prev = "r";
  for (let i = 1; i <= 12; i++) {
    const id = `a${i}`;
    chain.nodes[id] = {
      id, parent: prev, kind: "ai-continue",
      patches: [{ op: "append", spans: [{ author: "ai", text: "글".repeat(100) }] }],
      createdAt: 1 + i,
    };
    prev = id;
  }

  // 주기 5, 예산 무제한 → 5개마다 경계 + 꼬리는 leaf.
  assert.deepEqual(
    planSummaryBoundaries(chain, "a12", undefined, 5),
    ["a5", "a10", "a12"]
  );
  // 마지막 앵커(a5) 이후부터.
  assert.deepEqual(
    planSummaryBoundaries(chain, "a12", "a5", 5),
    ["a10", "a12"]
  );
  // 주기가 커도 구간 본문이 예산(글자)을 넘으면 앵커를 더 잘게 나눈다 —
  // 요청을 쪼개는 게 아니라 경계를 늘린다. 노드당 100자, 예산 250자 → 3노드째마다.
  assert.deepEqual(
    planSummaryBoundaries(chain, "a12", undefined, 100, 250),
    ["a3", "a6", "a9", "a12"]
  );
  // 새 생성이 없으면 빈 배열.
  assert.deepEqual(planSummaryBoundaries(chain, "a12", "a12", 5), []);
}

// ── createBlankSession: 대형 씨드 → 노드 체인 ───────────────────────
{
  // 짧은 first_mes → 루트 노드 1개, 활성 리프 = 루트.
  const small = createBlankSession("s", "scn", "짧은 인사말입니다.");
  assert.equal(Object.keys(small.nodes).length, 1);
  assert.equal(small.meta.activeLeafId, small.meta.rootId);
  assert.equal(small.nodes[small.meta.rootId].kind, "root");

  // 대형 first_mes → 여러 노드 체인, 본문 재구성은 원문과 동일.
  const paras: string[] = [];
  for (let i = 0; i < 30; i++) paras.push(`장면 ${i} ` + "본문내용".repeat(40));
  const seed = paras.join("\n\n");
  const big = createBlankSession("b", "scn", seed);
  const ids = Object.keys(big.nodes);
  assert.ok(ids.length > 1, "대형 씨드는 노드 여러 개로 심어야 한다");

  // 루트는 parent null / kind root, 나머지는 이어지는 ai-continue 체인.
  const root = big.nodes[big.meta.rootId];
  assert.equal(root.parent, null);
  assert.equal(root.kind, "root");
  const roots = ids.filter((id) => big.nodes[id].parent === null);
  assert.equal(roots.length, 1, "단일 씨드는 루트 하나");

  // 활성 리프는 체인의 끝(자식 없음)이고, 재구성 본문 = 원문 씨드.
  assert.equal(getChildren(big, big.meta.activeLeafId).length, 0);
  assert.equal(spansToText(buildSpans(big, big.meta.activeLeafId)), seed);
  assert.ok(seed.length > SESSION_SEED_CHUNK_CHARS);

  // 여러 인사말(첫 메시지 + 대체) → 형제 루트, 활성 리프는 첫 씨드 체인.
  const multi = createBlankSession("m", "scn", [seed, "대체 인사말"]);
  const multiRoots = Object.keys(multi.nodes).filter(
    (id) => multi.nodes[id].parent === null
  );
  assert.equal(multiRoots.length, 2, "씨드 2개 → 형제 루트 2개");
  assert.equal(spansToText(buildSpans(multi, multi.meta.activeLeafId)), seed);
}

void Promise.all(asyncTests)
  .then(() => {
    console.log("session-view logic harness passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });

// ── 챗 모드 (M6/C1): 노드=메시지 재구성 — chat-messages.ts ──────────
{
  const S = CHAT_MESSAGE_SEPARATOR;

  // 역할 매핑 — span author 가 아니라 노드 kind.
  assert.equal(chatRoleOfKind("root"), "assistant");
  assert.equal(chatRoleOfKind("ai-continue"), "assistant");
  assert.equal(chatRoleOfKind("ai-regen"), "assistant");
  assert.equal(chatRoleOfKind("user-write"), "user");
  assert.equal(chatRoleOfKind("user-edit"), null);

  const chat: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "c", name: "c", scenarioId: "scn", mode: "chat",
      createdAt: 1, modifiedAt: 1, lastPlayedAt: 1, favorite: false,
      rootId: "r", activeLeafId: "u3",
    },
    nodes: {
      r: {
        id: "r", parent: null, kind: "root",
        patches: [{ op: "append", spans: [{ author: "ai", text: "인사말이다." }] }],
        createdAt: 1,
      },
      u1: {
        id: "u1", parent: "r", kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: S + "반가워." }] }],
        createdAt: 2,
      },
      a1: {
        id: "a1", parent: "u1", kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: S + "나도 반가워." }] }],
        createdAt: 3,
      },
      u2: {
        id: "u2", parent: "a1", kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: S + "연속 유저 1" }] }],
        createdAt: 4,
      },
      u3: {
        id: "u3", parent: "u2", kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: S + "연속 유저 2" }] }],
        createdAt: 5,
      },
    },
  };

  // 기본 재구성 — 순서/역할/노드 귀속.
  const msgs = buildChatMessages(chat, "u3");
  assert.deepEqual(
    msgs.map((m) => [m.nodeId, m.role]),
    [["r", "assistant"], ["u1", "user"], ["a1", "assistant"], ["u2", "user"], ["u3", "user"]]
  );
  // 오프셋 체계 일치 — 메시지 텍스트를 이으면 평탄화 본문(buildSpans)과 동일.
  const flat = spansToText(buildSpans(chat, "u3"));
  assert.equal(msgs.map((m) => m.text).join(""), flat);

  // 전송 로그 — 구분자 trim, 연속 같은 역할도 별개 항목 유지 (병합 금지).
  const log = buildChatLog(chat, "u3");
  assert.deepEqual(log, [
    { role: "assistant", content: "인사말이다." },
    { role: "user", content: "반가워." },
    { role: "assistant", content: "나도 반가워." },
    { role: "user", content: "연속 유저 1" },
    { role: "user", content: "연속 유저 2" },
  ]);

  // 메시지 편집 — user-edit replace 노드. 원래 메시지의 노드/역할 유지.
  const editFrom = flat.indexOf("나도");
  chat.nodes["e1"] = {
    id: "e1", parent: "u3", kind: "user-edit",
    patches: [{
      op: "replace", from: editFrom, to: editFrom + "나도".length,
      spans: [{ author: "user", text: "정말로" }],
    }],
    createdAt: 6,
  };
  const edited = buildChatMessages(chat, "e1");
  assert.equal(edited.length, 5, "편집은 메시지 수를 바꾸지 않는다");
  assert.equal(edited[2].nodeId, "a1", "편집돼도 메시지는 원래 노드 소속");
  assert.equal(edited[2].role, "assistant", "편집돼도 역할 유지");
  assert.equal(edited[2].text, S + "정말로 반가워.");
  // 편집 후에도 평탄화 본문과 바이트 동일.
  assert.equal(
    edited.map((m) => m.text).join(""),
    spansToText(buildSpans(chat, "e1"))
  );

  // 메시지 삭제 — 메시지 전체 구간 delete → 목록에서 사라지고 나머지는 유지.
  const flat2 = spansToText(buildSpans(chat, "e1"));
  const delFrom = flat2.indexOf(S + "연속 유저 1");
  chat.nodes["e2"] = {
    id: "e2", parent: "e1", kind: "user-edit",
    patches: [{ op: "delete", from: delFrom, to: delFrom + (S + "연속 유저 1").length }],
    createdAt: 7,
  };
  const afterDel = buildChatMessages(chat, "e2");
  assert.deepEqual(
    afterDel.map((m) => m.nodeId),
    ["r", "u1", "a1", "u3"],
    "삭제된 메시지만 빠진다"
  );
  assert.equal(
    afterDel.map((m) => m.text).join(""),
    spansToText(buildSpans(chat, "e2"))
  );

  // 스와이프(형제) — 다른 리프로 재구성하면 그 경로의 메시지만.
  chat.nodes["a1b"] = {
    id: "a1b", parent: "u1", kind: "ai-regen",
    patches: [{ op: "append", spans: [{ author: "ai", text: S + "다른 응답." }] }],
    createdAt: 8,
  };
  const swiped = buildChatLog(chat, "a1b");
  assert.deepEqual(swiped.map((m) => m.content), [
    "인사말이다.", "반가워.", "다른 응답.",
  ]);

  // 챗 세션 생성 — 대형 first_mes 도 통짜 1노드 (씨드 분할 안 함) + mode 기록.
  const longSeed = "가나다라마 ".repeat(600).trim(); // > SESSION_SEED_SPLIT_MIN
  const chatSession = createBlankSession("t", "scn", longSeed, undefined, "chat");
  assert.equal(chatSession.meta.mode, "chat");
  assert.equal(Object.keys(chatSession.nodes).length, 1, "챗 씨드는 노드 1개");
  const novelSession = createBlankSession("t", "scn", longSeed);
  assert.equal(novelSession.meta.mode, "novel");
  assert.ok(
    Object.keys(novelSession.nodes).length > 1,
    "소설 씨드 분할은 기존 동작 유지"
  );
}

// ── 챗 재생성 수정 보존 (delete+append 갈아끼우기) — 회귀 금지 ──────
{
  const S = CHAT_MESSAGE_SEPARATOR;
  const chat: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "c2", name: "c2", scenarioId: "scn", mode: "chat",
      createdAt: 1, modifiedAt: 1, lastPlayedAt: 1, favorite: false,
      rootId: "r", activeLeafId: "a1",
    },
    nodes: {
      r: {
        id: "r", parent: null, kind: "root",
        patches: [{ op: "append", spans: [{ author: "ai", text: "인사말이다." }] }],
        createdAt: 1,
      },
      u1: {
        id: "u1", parent: "r", kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: S + "반가워." }] }],
        createdAt: 2,
      },
      a1: {
        id: "a1", parent: "u1", kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: S + "나도 반가워." }] }],
        createdAt: 3,
      },
    },
  };

  // 1) 유저가 자기 직전 메시지(u1)를 편집 — user-edit 노드가 리프에 붙는다.
  const flat0 = spansToText(buildSpans(chat, "a1"));
  const eFrom = flat0.indexOf("반가워.");
  chat.nodes["e1"] = {
    id: "e1", parent: "a1", kind: "user-edit",
    patches: [{
      op: "replace", from: eFrom, to: eFrom + "반가워.".length,
      spans: [{ author: "user", text: "안녕, 반가워!" }],
    }],
    createdAt: 4,
  };
  chat.meta.activeLeafId = "e1";

  // 2) 마지막 AI 메시지 갈아끼우기 — replaceFrom = 마지막 메시지 구간 시작.
  const msgs1 = buildChatMessages(chat, "e1");
  const last = msgs1[msgs1.length - 1];
  assert.equal(last.nodeId, "a1");
  const flat1 = spansToText(buildSpans(chat, "e1"));
  const replaceFrom = flat1.length - last.text.length;
  chat.nodes["r1"] = {
    id: "r1", parent: "e1", kind: "ai-regen",
    patches: [
      { op: "delete", from: replaceFrom, to: flat1.length },
      { op: "append", spans: [{ author: "ai", text: S + "새 응답이다." }] },
    ],
    createdAt: 5,
  };
  chat.meta.activeLeafId = "r1";

  const msgs2 = buildChatMessages(chat, "r1");
  // 편집은 보존되고, 마지막 AI 메시지만 새 노드로 갈아끼워진다.
  assert.deepEqual(
    msgs2.map((m) => [m.nodeId, m.role]),
    [["r", "assistant"], ["u1", "user"], ["r1", "assistant"]]
  );
  const log2 = buildChatLog(chat, "r1");
  assert.deepEqual(log2.map((m) => m.content), [
    "인사말이다.", "안녕, 반가워!", "새 응답이다.",
  ]);
  // 평탄화 본문과 바이트 동일 불변식 유지.
  assert.equal(
    msgs2.map((m) => m.text).join(""),
    spansToText(buildSpans(chat, "r1"))
  );
}

// ── 챗 세션 → 텍스트 컴플리션: 이름 턴 + 출력 절단 (ST 호환) ──────────
{
  const names = { user: "철수", char: "스텔라" };

  // 히스토리(chat 소스)만 이름 프리픽스, 그 사이 주입/프롬프트는 불변,
  // 끝에 {{char}}: 오프너 — 원본 배열은 변형하지 않는다.
  const messages: ChatMessage[] = [
    {
      role: "system", content: "메인 프롬프트.",
      source: { type: "prompt", label: "Main" }, contextKind: "prompt",
    },
    {
      role: "assistant", content: "인사말이다.",
      source: { type: "chat", label: "Chat History #1" }, contextKind: "history",
    },
    {
      role: "system", content: "작가노트.",
      source: { type: "authorNote", label: "Session: author's note" },
      contextKind: "prompt",
    },
    {
      role: "user", content: "반가워.",
      source: { type: "chat", label: "Chat History #2" }, contextKind: "history",
    },
  ];
  const named = applyChatTurnNames(messages, names);
  assert.deepEqual(
    named.map((m) => m.content),
    ["메인 프롬프트.", "스텔라: 인사말이다.", "작가노트.", "철수: 반가워.", "스텔라:"]
  );
  assert.equal(messages[1].content, "인사말이다.", "원본 메시지 불변");
  // 평문 평탄화 — 프롬프트가 오프너로 끝나 모델이 캐릭터 발화로 이어 쓴다.
  const prompt = buildTextCompletionPrompt(named);
  assert.ok(prompt.endsWith("철수: 반가워.\n스텔라:"), prompt.slice(-40));

  // 출력 절단 — 유저 턴부터 삭제 + 캐릭터 라벨 제거.
  assert.equal(
    trimChatCompletionOutput(" 응답이다.\n철수: 내가 왜 여기 있지?", names),
    "응답이다."
  );
  // 오프너 에코 + 중간 반복 라벨 제거.
  assert.equal(
    trimChatCompletionOutput("스텔라: 첫 줄.\n스텔라: 둘째 줄.", names),
    "첫 줄.\n둘째 줄."
  );
  // 응답 전체가 유저 턴이면 폐기 (빈 응답 경로로 무산).
  assert.equal(trimChatCompletionOutput("철수: 사칭이다.", names), "");
  // max_tokens 컷 — 끝에 반쯤 잘린 스탑 스트링 제거.
  assert.equal(trimChatCompletionOutput("잘린 응답\n철", names), "잘린 응답");
  // 이름에 정규식 특수문자가 있어도 안전.
  const weird = { user: "a+b", char: "c(d)" };
  assert.equal(
    trimChatCompletionOutput("c(d): 응답\na+b: 질문", weird),
    "응답"
  );

  // 유저 턴 없이 생성 종료 + 미완성 마지막 문단 → 그 문단만 제거.
  assert.equal(
    trimChatCompletionOutput("완결 문단이다.\n\n미완성 조각 그리고", names),
    "완결 문단이다."
  );
  // 마지막 문단이 완결이면 그대로 둔다.
  assert.equal(
    trimChatCompletionOutput("첫 문단.\n\n둘째 문단!", names),
    "첫 문단.\n\n둘째 문단!"
  );
  // 닫는 따옴표로 끝난 대사 문단은 완결로 본다.
  assert.equal(
    trimChatCompletionOutput('내레이션.\n\n"대사입니다."', names),
    '내레이션.\n\n"대사입니다."'
  );
  // 문단이 하나뿐이면 미완성이라도 지우지 않는다(빈 응답 무산 방지).
  assert.equal(
    trimChatCompletionOutput("짧은 미완성 조각", names),
    "짧은 미완성 조각"
  );
  // 유저 턴을 만났으면 그 앞이 미완성이라도 문단 제거를 적용하지 않는다.
  assert.equal(
    trimChatCompletionOutput("완결.\n\n미완성 조각\n철수: 질문", names),
    "완결.\n\n미완성 조각"
  );
}

// ─── 챗 다음화 인계 — 메시지 경계/역할 보존 (planChatEpisodeTail + buildChatEpisodeTailNodes) ───
{
  const S = CHAT_MESSAGE_SEPARATOR;
  const chat: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "ep", name: "ep", scenarioId: "scn", mode: "chat",
      createdAt: 1, modifiedAt: 1, lastPlayedAt: 1, favorite: false,
      rootId: "r", activeLeafId: "e1",
    },
    nodes: {
      r: {
        id: "r", parent: null, kind: "root",
        patches: [{ op: "append", spans: [{ author: "ai", text: "인사말." }] }],
        createdAt: 1,
      },
      u1: {
        id: "u1", parent: "r", kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: S + "질문 하나." }] }],
        createdAt: 2,
      },
      a1: {
        id: "a1", parent: "u1", kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: S + "답변 하나." }] }],
        createdAt: 3,
      },
      u2: {
        id: "u2", parent: "a1", kind: "user-write",
        patches: [{ op: "append", spans: [{ author: "user", text: S + "질문 둘." }] }],
        createdAt: 4,
      },
      a2: {
        id: "a2", parent: "u2", kind: "ai-continue",
        patches: [{ op: "append", spans: [{ author: "ai", text: S + "답변 둘." }] }],
        createdAt: 5,
      },
      // 마지막 AI 메시지를 고친 편집 노드 — 인계 메시지에 편집이 반영돼야 한다.
      e1: {
        id: "e1", parent: "a2", kind: "user-edit",
        patches: [{
          op: "replace",
          from: ("인사말." + S + "질문 하나." + S + "답변 하나." + S + "질문 둘." + S).length,
          to: ("인사말." + S + "질문 하나." + S + "답변 하나." + S + "질문 둘." + S + "답변 둘.").length,
          spans: [{ author: "user", text: "답변 둘 (수정)." }],
        }],
        createdAt: 6,
      },
    },
  };

  // 최근 3개 메시지 인계 — 역할 유지 + 편집 반영 + 경계는 첫 인계 메시지의 직전 노드.
  const plan = planChatEpisodeTail(chat, 3);
  assert.deepEqual(
    plan.messages,
    [
      { role: "assistant", text: "답변 하나." },
      { role: "user", text: "질문 둘." },
      { role: "assistant", text: "답변 둘 (수정)." },
    ],
    "챗 인계는 역할을 유지한 메시지 목록이다"
  );
  assert.equal(plan.boundaryNodeId, "u1", "경계 = 첫 인계 메시지의 직전 path 노드");

  // 메시지 수보다 크게 잡으면 전체 인계 + 경계 없음 (소설과 동일한 의미).
  const whole = planChatEpisodeTail(chat, 99);
  assert.equal(whole.boundaryNodeId, null);
  assert.equal(whole.messages.length, 5);

  // 새 화 심기 — 메시지 1개 = 노드 1개, 역할대로 kind, 재구성하면 원본과 동일.
  const next = createBlankSession("ep 2화", "scn", "", undefined, "chat");
  const built = buildChatEpisodeTailNodes(next.meta.rootId, plan.messages, 100);
  Object.assign(next.nodes, built.nodes);
  next.meta.activeLeafId = built.leafId;
  const carried = buildChatMessages(next);
  assert.deepEqual(
    carried.map((m) => [m.role, m.text.startsWith(S) ? m.text.slice(S.length) : m.text]),
    [
      ["assistant", "답변 하나."],
      ["user", "질문 둘."],
      ["assistant", "답변 둘 (수정)."],
    ],
    "새 화에서도 말풍선 경계/역할이 그대로다"
  );
  const kinds = Object.values(built.nodes)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((n) => n.kind);
  assert.deepEqual(kinds, ["ai-continue", "user-write", "ai-continue"]);
  // 평탄화 불변식 — 메시지 텍스트 연결 = buildSpans 본문.
  assert.equal(
    carried.map((m) => m.text).join(""),
    spansToText(buildSpans(next))
  );
  // 인계 메시지가 없으면 leaf 는 root 그대로.
  const empty = buildChatEpisodeTailNodes("root-x", [], 100);
  assert.equal(empty.leafId, "root-x");
  assert.equal(Object.keys(empty.nodes).length, 0);
}

// ─── ST 채팅 임포트 — 유저가 먼저 시작한 채팅의 첫 메시지 역할 보존 ───
{
  const parsed = {
    userName: "철수",
    characterName: "스텔라",
    messages: [
      { role: "user" as const, swipes: [{ source: "유저가 먼저 말한다." }], activeIndex: 0 },
      { role: "assistant" as const, swipes: [{ source: "AI 가 답한다." }], activeIndex: 0 },
    ],
  };
  const built = buildChatImportSession(parsed, "chat", 1000);
  const session: StellaSession = {
    schemaVersion: 1,
    meta: {
      id: "im", name: "im", scenarioId: "scn", mode: "chat",
      createdAt: 1, modifiedAt: 1, lastPlayedAt: 1, favorite: false,
      rootId: built.rootId, activeLeafId: built.activeLeafId,
    },
    nodes: built.nodes,
  };
  const msgs = buildChatMessages(session);
  assert.deepEqual(
    msgs.map((m) => [m.role, m.text.trim()]),
    [
      ["user", "유저가 먼저 말한다."],
      ["assistant", "AI 가 답한다."],
    ],
    "유저 시작 채팅의 첫 메시지는 유저 말풍선이다"
  );
  // 전송 로그에서도 유저 발화로 나간다.
  assert.deepEqual(buildChatLog(session), [
    { role: "user", content: "유저가 먼저 말한다." },
    { role: "assistant", content: "AI 가 답한다." },
  ]);

  // AI(인사말) 시작 채팅은 기존대로 root=assistant.
  const parsed2 = {
    userName: "철수",
    characterName: "스텔라",
    messages: [
      { role: "assistant" as const, swipes: [{ source: "인사말." }], activeIndex: 0 },
    ],
  };
  const built2 = buildChatImportSession(parsed2, "chat", 1000);
  assert.equal(built2.nodes[built2.rootId].kind, "root");
}
