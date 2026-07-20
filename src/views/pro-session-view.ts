/**
 * 집필 프로(PRO) 세션 뷰.
 *
 * 소설 세션뷰를 그대로 상속한 별도 뷰 타입 — 본문/편집/스트리밍/번역 보기는 소설 뷰
 * 규약 그대로이고, 차이는 `proWritingMode()` 게이트 하나다. 이 게이트가 켜지면
 * 소설 뷰의 번역 보기(한국어판)에 **대기 문단(pending) 모델**이 얹힌다:
 * 본문 끝 이어쓰기(초고) 영역 + 문단 직접 수정의 영어판 자동 반영(집필 변환).
 * 상세 배관은 session-view.ts 의 "집필 프로 — 대기 문단 모델" 섹션.
 *
 * 라우팅: main.ts `resolveSessionViewType` 이 PRO 활성화 + meta.proWriting 일 때만
 * 이 뷰 타입을 고른다. 비활성 환경에서는 같은 세션이 소설 뷰로 열린다(우아한 강등).
 */

import { VIEW_TYPE_PRO_SESSION } from "../constants";
import { SessionView } from "./session-view";

export class ProSessionView extends SessionView {
  getViewType(): string {
    return VIEW_TYPE_PRO_SESSION;
  }

  getIcon(): string {
    return "pen-line";
  }

  protected proWritingMode(): boolean {
    return true;
  }
}
