import type { ReactNode } from "react";
import type { AskSource } from "@turing/contracts";

/**
 * Renders model output as React elements only; raw HTML is never interpreted.
 * shortcut: covers fences, headings, lists, paragraphs, `code`, **bold**, *italic* and [n] citations; no tables or links.
 */
export function AskMarkdown({
  text,
  sources = [],
  open,
}: {
  text: string;
  sources?: AskSource[];
  open?: (source: AskSource) => void;
}) {
  const inline = (line: string, key: string) =>
    line
      .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|\[\d+\])/)
      .map((part, index): ReactNode => {
        const id = `${key}.${index}`;
        if (/^`[^`]+`$/.test(part))
          return <code key={id}>{part.slice(1, -1)}</code>;
        if (/^\*\*.+\*\*$/.test(part))
          return <strong key={id}>{part.slice(2, -2)}</strong>;
        if (/^\*.+\*$/.test(part)) return <em key={id}>{part.slice(1, -1)}</em>;
        const citation = /^\[(\d+)\]$/.exec(part);
        const source = citation && sources[Number(citation[1]) - 1];
        if (citation && source && open) {
          const label = `${source.relativePath}:${source.startLine}–${source.endLine}`;
          return (
            <button
              key={id}
              type="button"
              className="ask-citation"
              aria-label={`Source ${citation[1]}: ${label}`}
              title={label}
              onClick={() => open(source)}
            >
              {citation[1]}
            </button>
          );
        }
        return part;
      });

  const blocks: ReactNode[] = [];
  text.split("```").forEach((part, fence) => {
    if (fence % 2 === 1) {
      blocks.push(
        <pre key={`f${fence}`}>
          <code>{part.replace(/^[\w+.#-]*\n/, "")}</code>
        </pre>,
      );
      return;
    }
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | undefined;
    const flush = (key: string) => {
      if (paragraph.length) {
        blocks.push(<p key={`p${key}`}>{inline(paragraph.join("\n"), key)}</p>);
        paragraph = [];
      }
      if (list) {
        const items = list.items.map((item, index) => (
          <li key={index}>{inline(item, `${key}.${index}`)}</li>
        ));
        blocks.push(
          list.ordered ? (
            <ol key={`l${key}`}>{items}</ol>
          ) : (
            <ul key={`l${key}`}>{items}</ul>
          ),
        );
        list = undefined;
      }
    };
    part.split("\n").forEach((line, row) => {
      const key = `${fence}.${row}`;
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const item = /^\s*(?:([-*+])|\d+[.)])\s+(.*)$/.exec(line);
      if (!line.trim()) {
        flush(key);
      } else if (heading) {
        flush(key);
        blocks.push(<h4 key={`h${key}`}>{inline(heading[1] ?? "", key)}</h4>);
      } else if (item) {
        const ordered = !item[1];
        if (paragraph.length || (list && list.ordered !== ordered)) flush(key);
        list ??= { ordered, items: [] };
        list.items.push(item[2] ?? "");
      } else {
        if (list) flush(key);
        paragraph.push(line);
      }
    });
    flush(`${fence}.end`);
  });
  return <div className="ask-answer">{blocks}</div>;
}
