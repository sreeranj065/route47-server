/**
 * Lightweight plain-text extraction for Route47 searchable PDFs
 * (uncompressed content streams with `(word) Tj` operators).
 */
function decodePdfLiteral(literal: string): string {
  return literal
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    )
    .replace(/\\(.)/g, "$1");
}

export function extractPlainTextFromPdf(buffer: Buffer): string {
  if (!buffer?.length) return "";
  const raw = buffer.toString("latin1");
  const words: string[] = [];

  const tjRe = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = tjRe.exec(raw)) !== null) {
    const text = decodePdfLiteral(match[1] ?? "").trim();
    if (text) words.push(text);
  }

  const tjArrayRe = /\[([\s\S]*?)\]\s*TJ/g;
  while ((match = tjArrayRe.exec(raw)) !== null) {
    const inner = match[1] ?? "";
    const litRe = /\(((?:\\.|[^\\)])*)\)/g;
    let lit: RegExpExecArray | null;
    while ((lit = litRe.exec(inner)) !== null) {
      const text = decodePdfLiteral(lit[1] ?? "").trim();
      if (text) words.push(text);
    }
  }

  return words.join(" ").replace(/\s+/g, " ").trim().slice(0, 200_000);
}
