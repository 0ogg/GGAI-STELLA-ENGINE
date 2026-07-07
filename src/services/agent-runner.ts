import type { AgentDefinition, AgentResult } from "../types/agent";
import type { AIService, ChatResponse } from "./ai-service";

export interface AgentRunContext {
  /** post_processing: main AI response. */
  mainResponse?: string;
  /** pre_generation/post_processing: recent story context. */
  recentContext?: string;
  /** Scenario/style context for pre-generation direction. */
  style?: string;
  signal?: AbortSignal;
}

type AgentAI = Pick<AIService, "chat">;

export async function runAgent(
  agent: AgentDefinition,
  ctx: AgentRunContext,
  ai: AgentAI,
  profileId?: string
): Promise<AgentResult> {
  const prompt = renderAgentPrompt(agent, ctx);
  const response = await ai.chat({
    profileId,
    messages: [{ role: "user", content: prompt }],
    paramsOverride: { maxTokens: 500, temperature: 0.3 },
    signal: ctx.signal,
  });

  return agentResult(agent.id, response);
}

export async function runAgentBatch(
  agents: AgentDefinition[],
  ctx: AgentRunContext,
  ai: AgentAI,
  profileId?: string
): Promise<AgentResult[]> {
  if (agents.length === 0) return [];
  if (agents.length === 1) {
    return [await runAgent(agents[0], ctx, ai, profileId)];
  }

  const taskPrompt = agents
    .map((agent) => {
      const prompt = renderAgentPrompt(agent, ctx);
      return `<agent_task id="${xmlEscape(agent.id)}">\n${prompt}\n</agent_task>`;
    })
    .join("\n\n");
  const instruction =
    `다음 ${agents.length}개의 에이전트 작업을 수행하세요.\n` +
    `각 작업의 결과를 <agent_output id="작업ID">...</agent_output> XML 태그로 감싸서 응답하세요.\n\n`;

  const response = await ai.chat({
    profileId,
    messages: [{ role: "user", content: instruction + taskPrompt }],
    paramsOverride: { maxTokens: 500 * agents.length, temperature: 0.3 },
    signal: ctx.signal,
  });

  return agents.map((agent) => {
    const output = extractAgentOutput(response.text, agent.id);
    return {
      agentId: agent.id,
      output: output ?? response.text.trim(),
      tokensUsed: totalTokens(response),
    };
  });
}

export function renderAgentPrompt(
  agent: AgentDefinition,
  ctx: AgentRunContext
): string {
  return agent.promptTemplate
    .replace(/\{\{mainResponse\}\}/g, ctx.mainResponse ?? "")
    .replace(/\{\{recentContext\}\}/g, ctx.recentContext ?? "")
    .replace(/\{\{style\}\}/g, ctx.style ?? "");
}

export function extractAgentOutput(text: string, agentId: string): string | null {
  const escapedId = regexpEscape(agentId);
  const pattern = new RegExp(
    `<agent_output\\s+id=["']${escapedId}["']\\s*>([\\s\\S]*?)<\\/agent_output>`,
    "i"
  );
  const match = text.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function agentResult(agentId: string, response: ChatResponse): AgentResult {
  return {
    agentId,
    output: response.text.trim(),
    tokensUsed: totalTokens(response),
  };
}

function totalTokens(response: ChatResponse): number {
  return response.usage.inputTokens + response.usage.outputTokens;
}

function regexpEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
