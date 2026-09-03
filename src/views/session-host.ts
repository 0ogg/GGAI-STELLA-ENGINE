/**
 * 세션 호스트 뷰 공통 창구 (M6/C0).
 *
 * "세션을 표시하는 뷰"는 소설 세션뷰와 챗 세션뷰 두 종류다. 페르소나 기억,
 * 미리보기 직전 flush, rename retarget, 갤러리 노드 점프, 활성 세션 추적 등
 * 플러그인 배관은 특정 뷰 클래스가 아니라 이 창구를 통해 두 뷰를 동일하게 다룬다.
 *
 * 규칙: 배관 코드에서 `instanceof SessionView` / `getLeavesOfType(VIEW_TYPE_SESSION)`
 * 하드코딩 금지 — 반드시 이 모듈의 헬퍼를 쓴다 (챗 세션이 조용히 빠지는 회귀 방지).
 */

import type { View, Workspace, WorkspaceLeaf } from "obsidian";
import type { AutoExecuteFlagKey } from "../types/quick-reply";
import {
  VIEW_TYPE_CHAT_SESSION,
  VIEW_TYPE_PRO_SESSION,
  VIEW_TYPE_SESSION,
} from "../constants";

/** 소설/챗 세션 뷰가 공통으로 제공해야 하는 인터페이스. */
export interface SessionHostView extends View {
  /** 표시 중인 세션 파일 경로 (없으면 null). */
  getSessionFile(): string | null;
  /** 미저장 편집을 store 에 커밋 (미리보기 = 전송본 불변식). */
  flushPendingEdits(): Promise<void>;
  /** 해당 노드 위치로 스크롤. 활성 경로에 없으면 false. */
  scrollToNode(nodeId: string): boolean;
  /** AI 생성(스트리밍) 진행 중 여부 — 생성 중인 탭을 다른 세션으로 갈아끼우면 잠금·로딩 상태가 새 세션에 새어든다. */
  isGenerating(): boolean;
  /**
   * 사용자가 지금 이 세션 본문에 손대고 있는가 — 포커스/IME 조합 중이거나 아직
   * 노드로 커밋되지 않은 편집이 남아 있으면 true. 세션을 그냥 "보고 있는" 것은
   * 여기 해당하지 않는다. 지연 로딩 탭에는 없으므로 선택 메서드.
   */
  isBusyEditing?(): boolean;
  /**
   * 이 시점에 자동 실행할 QR 버튼을 돌린다 (QR 바 위임).
   * 자동 실행은 **열려 있는 세션창이 있을 때만** 돈다 — 버튼이 넣는 텍스트/생성은
   * 그 뷰의 입력·본문 경로를 타기 때문이다(뷰 없이 도는 별도 경로를 만들지 않는다).
   */
  runAutoQuickReplies?(trigger: AutoExecuteFlagKey): Promise<void>;
}

/** 열려 있는 모든 세션창에서 자동 실행 QR 을 돌린다 (옵시디언 시작 시점용). */
export async function runAutoQuickRepliesEverywhere(
  workspace: Workspace,
  trigger: AutoExecuteFlagKey
): Promise<void> {
  for (const leaf of getSessionHostLeaves(workspace)) {
    const view = leaf.view;
    if (isSessionHostView(view) && typeof view.runAutoQuickReplies === "function") {
      await view.runAutoQuickReplies(trigger);
    }
  }
}

/**
 * `sessionFile` 세션이 열려 있으면 그 뷰의 자동 실행 QR 을 돌린다.
 * 열려 있지 않으면 조용히 아무것도 하지 않는다.
 */
export async function runAutoQuickRepliesFor(
  workspace: Workspace,
  sessionFile: string,
  trigger: AutoExecuteFlagKey
): Promise<void> {
  for (const leaf of getSessionHostLeaves(workspace)) {
    const view = leaf.view;
    if (
      isSessionHostView(view) &&
      view.getSessionFile() === sessionFile &&
      typeof view.runAutoQuickReplies === "function"
    ) {
      await view.runAutoQuickReplies(trigger);
      return;
    }
  }
}

/**
 * 이 leaf 를 `sessionFile` 세션으로 갈아끼워도 안전한가 — 생성(스트리밍) 중인
 * 세션 뷰를 "다른" 세션으로 재사용하면 그 뷰의 generation 잠금/로딩 표시와
 * 스트리밍 텍스트가 새 세션 탭에 그대로 새어든다 (같은 세션 재열기는 setState
 * 가 no-op 이라 안전). 세션 열기 leaf 선택은 반드시 이 검사를 통과해야 한다.
 */
export function canRetargetSessionView(
  view: View | null | undefined,
  sessionFile: string
): boolean {
  if (!isSessionHostView(view)) return true;
  if (typeof view.isGenerating !== "function") return true; // 지연 로딩 탭 — 생성 중일 수 없음
  return !view.isGenerating() || view.getSessionFile() === sessionFile;
}

export const SESSION_HOST_VIEW_TYPES: readonly string[] = [
  VIEW_TYPE_SESSION,
  VIEW_TYPE_CHAT_SESSION,
  VIEW_TYPE_PRO_SESSION,
];

export function isSessionHostView(
  view: View | null | undefined
): view is SessionHostView {
  // 타입 문자열만으로는 부족하다 — 옵시디언 1.7+ 의 지연 로딩 탭(DeferredView)은
  // getViewType() 은 세션 뷰로 보고하지만 실제 메서드가 없어, 재시작 후 아직
  // 클릭하지 않은 세션 탭에서 "getSessionFile is not a function" 이 났다.
  // 메서드 존재까지 확인해 로딩 전 탭은 세션 호스트로 치지 않는다 (편집도 없으므로 안전).
  return (
    view != null &&
    SESSION_HOST_VIEW_TYPES.includes(view.getViewType()) &&
    typeof (view as Partial<SessionHostView>).getSessionFile === "function"
  );
}

/** 사용자가 지금 이 세션을 보고 있는가 — 활성 탭이 그 세션이고 창도 포커스 상태. */
export function isViewingSession(
  workspace: Workspace,
  sessionFile: string
): boolean {
  if (!document.hasFocus()) return false;
  const view = workspace.activeLeaf?.view;
  return isSessionHostView(view) && view.getSessionFile() === sessionFile;
}

/**
 * 이 세션을 표시 중인 세션창이 지금 생성(스트리밍) 중인가.
 *
 * 스트리밍 중에는 그 생성이 본문 소유권을 쥐고 있다(진행 중 노드의 텍스트를 계속
 * 고쳐 쓰는 중). 백그라운드 쓰기(선채팅 등)가 같은 세션에 노드를 붙이면 두 쓰기가
 * 겹쳐 방금 받은 답이 다른 갈래로 밀려나거나 본문이 엉킨다.
 */
export function isSessionGenerating(
  workspace: Workspace,
  sessionFile: string
): boolean {
  return sessionHostViewsOf(workspace, sessionFile).some(
    (view) => typeof view.isGenerating === "function" && view.isGenerating()
  );
}

/**
 * 사용자가 지금 이 세션 본문/말풍선을 고치는 중인가.
 *
 * 백그라운드 쓰기는 이 순간만 피하면 된다 — 세션을 보고 있을 뿐이면 바쁨이 아니다
 * (선채팅은 세션창을 열어 둬도 온다는 규칙을 그대로 유지한다).
 */
export function isSessionBeingEdited(
  workspace: Workspace,
  sessionFile: string
): boolean {
  return sessionHostViewsOf(workspace, sessionFile).some(
    (view) => typeof view.isBusyEditing === "function" && view.isBusyEditing()
  );
}

/** 이 세션을 표시 중인 세션 호스트 뷰들 (같은 세션이 여러 탭에 열려 있을 수 있다). */
function sessionHostViewsOf(
  workspace: Workspace,
  sessionFile: string
): SessionHostView[] {
  const views: SessionHostView[] = [];
  for (const leaf of getSessionHostLeaves(workspace)) {
    const view = leaf.view;
    if (isSessionHostView(view) && view.getSessionFile() === sessionFile) {
      views.push(view);
    }
  }
  return views;
}

/** 열려 있는 모든 세션 호스트 leaf (소설 + 챗). */
export function getSessionHostLeaves(workspace: Workspace): WorkspaceLeaf[] {
  const leaves: WorkspaceLeaf[] = [];
  for (const type of SESSION_HOST_VIEW_TYPES) {
    leaves.push(...workspace.getLeavesOfType(type));
  }
  return leaves;
}
