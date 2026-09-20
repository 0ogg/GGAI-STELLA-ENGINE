import type { SessionImageAttachment } from "../types/session";

/** 저장된 캡션을 후속 턴과 비전 미지원 모델도 이해할 수 있는 텍스트로 만든다. */
export function appendAttachmentContext(
  text: string,
  attachments: readonly SessionImageAttachment[] | undefined,
  responsePrompt: string
): string {
  if (!attachments?.length) return text;
  const descriptions = attachments
    .map((item, index) => {
      const caption = item.caption.trim() || item.name?.trim() || "Image attached by the user";
      return `Image ${index + 1}: ${caption}`;
    })
    .join("\n");
  const guidance = responsePrompt.trim();
  return `${text}\n\n[Attached image context]\n${descriptions}${
    guidance ? `\n\n[Response guidance]\n${guidance}` : ""
  }`;
}
