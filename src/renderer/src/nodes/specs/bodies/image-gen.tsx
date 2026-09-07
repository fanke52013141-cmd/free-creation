// 生图节点 Body（路线图 R6：bodies.tsx 拆分）
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import {
  imageCapabilitiesFor,
  normalizeImageGenerationConfig,
  sizesForImageAspectRatio,
  type ImageAspectRatio,
  type ImageGenerationConfig
} from '@shared/image-capabilities'
import { mediaUrl, type NodeBodyProps } from '../../registry'
import { toast } from '../../../stores/toast'
import { gatherUpstreamMediaList } from '../../../canvas/graph'
import { readNodeConfig } from '../../../canvas/node-persistence'
import { runNodeManually } from '../../../engine/executor'
import { useAppStore } from '../../../stores/app'
import { modelsByModality, useGatewayStore } from '../../../stores/gateway'
import { Icon } from '../../../components/Icon'
import { AppSelect } from '../../../components/AppSelect'
import { ModelSelect, NoModelHint, parseJsonProp } from './shared'

type ImageGenData = ImageGenerationConfig

function parseImageGen(text: string): ImageGenData {
  return parseJsonProp(
    text,
    (v) => {
      const o = v as Record<string, unknown>
      if (typeof o === 'object' && o !== null && typeof o.prompt === 'string') {
        return normalizeImageGenerationConfig(o, imageCapabilitiesFor('relay'))
      }
      return null
    },
    normalizeImageGenerationConfig({}, imageCapabilitiesFor('relay'))
  )
}

export function ImageGenerateBody({ shape }: NodeBodyProps): React.JSX.Element {
  const editor = useEditor()
  const project = useAppStore((s) => s.currentProject)
  const providers = useGatewayStore((s) => s.providers)
  const loaded = useGatewayStore((s) => s.loaded)
  const loadProviders = useGatewayStore((s) => s.load)
  const openSettings = useGatewayStore((s) => s.openSettings)
  const options = modelsByModality(providers, 'image')
  const data = parseImageGen(readNodeConfig(shape))
  const selected = options.find((option) => option.key === data.modelKey)
  const capabilities = selected
    ? imageCapabilitiesFor(selected.provider.specId, selected.model.id)
    : imageCapabilitiesFor('relay')
  const config = normalizeImageGenerationConfig(data, capabilities)
  const [draft, setDraft] = useState(data.prompt)
  const [busy, setBusy] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!loaded) void loadProviders()
  }, [loaded, loadProviders])

  const update = (next: ImageGenData): void => {
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(normalizeImageGenerationConfig(next, capabilities)) }
    })
  }

  // 所有图片都使用同一个多值端口，连接顺序就是 @图片 1～4 的顺序。
  const referenceImages = gatherUpstreamMediaList(editor, shape.id, 'in-images', 'image')
  const mentionMatch = draft.match(/@([^\s]*)$/)
  const showMentionMenu = referenceImages.length > 0 && mentionMatch !== null

  const insertReferenceMention = (index: number): void => {
    const textarea = promptRef.current
    const caret = textarea?.selectionStart ?? draft.length
    const before = draft.slice(0, caret)
    const after = draft.slice(textarea?.selectionEnd ?? caret)
    const match = before.match(/@([^\s]*)$/)
    const replacement = `@图片 ${index + 1} `
    const next = match
      ? `${before.slice(0, before.length - match[0].length)}${match[0].startsWith(' ') ? ' ' : ''}${replacement}${after}`
      : `${before}${replacement}${after}`
    setDraft(next)
    requestAnimationFrame(() => {
      if (!textarea) return
      const position = before.length - (match?.[0].length ?? 0) + replacement.length
      textarea.focus()
      textarea.setSelectionRange(position, position)
    })
  }

  const generate = async (): Promise<void> => {
    if (!project) return toast('项目未就绪')
    // 先提交本次编辑，再由统一运行器读取节点配置和真实上游端口输入。
    update({ ...config, prompt: draft })
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }

  if (!options.length) return <NoModelHint onOpen={openSettings} />

  return (
    <div className="gen-panel">
      {referenceImages.length > 0 && (
        <div className="ref-image-bar">
          <div className="ref-image-stack" aria-label={`${referenceImages.length} 张参考图`}>
            {referenceImages.slice(0, 4).map((image, index) => (
              <button
                key={image.mediaId}
                type="button"
                className="ref-image-chip"
                title={`插入 @图片 ${index + 1}`}
                aria-label={`插入 @图片 ${index + 1}`}
                onPointerDown={(e) => stopEventPropagation(e)}
                onClick={(e) => {
                  e.stopPropagation()
                  insertReferenceMention(index)
                }}
              >
                <img
                  className="ref-image-thumb"
                  src={mediaUrl(image.mediaPath)}
                  alt={`图片 ${index + 1}`}
                  draggable={false}
                />
                <span>图片 {index + 1}</span>
              </button>
            ))}
          </div>
          <span className="ref-image-label">
            <Icon name="attach" size={13} />
            已连接 {referenceImages.length} 张参考图，可用 @图片 1… 调用
          </span>
        </div>
      )}
      <div className="gen-row">
        <ModelSelect
          value={data.modelKey}
          options={options}
          onChange={(key) => {
            const next = options.find((option) => option.key === key)
            const nextCapabilities = next
              ? imageCapabilitiesFor(next.provider.specId, next.model.id)
              : imageCapabilitiesFor('relay')
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              props: {
                config: JSON.stringify(
                  normalizeImageGenerationConfig({ ...config, modelKey: key }, nextCapabilities)
                )
              }
            })
          }}
        />
        <AppSelect
          className="gen-select w92"
          value={config.aspectRatio}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const ratio = e.target.value as ImageAspectRatio
            update({
              ...config,
              aspectRatio: ratio,
              size: sizesForImageAspectRatio(capabilities, ratio)[0]?.value ?? 'auto'
            })
          }}
        >
          {capabilities.ratios.map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio === 'auto' ? '默认画幅' : ratio}
            </option>
          ))}
        </AppSelect>
      </div>
      <textarea
        ref={promptRef}
        className="gen-prompt"
        value={draft}
        rows={3}
        spellCheck={false}
        placeholder="描述要生成的画面…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => update({ ...config, prompt: draft })}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {showMentionMenu && (
        <div className="ref-mention-menu" role="listbox" aria-label="选择参考图片">
          {referenceImages.slice(0, 4).map((image, index) => (
            <button
              type="button"
              key={image.mediaId}
              onPointerDown={(e) => stopEventPropagation(e)}
              onClick={(e) => {
                e.stopPropagation()
                insertReferenceMention(index)
              }}
            >
              <img src={mediaUrl(image.mediaPath)} alt="" />
              @图片 {index + 1}
            </button>
          ))}
        </div>
      )}
      <button
        className="btn-primary small gen-go"
        disabled={busy}
        onPointerDown={(e) => stopEventPropagation(e)}
        onClick={(e) => {
          e.stopPropagation()
          void generate()
        }}
      >
        {busy ? (
          '生成中…'
        ) : (
          <>
            <Icon name="spark" size={14} />
            生成图片
          </>
        )}
      </button>
    </div>
  )
}
