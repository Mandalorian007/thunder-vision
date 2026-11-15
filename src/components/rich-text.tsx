import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export const linkCls =
  "text-primary underline-offset-2 hover:underline focus-visible:underline outline-none";

/** Markdown from Claude or a workflow. Raw HTML in it is shown as text, not rendered. */
export function Summary({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed break-words select-text [&_:is(p,ul,ol,pre,table,blockquote,h1,h2,h3,h4)]:my-2 [&>:first-child]:mt-0 [&>:last-child]:mb-0",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className={linkCls}>
              {children}
            </a>
          ),
          h1: ({ children }) => (
            <h3 className="text-base font-semibold">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="text-sm font-semibold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="text-sm font-semibold">{children}</h4>
          ),
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => (
            <ol className="list-decimal pl-5">{children}</ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 pl-3 text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => (
            <code
              className={cn(
                "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
                className,
              )}
            >
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
                {children}
              </table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
