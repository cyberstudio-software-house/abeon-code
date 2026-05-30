import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml } from 'shiki';
import { useStore } from '../../store';

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const theme = useStore((s) => s.theme);
  const [html, setHtml] = useState('');
  useEffect(() => {
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    const target = resolved === 'light' ? 'github-light' : 'github-dark';
    codeToHtml(code, { lang: lang || 'text', theme: target })
      .then(setHtml)
      .catch(() => setHtml(`<pre>${escapeHtml(code)}</pre>`));
  }, [code, lang, theme]);
  return (
    <div
      className="text-[12px] overflow-x-auto rounded-md my-3 [&_pre]:p-3.5 [&_pre]:rounded-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children, ...props }) {
          const m = /language-(\w+)/.exec(className || '');
          const code = String(children).replace(/\n$/, '');
          const isBlock = !!m || code.includes('\n');
          if (!isBlock) {
            return (
              <code
                className="bg-bg-elev-2 px-1.5 py-0.5 rounded text-[0.9em] font-mono"
                {...props}
              >
                {children}
              </code>
            );
          }
          return <CodeBlock lang={m?.[1] ?? ''} code={code} />;
        },
        a: ({ href, children }) => (
          <a
            href={href ?? '#'}
            className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        p: ({ children }) => (
          <p className="my-2.5 leading-relaxed">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="my-2.5 ml-5 list-disc space-y-1 marker:text-muted">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-2.5 ml-5 list-decimal space-y-1 marker:text-muted">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="leading-relaxed pl-1">{children}</li>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-3 border-l-[3px] border-accent/50 pl-4 text-fg-secondary italic">
            {children}
          </blockquote>
        ),
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-[12px] border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-bg-elev-2 text-[11px] uppercase tracking-wider text-muted">
            {children}
          </thead>
        ),
        th: ({ children }) => (
          <th className="px-3 py-2 text-left font-medium border-b border-border">{children}</th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 border-b border-border/50">{children}</td>
        ),
        hr: () => (
          <hr className="my-5 border-0 border-t border-border" />
        ),
        h1: ({ children }) => (
          <h1 className="text-[1.3em] font-semibold mt-5 mb-2">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-[1.15em] font-semibold mt-4 mb-2">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-[1.05em] font-semibold mt-3 mb-1.5">{children}</h3>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-fg">{children}</strong>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
