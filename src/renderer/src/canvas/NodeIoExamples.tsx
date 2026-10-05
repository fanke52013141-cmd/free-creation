import { NODE_IO_EXAMPLES } from './node-io-examples'
import { toast } from '../stores/toast'

export function NodeIoExamples({ nodeType }: { nodeType: string }): React.JSX.Element | null {
  const examples = NODE_IO_EXAMPLES[nodeType]
  if (!examples) return null
  return (
    <section className="contract-section node-io-examples" aria-label="输入输出示例">
      <h4>输入输出示例</h4>
      {examples.map((example) => (
        <article className="node-io-example" key={example.title}>
          <h5>{example.title}</h5>
          <div className="node-io-example-heading">
            <strong>输入示例</strong>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(example.input).then(
                  () => toast('已复制输入示例'),
                  () => toast('复制失败，请手动选择示例文字')
                )
              }
            >
              复制
            </button>
          </div>
          <pre>{example.input}</pre>
          <strong>设置与连接</strong>
          <p>{example.settings}</p>
          <strong>预期输出</strong>
          <pre>{example.output}</pre>
          <p>{example.explanation}</p>
        </article>
      ))}
    </section>
  )
}
