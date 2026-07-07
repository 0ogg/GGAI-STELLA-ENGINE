/**
 * 읽기 모드 내보내기 — 순수 함수.
 *
 * 현재 활성 분기의 본문을 마크다운으로 만들고, 활성 경로의 삽화를 인라인 표시와
 * 같은 위치(문단 경계)에 임베드한다. mode = "translated" 이면 번역된 문단은 번역으로,
 * 미번역 문단은 원문으로 채운다(번역 보기와 같은 규칙).
 *
 * 이미지 임베드는 vault 절대 경로 위키링크(`![[folder/assets/xxx.png]]`)로 넣어
 * 내보낸 문서를 어느 폴더에 두든 옵시디언이 해석하게 한다.
 */

import type { SessionIllustrations, SessionTranslations } from "../types/media";
import type { StellaSession } from "../types/session";
import { buildSpans, spansToText } from "./session-text";
import {
  getActiveTranslation,
  tokenizeParagraphs,
} from "./translate-paragraphs";
import { computeIllustrationAnchors } from "./illustration-anchors";
import { getActiveIllustration } from "./illustrations";

export type ReadingExportMode = "source" | "translated";

export interface ReadingExportInput {
  session: StellaSession;
  /** 세션 폴더 경로 (삽화 상대경로의 기준). */
  sessionFolder: string;
  illustrations: SessionIllustrations | null;
  translations: SessionTranslations | null;
  mode: ReadingExportMode;
  /** 문서 상단 제목 (세션 이름 등). */
  title: string;
}

export function buildReadingMarkdown(input: ReadingExportInput): string {
  const { session, sessionFolder, illustrations, translations, mode, title } =
    input;
  const leafId = session.meta.activeLeafId;
  const raw = spansToText(buildSpans(session, leafId));

  const anchors =
    illustrations != null
      ? computeIllustrationAnchors(session, illustrations, leafId)
      : [];
  const useTranslation = mode === "translated" && translations != null;

  let out = title.trim() ? `# ${title.trim()}\n\n` : "";
  let offset = 0;
  let ai = 0;

  const emitAnchorsUpTo = (pos: number): void => {
    while (ai < anchors.length && anchors[ai].offset <= pos) {
      const anchor = anchors[ai++];
      const active = illustrations
        ? getActiveIllustration(illustrations, anchor.nodeId)
        : null;
      if (active) out += `\n![[${sessionFolder}/${active.path}]]\n\n`;
    }
  };

  for (const token of tokenizeParagraphs(raw)) {
    emitAnchorsUpTo(offset);
    if (token.kind === "separator") {
      out += token.text;
      offset += token.text.length;
    } else {
      const text = useTranslation
        ? getActiveTranslation(translations!, token.hash)?.text ?? token.source
        : token.source;
      out += text;
      offset += token.source.length;
    }
  }
  emitAnchorsUpTo(offset);

  return out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
