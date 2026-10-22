import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Wide tables scroll inside their own box instead of stretching the panel.
// `node` is react-markdown's hast node; keep it off the DOM.
const components: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table {...props} className="w-max border-collapse" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="border border-border bg-muted px-2 py-1 text-left font-semibold"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td {...props} className="border border-border px-2 py-1 align-top" />
  ),
};

/**
 * Markdown from the model. Raw HTML stays text (no rehype-raw), and images
 * are dropped: model text can echo output from hosts or tools, so never let
 * it load a remote image (and leak data in the URL) just by being shown.
 */
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      disallowedElements={["img"]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
