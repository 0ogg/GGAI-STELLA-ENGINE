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
import { VIEW_TYPE_CHAT_SESSION, VIEW_TYPE_SESSION } from "../constants";

/** 소설/챗 세션 뷰가 공통으로 제공해야 하는 인터페이스. */
export interface SessionHostView extends View {
  /** 표시 중인 세션 파일 경로 (없으면 null). */
  getSessionFile(): string | null;
  /** 미저장 편집을 store 에 커밋 (미리보기 = 전송본 불변식). */
  flushPendingEdits(): Promise<void>;
  /** 해당 노드 위치로 스크롤. 활성 경로에 없으면 false. */
  scrollToNode(nodeId: string): boolean;
}

export const SESSION_HOST_VIEW_TYPES: readonly string[] = [
  VIEW_TYPE_SESSION,
  VIEW_TYPE_CHAT_SESSION,
];

export function isSessionHostView(
  view: View | null | undefined
): view is SessionHostView {
  return view != null && SESSION_HOST_VIEW_TYPES.includes(view.getViewType());
}

/** 열려 있는 모든 세션 호스트 leaf (소설 + 챗). */
export function getSessionHostLeaves(workspace: Workspace): WorkspaceLeaf[] {
  const leaves: WorkspaceLeaf[] = [];
  for (const type of SESSION_HOST_VIEW_TYPES) {
    leaves.push(...workspace.getLeavesOfType(type));
  }
  return leaves;
}
