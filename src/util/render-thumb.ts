import { App, setIcon } from "obsidian";

/** 카드 썸네일 — 이미지가 있으면 이미지, 없으면 아이콘 플레이스홀더 (사이드바/대시보드 공용). */
export function renderThumb(
  app: App,
  container: HTMLElement,
  thumbnailPath: string | null,
  alt: string,
  fallbackIcon: string
): void {
  if (thumbnailPath) {
    const img = container.createEl("img");
    img.src = app.vault.adapter.getResourcePath(thumbnailPath);
    img.alt = alt;
  } else {
    const placeholder = container.createDiv({ cls: "ggai-thumb-placeholder" });
    setIcon(placeholder, fallbackIcon);
  }
}
