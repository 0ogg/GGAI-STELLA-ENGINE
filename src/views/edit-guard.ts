/**
 * 편집 보호 가드 — "입력 중 재렌더로 포커스가 날아가는" 회귀의 공용 방어막.
 *
 * 모든 편집 UI(전용 편집기, 대시보드 편입 섹션, 우측 디테일의 메모리/작가노트)가
 * 같은 세 겹 가드를 써야 한다. 뷰마다 복붙하면 복사 과정에서 한 조각씩 빠져
 * 같은 버그가 계속 재발한다 (2026-07-06 재발 원인) — 반드시 이 모듈을 재사용한다.
 *
 * 세 겹:
 *  1. composing — IME(한글) 조합 중. activeElement 확인만으로는 조합 중 포커스가
 *     순간 흔들리는 것을 못 막는다. 조합 중에는 절대 DOM 을 갈아엎지 않는다.
 *  2. isEditing — 포커스가 편집 영역 안에 있으면 외부발 재렌더를 미룬다.
 *  3. runSave — 자기 저장이 발행한 store 이벤트를 무시하는 savingSelf 플래그.
 *     리셋은 setTimeout(0) 으로 미뤄 저장 직후 마이크로태스크로 도착하는
 *     이벤트까지 흡수한다 (동기 리셋은 경쟁에 진다).
 *
 * 사용: 뷰 생성 시 `guard.attach(rootEl)` (rootEl 은 empty() 로 비워질 뿐 교체되지
 * 않는 요소여야 리스너가 살아남는다), store 이벤트 핸들러 첫 줄에서
 * `if (guard.isSavingSelf || guard.isEditing()) return;`, 저장은 `guard.runSave(...)`.
 */
// ─── 전역 IME 조합 추적 (2026-07-06 입력 마비 사고 대응, 회귀 금지) ───
//
// 어느 입력칸에서든 한글 조합이 진행 중일 때, 다른 뷰(특히 배경 세션창)가
// 본문 DOM 이나 문서 선택영역(Selection.removeAllRanges/addRange)을 건드리면
// Chromium 이 진행 중인 조합을 통째로 얼려버린다 — 포커스는 남아 있는데
// 커서가 사라지고 키 입력이 전부 삼켜지는 "입력 마비" 증상 (창 전환해야 풀림).
// 배경 갱신은 반드시 runWhenImeIdle 로 조합 종료 뒤로 미룬다.
let imeComposing = false;
let imeIdleQueue: (() => void)[] = [];
let imeTrackerInstalled = false;

/** 전역 조합 추적 시작 — main.ts onload 에서 1회. register 로 unload 정리를 위임. */
export function installGlobalImeTracker(
  register: (cleanup: () => void) => void
): void {
  if (imeTrackerInstalled) return;
  imeTrackerInstalled = true;
  const onStart = (): void => {
    imeComposing = true;
  };
  const onEnd = (): void => {
    imeComposing = false;
    if (imeIdleQueue.length === 0) return;
    const queue = imeIdleQueue;
    imeIdleQueue = [];
    // 조합 확정 직후의 input 이벤트까지 지나가도록 한 틱 미룬다.
    window.setTimeout(() => {
      for (const fn of queue) fn();
    }, 0);
  };
  document.addEventListener("compositionstart", onStart, true);
  document.addEventListener("compositionend", onEnd, true);
  register(() => {
    imeTrackerInstalled = false;
    imeComposing = false;
    imeIdleQueue = [];
    document.removeEventListener("compositionstart", onStart, true);
    document.removeEventListener("compositionend", onEnd, true);
  });
}

/** 지금 어딘가에서 IME(한글) 조합이 진행 중인가. */
export function isImeComposing(): boolean {
  return imeComposing;
}

/** 조합 중이 아니면 즉시 실행, 조합 중이면 조합 종료 직후로 미룬다. */
export function runWhenImeIdle(fn: () => void): void {
  if (!imeComposing) {
    fn();
    return;
  }
  imeIdleQueue.push(fn);
}

export class EditGuard {
  private composing = false;
  private savingSelf = false;
  private roots: HTMLElement[] = [];

  /** 편집 영역 루트에 조합 추적 리스너를 단다. 여러 루트 attach 가능. */
  attach(root: HTMLElement): void {
    this.roots.push(root);
    root.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    root.addEventListener("compositionend", () => {
      this.composing = false;
    });
  }

  /** IME(한글 등) 조합 진행 중. */
  get isComposing(): boolean {
    return this.composing;
  }

  /** runSave 진행 중 (자기 저장 이벤트 무시용). */
  get isSavingSelf(): boolean {
    return this.savingSelf;
  }

  /** 조합 중이거나 포커스가 attach 된 루트 안에 있으면 true. */
  isEditing(): boolean {
    if (this.composing) return true;
    const active = document.activeElement;
    return !!active && this.roots.some((r) => r.contains(active));
  }

  /**
   * 자기 저장 실행 — 실행 중 + 직후 틱까지 isSavingSelf 가 유지된다.
   * 저장 실패는 그대로 throw 하니 호출부가 Notice 처리.
   */
  async runSave<T>(fn: () => Promise<T>): Promise<T> {
    this.savingSelf = true;
    try {
      return await fn();
    } finally {
      window.setTimeout(() => {
        this.savingSelf = false;
      }, 0);
    }
  }
}
