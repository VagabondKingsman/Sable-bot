type Sheet = { jpeg: Uint8Array; width: number; height: number };

const PAGE_W = 595;
const PAGE_H = 842;

export async function responsePdf(input: { prompt: string; answer: string }) {
  const pages = await paint(input.prompt, input.answer);
  return new Blob([buildPdf(pages)], { type: "application/pdf" });
}

async function paint(prompt: string, answer: string): Promise<Sheet[]> {
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = PAGE_W * scale;
  canvas.height = PAGE_H * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không xuất được PDF.");
  ctx.scale(scale, scale);
  ctx.font = "16px Outfit, sans-serif";
  const blocks = [
    ...styled(ctx, "Sable", "title"),
    ...styled(ctx, "Bạn", "label"),
    ...styled(ctx, prompt || "—", "body"),
    ...styled(ctx, "Sable", "label"),
    ...styled(ctx, answer || "—", "body"),
  ];
  const pages: Sheet[] = [];
  let cursor = 0;
  for (let page = 0; page < 8 && cursor < blocks.length; page += 1) {
    ctx.fillStyle = "#f6f1e8";
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.fillStyle = "#c46a3a";
    ctx.fillRect(48, 36, 36, 4);
    let y = 72;
    ctx.textBaseline = "top";
    while (cursor < blocks.length && y < PAGE_H - 48) {
      const line = blocks[cursor];
      ctx.fillStyle = line.kind === "title" ? "#1c1915" : line.kind === "label" ? "#c46a3a" : "#3a342c";
      ctx.font = line.kind === "title" ? "28px Fraunces, serif" : line.kind === "label" ? "13px Outfit, sans-serif" : "16px Outfit, sans-serif";
      ctx.fillText(line.text, 48, y);
      y += line.kind === "title" ? 40 : line.text ? 24 : 12;
      cursor += 1;
    }
    ctx.fillStyle = "#8a8175";
    ctx.font = "12px Outfit, sans-serif";
    ctx.fillText(String(page + 1), PAGE_W - 64, PAGE_H - 32);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
    if (!blob) throw new Error("Không xuất được PDF.");
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height });
  }
  return pages;
}

function styled(ctx: CanvasRenderingContext2D, text: string, kind: "title" | "label" | "body") {
  ctx.font = kind === "title" ? "28px Fraunces, serif" : kind === "label" ? "13px Outfit, sans-serif" : "16px Outfit, sans-serif";
  return wrap(ctx, text, 500).map((line) => ({ text: line.text, kind }));
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: { text: string }[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (!para.trim()) {
      lines.push({ text: "" });
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const piece = line ? `${line} ${word}` : word;
      if (ctx.measureText(piece).width <= maxWidth) {
        line = piece;
        continue;
      }
      if (line) lines.push({ text: line });
      if (ctx.measureText(word).width <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const char of word) {
        if (ctx.measureText(chunk + char).width > maxWidth && chunk) {
          lines.push({ text: chunk });
          chunk = char;
        } else chunk += char;
      }
      line = chunk;
    }
    if (line) lines.push({ text: line });
  }
  return lines;
}

function buildPdf(pages: Sheet[]) {
  const objects: (string | Uint8Array)[] = [];
  const pageIds: number[] = [];
  let next = 3;
  for (const page of pages) {
    const pageId = next;
    const contentId = next + 1;
    const imageId = next + 2;
    next += 3;
    pageIds.push(pageId);
    const content = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /XObject << /Im0 ${imageId} 0 R >> >> >>`;
    objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    objects[imageId] = jpegObject(page);
  }
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let size = 0;
  const add = (part: Uint8Array) => {
    chunks.push(part);
    size += part.length;
  };
  const text = new TextEncoder();
  add(text.encode("%PDF-1.4\n"));
  for (let id = 1; id < next; id += 1) {
    offsets[id] = size;
    const body = objects[id];
    add(text.encode(`${id} 0 obj\n`));
    if (typeof body === "string") add(text.encode(body));
    else add(body);
    add(text.encode("\nendobj\n"));
  }
  const xref = size;
  let table = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id += 1) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  table += `trailer << /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  add(text.encode(table));
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function jpegObject(page: Sheet) {
  const head = new TextEncoder().encode(
    `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
  );
  const tail = new TextEncoder().encode("\nendstream");
  const body = new Uint8Array(head.length + page.jpeg.length + tail.length);
  body.set(head, 0);
  body.set(page.jpeg, head.length);
  body.set(tail, head.length + page.jpeg.length);
  return body;
}
