import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Đã chép" : "Chép"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1200);
          },
          () => undefined,
        );
      }}
      className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/10 hover:text-fg"
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />}
    </button>
  );
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]\(https?:\/\/[^)\s]+\)|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-fg/10 px-1 py-0.5 text-sm">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      const href = token.slice(token.indexOf("(") + 1, -1);
      const label = token.slice(0, token.indexOf("(")).replace(/^\[+/, "").replace(/\]+$/, "");
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="underline decoration-accent/70 underline-offset-2">
          {label}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function RichText({ text }: { text: string }) {
  const parts = text.split("```");
  return (
    <div className="space-y-3 text-pretty">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const newline = part.indexOf("\n");
          const lang = newline === -1 ? "" : part.slice(0, newline).trim();
          const code = (newline === -1 ? part : part.slice(newline + 1)).replace(/\n$/, "");
          return (
            <div key={index} className="relative rounded-xl bg-bg shadow-ring">
              <div className="flex items-center justify-between px-3 pt-2">
                <span className="text-xs tracking-wide text-muted uppercase">{lang || "mã"}</span>
                <CopyButton text={code} />
              </div>
              <pre className="max-h-80 overflow-auto px-3 pb-3 text-sm leading-relaxed break-all whitespace-pre-wrap">
                <code>{code}</code>
              </pre>
            </div>
          );
        }
        return part.split(/\n{2,}/).map((paragraph, paragraphIndex) => {
          const lines = paragraph.split("\n");
          const quote = lines.every((line) => !line.trim() || line.trim().startsWith(">"));
          if (quote && lines.some((line) => line.trim())) {
            const body = lines
              .filter((line) => line.trim())
              .map((line) => line.trim().replace(/^>\s?/, ""))
              .join("\n");
            return (
              <blockquote key={`${index}-${paragraphIndex}`} className="border-l-2 border-accent py-1 pl-3 text-muted">
                {body.split("\n").map((line, lineIndex) => (
                  <p key={lineIndex}>{inline(line, `${index}-q-${paragraphIndex}-${lineIndex}`)}</p>
                ))}
              </blockquote>
            );
          }
          const list = lines.every((line) => !line.trim() || /^[-*]\s+/.test(line.trim()));
          if (list && lines.some((line) => line.trim())) {
            return (
              <ul key={`${index}-${paragraphIndex}`} className="list-disc space-y-1 pl-5">
                {lines
                  .filter((line) => line.trim())
                  .map((line, lineIndex) => (
                    <li key={lineIndex}>{inline(line.trim().replace(/^[-*]\s+/, ""), `${index}-${lineIndex}`)}</li>
                  ))}
              </ul>
            );
          }
          return (
            <p key={`${index}-${paragraphIndex}`} className="leading-relaxed break-all">
              {lines.map((line, lineIndex) => (
                <span key={lineIndex}>
                  {lineIndex > 0 && <br />}
                  {inline(line, `${index}-${paragraphIndex}-${lineIndex}`)}
                </span>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}
