// 生图节点 Body（路线图 R6：bodies.tsx 拆分）
// 多供应商级联：选中哪个供应商，就按其能力表呈现参数页（画幅/分辨率），默认 ToAPIS 优先。
import { useEffect, useRef, useState } from 'react'
import { stopEventPropagation, useEditor } from 'tldraw'
import {
  imageCapabilitiesFor,
  normalizeImageGenerationConfig,
  sizesForImageAspectRatio,
  type ImageAspectRatio,
  type ImageGenerationConfig,
  type ImageResolution
} from '@shared/image-capabilities'
import { defaultImageProviderId } from '@shared/engine/models'
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
      if (typeof o === 'object' && o !== null) {
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
  // 供应商解析：显式 providerKey > modelKey 反推 > 默认供应商（ToAPIS 实例优先）。
  const selectedProviderId =
    data.providerKey ?? resolveExplicitProviderId(options, data) ?? defaultImageProviderId(options)
  const providerIds = [...new Set(options.map((option) => option.provider.id))]
  const providerModels = options.filter((option) => option.provider.id === selectedProviderId)
  const selected =
    providerModels.find((option) => option.key === data.modelKey) ?? providerModels[0]
  const capabilities = selected
    ? imageCapabilitiesFor(selected.provider.specId, selected.model.id)
    : imageCapabilitiesFor('relay')
  const config = normalizeImageGenerationConfig(data, capabilities)
  const [draft, setDraft] = useState(shape.props.text)
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

  const updateText = (text: string): void => {
    if (text !== shape.props.text)
      editor.updateShape({ id: shape.id, type: 'node-card', props: { text } })
  }

  // 切换供应商：模型列表级联过滤，模型重置为该供应商首个图片模型，参数按新能力表归一化。
  const changeProvider = (providerId: string): void => {
    const first = options.find((option) => option.provider.id === providerId)
    const nextCapabilities = first
      ? imageCapabilitiesFor(first.provider.specId, first.model.id)
      : imageCapabilitiesFor('relay')
    const nextConfig = normalizeImageGenerationConfig(
      { ...config, providerKey: providerId, modelKey: first?.key ?? '' },
      nextCapabilities
    )
    editor.updateShape({
      id: shape.id,
      type: 'node-card',
      props: { config: JSON.stringify(nextConfig) }
    })
  }

  // 所有图片都使用同一个多值端口，连接顺序就是 @图片 1…N 的顺序；N 的上限来自能力表。
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
    if (!selected) return toast('未选择可用图片模型')
    // 先提交包含默认供应商/模型解析的完整配置，再由统一运行器读取节点配置和真实上游端口输入。
    update({ ...config, modelKey: selected.key, providerKey: selected.provider.id })
    updateText(draft)
    setBusy(true)
    try {
      await runNodeManually(editor, project.id, providers, shape.id)
    } finally {
      setBusy(false)
    }
  }

  if (!options.length) return <NoModelHint onOpen={openSettings} presetIds={['toapis', 'relay']} />

  return (
    <div className="gen-panel">
      <div className="gen-row">
        <AppSelect
          className="gen-select gen-provider"
          value={selectedProviderId ?? ''}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => changeProvider(e.target.value)}
          aria-label="选择供应商"
        >
          {!providerIds.includes(selectedProviderId ?? '') && <option value="">选择供应商…</option>}
          {providerIds.map((providerId) => {
            const option = options.find((item) => item.provider.id === providerId)
            return (
              <option key={providerId} value={providerId}>
                {option?.provider.name ?? providerId}
              </option>
            )
          })}
        </AppSelect>
        <ModelSelect
          value={data.modelKey || selected?.key || ''}
          options={providerModels}
          onChange={(key) => {
            const next = options.find((option) => option.key === key)
            const nextCapabilities = next
              ? imageCapabilitiesFor(next.provider.specId, next.model.id)
              : imageCapabilitiesFor('relay')
            const nextConfig = normalizeImageGenerationConfig(
              { ...config, modelKey: key, providerKey: next?.provider.id ?? selectedProviderId },
              nextCapabilities
            )
            editor.updateShape({
              id: shape.id,
              type: 'node-card',
              props: { config: JSON.stringify(nextConfig) }
            })
          }}
        />
      </div>
      <div className="gen-row">
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
        {capabilities.resolutions.length > 0 && (
          <AppSelect
            className="gen-select w86"
            value={config.resolution ?? capabilities.resolutions[0]}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => update({ ...config, resolution: e.target.value as ImageResolution })}
            aria-label="选择分辨率"
          >
            {capabilities.resolutions.map((resolution) => (
              <option key={resolution} value={resolution}>
                {resolution}
              </option>
            ))}
          </AppSelect>
        )}
        {capabilities.supportsTransparentBackground && (
          <label className="gen-check" title="输出透明背景 PNG；关闭时由供应商决定背景">
            <input
              type="checkbox"
              checked={config.background === 'transparent'}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) =>
                update({ ...config, background: e.target.checked ? 'transparent' : undefined })
              }
            />
            透明底
          </label>
        )}
      </div>
      <textarea
        ref={promptRef}
        className="gen-prompt"
        value={draft}
        spellCheck={false}
        placeholder="描述要生成的画面…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => updateText(draft)}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {showMentionMenu && (
        <div className="ref-mention-menu" role="listbox" aria-label="选择参考图片">
          {referenceImages.slice(0, capabilities.maxReferenceImages).map((image, index) => (
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

/** 从 modelKey 反推已选供应商（仅显式命中，不做默认回退）。 */
function resolveExplicitProviderId(
  options: ReturnType<typeof modelsByModality>,
  data: ImageGenData
): string | undefined {
  if (!data.modelKey) return undefined
  return options.find((option) => option.key === data.modelKey)?.provider.id
}
