export type AgentPhase = "pre_generation" | "post_processing";

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  phase: AgentPhase;
  enabledByDefault: boolean;
  /** Template variables: {{mainResponse}}, {{recentContext}}, {{style}}. */
  promptTemplate: string;
}

export interface AgentResult {
  agentId: string;
  output: string;
  tokensUsed: number;
}

export const BUILT_IN_AGENTS: AgentDefinition[] = [
  {
    id: "prose-guardian",
    name: "문체 수호자",
    description: "생성된 텍스트의 문체 품질을 검사하고 피드백을 제공합니다.",
    phase: "post_processing",
    enabledByDefault: false,
    promptTemplate: `당신은 소설 문체 편집자입니다. 다음 생성된 텍스트를 분석하세요:

<generated_text>
{{mainResponse}}
</generated_text>

다음 기준으로 평가하세요:
1. 반복 표현
2. 비유/은유의 과도한 사용
3. 서술 리듬의 단조로움
4. 시점 일관성
5. AI스러운 클리셰 표현

JSON 형식으로 응답:
{"score": 1-10, "issues": ["문제1"], "suggestion": "개선 제안"}`,
  },
  {
    id: "continuity-checker",
    name: "연속성 검사",
    description: "이전 내용과의 모순을 감지합니다.",
    phase: "post_processing",
    enabledByDefault: false,
    promptTemplate: `당신은 소설 연속성 검사자입니다.

<recent_context>
{{recentContext}}
</recent_context>

<generated_text>
{{mainResponse}}
</generated_text>

생성된 텍스트가 최근 컨텍스트와 모순되는지 검사하세요:
- 등장인물 이름/외모/성격 일관성
- 시간/장소 논리
- 이전에 언급된 사실과 충돌
- 물리적으로 불가능한 상황

JSON 형식으로 응답:
{"consistent": true, "contradictions": [], "severity": "none"}`,
  },
  {
    id: "narrative-director",
    name: "서술 디렉터",
    description: "생성 전에 서술 방향을 안내하는 컨텍스트를 주입합니다.",
    phase: "pre_generation",
    enabledByDefault: false,
    promptTemplate: `현재 소설의 서술 상태를 분석하고, 다음 생성에 방향성을 제시하세요.

<recent_text>
{{recentContext}}
</recent_text>

<writing_style>
{{style}}
</writing_style>

다음을 고려하세요:
- 현재 장면의 긴장감 수준
- 다음 장면 전환이 필요한지
- 미해결 갈등 상태
- 독자의 몰입을 위한 제안

한두 문장으로 다음 생성 방향을 제시하세요.`,
  },
];
