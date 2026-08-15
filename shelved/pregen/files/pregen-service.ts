/**
 * PregenService — 이중 생성의 1차 호출. (설계·경계는 `이중 생성 스펙.md`)
 *
 * 본 생성 직전에 **같은 세션을 다른 프롬프트 세트로 한 번 더** 호출하고 그 결과 텍스트를
 * 돌려준다. 무엇을 뽑을지는 전적으로 그 프롬프트 세트가 정한다 — 이 서비스는 용도를
 * 모르고, 지시문을 덧붙이지도 않는다(숨은 프롬프트 금지).
 *
 * 전송본은 `planSessionRequest` 한 곳에서만 만든다 — 1차 호출도 예외가 아니라서
 * 프롬프트 세트/모델만 `settingsOverride` 로 갈아끼운다.
 */

import { Notice } from "obsidian";
import type StellaEnginePlugin from "../main";
import type { PregenActiveSettings } from "../types/preset";
import { planSessionRequest } from "../util/build-session-context";
import {
  parsePregenResult,
  pregenStopSequences,
} from "../util/pregen-prompt-preset";

interface PregenCacheEntry {
  leafId: string;
  text: string;
}

export class PregenService {
  /** 세션별 마지막 1차 결과 — 미리보기(dry-run) 재사용용 (재시작 시 초기화). */
  private cache = new Map<string, PregenCacheEntry>();

  /**
   * 1차 호출이 도는 중인 세션. 1차 호출도 `planSessionRequest` 를 타므로 확장의
   * 컨텍스트 기여가 다시 돌고, 막지 않으면 1차가 자기 자신을 무한히 부른다.
   */
  private running = new Set<string>();

  constructor(private plugin: StellaEnginePlugin) {}

  /**
   * 이 세션의 1차 호출이 도는 중인가 — 1차 패스에서는 이 확장이 아무것도 기여하지
   * 않게 하는 판정. `run()` 안의 재귀 차단만으로는 부족하다: 1차 전송본은 dryRun 으로
   * 만들어지므로 확장이 `run()` 대신 `getCached()` 를 타고, 그러면 **직전 1차 결과가
   * 이번 1차 호출의 컨텍스트에 다시 들어간다**(자기 출력을 되먹임).
   */
  isRunning(sessionFile: string): boolean {
    return this.running.has(sessionFile);
  }

  /**
   * 마지막 1차 결과 — 미리보기 전용. 그 리프에서 실제로 쓰인 값일 때만 돌려준다
   * (다른 지점의 결과를 보여주면 미리보기가 전송본과 다른 말을 하게 된다).
   */
  getCached(sessionFile: string, leafId: string): string {
    const hit = this.cache.get(sessionFile);
    return hit && hit.leafId === leafId ? hit.text : "";
  }

  /**
   * 1차 호출 1회. 실패하거나 돌 수 없는 상황이면 빈 문자열(본 생성은 그대로 진행).
   *
   * `view` 는 **본 생성이 보는 지점 그대로**다. 재생성이면 본 생성은 부모 노드로
   * 되돌아가 조립하는데, 1차가 이 정보를 안 받으면 혼자 현재 리프(갈아끼울 응답이
   * 아직 붙어 있는 지점)를 봐서 한 턴 앞을 기준으로 생각을 뽑는다.
   */
  async run(
    sessionFile: string,
    view: { leafId: string; excludeTailAssistant?: boolean; speakerId?: string },
    settings: PregenActiveSettings
  ): Promise<string> {
    const { leafId } = view;
    if (!settings.promptSetId) return "";
    // 재귀 차단 — 1차 패스의 컨텍스트 조립에서 이 확장은 아무것도 기여하지 않는다.
    if (this.running.has(sessionFile)) return "";

    this.running.add(sessionFile);
    try {
      const plan = await planSessionRequest(this.plugin, sessionFile, {
        // 본 생성과 같은 지점 — 재생성이면 부모 노드, 챗 재생성이면 꼬리 assistant 제외,
        // 그룹이면 이번 발화자까지 그대로.
        leafId,
        excludeTailAssistant: view.excludeTailAssistant,
        speakerId: view.speakerId,
        settingsOverride: {
          promptSetId: settings.promptSetId,
          // **세션의 수치를 하나도 물려받지 않는다.** 부속 호출의 파라미터는 그
          // 모델 프로필이 소유한다 — 번역·요약·로어북 선별·문단 재생성이 전부
          // `{profileId, prompt, label}` 만 보내고 수치를 안 넘기는 것과 같다.
          // 입력 한도만 빼고 출력·샘플링은 세션을 따르던 게 앞뒤가 안 맞았고,
          // 본문 분량 설정(maxOutputTokens)까지 물려받아 1차가 중간에 잘렸다.
          params: undefined,
          ...(settings.modelProfileId
            ? {
                modelProfileId: settings.modelProfileId,
                // 모델을 갈아끼우면 NAI 형식도 **그 모델 종류 기준으로 다시 유도**한다
                // (텍스트 모델 = NAI 형식 ON). 세션 값을 그대로 물려받으면 챗 모델
                // 기준으로 꺼진 값이 따라와 텍스트 모델에 평문으로 나간다.
                // 프리셋 순환(presetToGenerationOverride)이 쓰는 규칙과 같다.
                naiFormat: undefined,
              }
            : {}),
          // 이어쓰기 이음새 보정은 "본문을 이어서 써라"는 장치다 — 1차는 본문을
          // 쓰는 호출이 아니므로 반드시 끈다(켜두면 1차가 장면을 이어쓴다).
          continueAnchor: false,
        },
        // 부작용 없이 읽기만 — QR `/inject` 의 1회성 주입을 1차가 삼켜서
        // 정작 본 생성에서 사라지는 것을 막는다.
        dryRun: true,
      });
      if ("error" in plan) {
        new Notice(`이중 생성 실패: ${plan.error}`);
        return "";
      }

      // **stop 시퀀스만 넘긴다.** 세션의 생성 수치(출력 길이·샘플링)는 안 넘긴다 —
      // (출력 형식이 `이름: 생각` 줄이라 stop 없이도 파싱이 끊지만, 목록 뒤에 장면을
      //  계속 쓰면 그만큼 토큰을 태우므로 걸어 둔다 — 닫는 대괄호/구분선이 stop 이다.
      //  **여닫이가 같은 기호(코드펜스)를 stop 으로 걸면 안 된다** — 모델이 여는 쪽을
      //  따라 쓰는 순간 첫 글자에서 잘려 빈 응답이 된다.)
      // 그건 다른 확장 서비스와 같이 그 모델 프로필이 소유해야 1차의 출력 제한이
      // 본문 분량 설정과 분리된다. 둘은 별개 문제라 한꺼번에 빼면 안 된다.
      //
      // **키가 경로마다 다르다 (Core 어댑터 실측):**
      //  - 챗(anthropic/google/openai/vertex): `{...프로필 params, ...paramsOverride}`
      //    로 병합한 뒤 `stopSequences` 를 읽어 provider 키로 매핑
      //    (`stop_sequences` / `stopSequences` / `stop`) → 우리는 `stopSequences`.
      //  - 텍스트(novelai/openai): paramsOverride 를 **요청 본문에 그대로 펼친다**.
      //    둘 다 OpenAI 형식 completions 엔드포인트(NAI 는 `/oa/v1/completions`)라
      //    네이티브 키는 `stop` — Core 자신도 프로필 `stopSequences` 를 NAI 본문의
      //    `stop` 으로 매핑한다. → 우리는 `stop`.
      // (NAI **네이티브** API 의 stop 은 토큰 ID 배열이지만 Core 는 그 경로를 쓰지 않는다.)
      // **모델 프로필의 값을 덮어쓰지 않는다** — 출력 길이·샘플링은 그 프로필 소관이다.
      // 분량을 토큰 상한으로 자르는 건 해결이 아니라 문장 중간에서 끊기는 것일 뿐이라,
      // 멈춤은 **형식의 종결성**(닫는 `}`)이 만든다.
      const stopParam = plan.payload.kind === "text" ? "stop" : "stopSequences";
      const paramsOverride = {
        [stopParam]: pregenStopSequences(plan.payload.kind),
      };

      const res =
        plan.payload.kind === "chat"
          ? await this.plugin.ai.chat({
              profileId: plan.profile.id,
              messages: plan.payload.messages,
              paramsOverride,
              label: "이중 생성 (1차)",
            })
          : await this.plugin.ai.generate({
              profileId: plan.profile.id,
              prompt: plan.payload.prompt,
              paramsOverride,
              label: "이중 생성 (1차)",
            });

      // JSON 배열을 `이름: 생각` 줄로 편다. 깨졌으면 잘라서 원문 그대로 쓴다.
      const text = parsePregenResult(res.text ?? "");
      this.cache.set(sessionFile, { leafId, text });
      return text;
    } catch (err) {
      // 1차가 실패해도 본 생성은 평소대로 진행한다 (롤백 경계).
      console.warn("[GGAI Stella] 이중 생성 1차 호출 실패:", err);
      new Notice(
        `이중 생성 실패: ${err instanceof Error ? err.message : String(err)}`
      );
      return "";
    } finally {
      this.running.delete(sessionFile);
    }
  }
}
