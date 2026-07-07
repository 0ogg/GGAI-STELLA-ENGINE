/**
 * 외부 의존성 없는 UUID v4 생성기.
 * crypto.randomUUID 가 있으면 그걸 쓰고, 아니면 Math.random 폴백.
 */
export function uuidv4(): string {
  const g: any = globalThis;
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const h = Array.from(bytes, hex).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
