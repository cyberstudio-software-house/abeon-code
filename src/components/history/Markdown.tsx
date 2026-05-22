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
      className="text-xs overflow-x-auto rounded"
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
          // react-markdown v9+ no longer passes `inline` - use heuristic:
          // language class OR newline in code = block code.
          const isBlock = !!m || code.includes('\n');
          if (!isBlock) {
            return (
              <code
                className="bg-bg-elev-2 px-1 rounded text-[0.95em]"
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
            className="text-accent underline"
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});
