import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Raw HTML in the source is not rendered (react-markdown default), so file content cannot inject markup.
const components = {
  h1: (p) => <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0" {...p} />,
  h2: (p) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0" {...p} />,
  h3: (p) => <h3 className="mb-1 mt-3 text-base font-semibold first:mt-0" {...p} />,
  p: (p) => <p className="my-2 leading-relaxed" {...p} />,
  ul: (p) => <ul className="my-2 list-disc space-y-1 pl-6" {...p} />,
  ol: (p) => <ol className="my-2 list-decimal space-y-1 pl-6" {...p} />,
  a: (p) => <a className="text-sky-400 hover:underline" target="_blank" rel="noopener noreferrer" {...p} />,
  blockquote: (p) => <blockquote className="my-2 border-l-2 border-neutral-700 pl-3 text-neutral-400" {...p} />,
  hr: () => <hr className="my-4 border-neutral-800" />,
  pre: (p) => <pre className="my-2 overflow-auto rounded bg-neutral-950 p-3 text-xs" {...p} />,
  code: ({ className, ...p }) => (
    <code className={className ?? 'rounded bg-neutral-800 px-1 py-0.5 text-[0.85em]'} {...p} />
  ),
  table: (p) => <table className="my-2 w-full border-collapse text-sm" {...p} />,
  th: (p) => <th className="border border-neutral-800 px-2 py-1 text-left font-medium" {...p} />,
  td: (p) => <td className="border border-neutral-800 px-2 py-1" {...p} />,
}

export default function Markdown({ children }) {
  return (
    <div className="text-sm text-neutral-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
