/**
 * Renders an agent message (markdown.ts parses it). Plain React elements: no HTML is ever injected,
 * links open in a new tab without access to the editor (noopener, noreferrer).
 */
import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Inline, type MdBlock } from './markdown.js';

function renderInline(list: readonly Inline[], key = ''): ReactNode[] {
  return list.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.type) {
      case 'text':
        return n.text;
      case 'code':
        return (
          <code key={k} className="ed-md-code">
            {n.text}
          </code>
        );
      case 'strong':
        return <strong key={k}>{renderInline(n.children, `${k}.`)}</strong>;
      case 'em':
        return <em key={k}>{renderInline(n.children, `${k}.`)}</em>;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.children, `${k}.`)}
          </a>
        );
      case 'br':
        return <br key={k} />;
    }
  });
}

function renderBlocks(blocks: readonly MdBlock[], key = ''): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}${i}`;
    switch (b.type) {
      case 'paragraph':
        return <p key={k}>{renderInline(b.inline)}</p>;
      case 'heading':
        return (
          <p key={k} className="ed-md-heading" data-level={b.level} role="heading" aria-level={b.level + 2}>
            {renderInline(b.inline)}
          </p>
        );
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} data-task={it.checked === null ? undefined : it.checked ? 'done' : 'open'}>
            {it.checked !== null && <span className="ed-md-check" aria-label={it.checked ? '☑' : '☐'} />}
            {renderInline(it.inline)}
            {it.children.length > 0 && renderBlocks(it.children, `${k}.${j}.`)}
          </li>
        ));
        return b.ordered ? (
          <ol key={k} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k}>{items}</ul>
        );
      }
      case 'code':
        return (
          <pre key={k} className="ed-md-pre" data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.blocks, `${k}.`)}</blockquote>;
      case 'rule':
        return <hr key={k} />;
      case 'table':
        return (
          <div key={k} className="ed-md-table">
            <table>
              <thead>
                <tr>
                  {b.header.map((c, j) => (
                    <th key={j}>{renderInline(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, m) => (
                      <td key={m}>{renderInline(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function MessageText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={className ? `ed-md ${className}` : 'ed-md'}>{renderBlocks(blocks)}</div>;
}
