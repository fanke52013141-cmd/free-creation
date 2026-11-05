import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FixedSkill, SkillPackage } from '@shared/agent-flow/runtime-contracts'
import {
  parseSkillBundleUpload,
  parseSkillUpload,
  SKILL_AGENT_TOOLS,
  BUILTIN_SKILL_IDS,
  SkillAgentConfigSchema,
  type SkillAgentConfig
} from '@shared/skill-agent'
import './skill-agent-settings.css'
import { Icon } from '../../../components/Icon'
import { NumberStepper } from '../../../components/NumberStepper'
import { parseJsonObj } from '@shared/engine/helpers'
import type { NodeSettingsProps } from '../../registry'

const SKILL_EXAMPLE = `---
name: 我的技能
description: 一句话说明
version: 1.0.0
---
正文写技能指令：做什么、按什么步骤、输出什么格式。`

/** 技能格式与校验说明（与 shared/skill-agent.ts、runtime-contracts.ts 的规则同步）。 */
function SkillHelpPopover(): React.JSX.Element {
  const [copyStatus, setCopyStatus] = useState('')
  const helpRef = useRef<HTMLDivElement>(null)
  return (
    <div className="skill-help-popover" role="note" ref={helpRef}>
      <button
        type="button"
        className="skill-help-copy"
        onClick={() => {
          const text = (helpRef.current?.innerText ?? '')
            .split('\n')
            .filter((line) => !['复制说明', '复制示例', copyStatus].includes(line.trim()))
            .join('\n')
          void navigator.clipboard.writeText(text).then(
            () => setCopyStatus('已复制说明'),
            () => setCopyStatus('复制失败，请手动选择说明')
          )
        }}
      >
        复制说明
      </button>
      <strong>支持的格式</strong>
      <ul>
        <li>单个文件：SKILL.md 或 .json 技能包，不超过 128 KiB</li>
        <li>技能目录：根部 1 个 SKILL.md + 至多 16 个根级 .md 参考（不嵌套子目录）</li>
        <li>暂不支持 ZIP 压缩包；请先解压后选择目录</li>
      </ul>
      <strong>SKILL.md 写法</strong>
      <button
        type="button"
        className="skill-help-copy"
        onClick={() => {
          void navigator.clipboard.writeText(SKILL_EXAMPLE).then(
            () => setCopyStatus('已复制'),
            () => setCopyStatus('复制失败，请手动选择示例')
          )
        }}
      >
        复制示例
      </button>
      <span role="status">{copyStatus}</span>
      <pre>{SKILL_EXAMPLE}</pre>
      <ul>
        <li>元数据可省略；仅支持单行 name / description / version，工具依赖请用 JSON 技能包</li>
      </ul>
      <strong>上传后如何校验</strong>
      <ul>
        <li>结构校验：根部必须有 SKILL.md；参考文件名仅限字母数字下划线连字符 + .md</li>
        <li>大小校验：整包 ≤128 KiB；单条指令 ≤32768 字符；参考资源 ≤16 个</li>
        <li>
          版本不可变：同 id + 同版本内容不可修改，改动后请更新 version
          再上传，否则报「该技能版本已存在」
        </li>
        <li>生效方式：上传后勾选绑定到节点，运行时 Agent 按指令执行，可只读参考 .md</li>
      </ul>
    </div>
  )
}

export function ChatSkillAgentSettings({
  shape,
  editor,
  disabled
}: Pick<NodeSettingsProps, 'shape' | 'editor'> & { disabled?: boolean }): React.JSX.Element {
  const config = parseJsonObj(shape.props.config) ?? {}
  const agent = SkillAgentConfigSchema.safeParse(config.agent ?? {})
  return (
    <SkillAgentSettings
      disabled={disabled}
      value={agent.success ? agent.data : undefined}
      onChange={(next) =>
        editor.updateShape({
          id: shape.id,
          type: 'node-card',
          props: { config: JSON.stringify({ ...config, agent: next }) }
        })
      }
    />
  )
}

function packageOf(skill: FixedSkill): SkillPackage {
  return {
    schemaVersion: skill.schemaVersion,
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    requiredTools: skill.requiredTools,
    resources: skill.resources
  }
}

export function SkillAgentSettings({
  value,
  onChange,
  disabled
}: {
  value?: SkillAgentConfig
  onChange: (value: SkillAgentConfig) => void
  disabled?: boolean
}): React.JSX.Element {
  const [library, setLibrary] = useState<FixedSkill[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dirInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    // Chromium 的目录选择依赖 webkitdirectory；React 不识别该属性，直接设置。
    dirInput.current?.setAttribute('webkitdirectory', '')
  }, [])
  const parsed = SkillAgentConfigSchema.safeParse(value ?? {})
  const selected = parsed.success ? parsed.data.skills : []
  const maxSteps = parsed.success ? parsed.data.maxSteps : 6
  const save = (next: SkillAgentConfig): void => {
    const checked = SkillAgentConfigSchema.safeParse(next)
    if (!checked.success) {
      setError('最多绑定 8 个技能，总内容不得超过 256 KiB')
      return
    }
    onChange(checked.data)
  }
  useEffect(() => {
    let disposed = false
    void window.api
      .listSkills()
      .then((reply) => {
        if (disposed) return
        if (reply.ok) setLibrary(reply.data)
        else setError(reply.error.message)
      })
      .catch(() => {
        if (!disposed) setError('无法读取技能库，请重新打开设置')
      })
    return () => {
      disposed = true
    }
  }, [])

  const install = async (files: FileList | File[]): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const list = Array.from(files)
      let skill
      if (list.length === 1) {
        const file = list[0]
        if (file.size > 131072) throw new Error('技能文件超过 128 KiB')
        skill = parseSkillUpload(file.name, await file.text())
      } else {
        // 目录包：受控解析（根部 SKILL.md + 扁平 .md 资源，路径与预算校验）。
        const root = list[0].webkitRelativePath.split('/')[0]
        if (!root || list.some((file) => !file.webkitRelativePath.startsWith(`${root}/`))) {
          throw new Error('技能文件必须来自同一个目录')
        }
        const entries = await Promise.all(
          list.map(async (file) => ({
            path: file.webkitRelativePath.slice(root.length + 1),
            content: await file.text()
          }))
        )
        skill = parseSkillBundleUpload(entries)
      }
      const reply = await window.api.installSkill(skill)
      if (!reply.ok) throw new Error(reply.error.message)
      setLibrary((items) => [
        ...items.filter((item) => item.id !== skill.id || item.version !== skill.version),
        reply.data
      ])
    } catch (error) {
      setError(
        error instanceof Error && !('issues' in error)
          ? error.message
          : '技能格式无效，请检查元数据与包结构'
      )
    } finally {
      setBusy(false)
    }
  }
  const entries = [...library.filter((skill) => !BUILTIN_SKILL_IDS.has(skill.id)).map(packageOf)]
  for (const skill of selected)
    if (!entries.some((item) => item.id === skill.id && item.version === skill.version))
      entries.push(skill)
  return (
    <fieldset className="settings-field skill-agent-settings" disabled={disabled}>
      <legend>
        Agent 技能
        <button
          type="button"
          className="skill-help-toggle"
          aria-label="技能格式与校验说明"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((current) => !current)}
        >
          <Icon name="help" size={14} />
        </button>
        {helpOpen &&
          createPortal(
            <div className="skill-help-backdrop" onClick={() => setHelpOpen(false)}>
              <div
                className="skill-help-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="技能格式与校验说明"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="skill-help-close"
                  onClick={() => setHelpOpen(false)}
                >
                  关闭
                </button>
                <SkillHelpPopover />
              </div>
            </div>,
            document.body
          )}
      </legend>
      <p className="contract-settings-hint">
        绑定技能后自动执行、检查并输出，无需再次确认。支持内容技能和参考资源读取。
      </p>
      <input
        ref={dirInput}
        type="file"
        multiple
        aria-label="上传技能目录"
        hidden
        onChange={(event) => {
          const files = event.target.files
          event.target.value = ''
          if (files && files.length > 0) void install(files)
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".md,.json"
        aria-label="上传技能文件"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void install([file])
        }}
      />
      <button
        type="button"
        className="btn-ghost"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? '安装中…' : '上传技能文件（.md / .json）'}
      </button>
      <button
        type="button"
        className="btn-ghost"
        disabled={busy}
        onClick={() => dirInput.current?.click()}
      >
        上传技能目录
      </button>
      {entries.map((skill) => {
        const checked = selected.some(
          (item) => item.id === skill.id && item.version === skill.version
        )
        const supported = skill.requiredTools.every((required) =>
          SKILL_AGENT_TOOLS.some(
            (tool) => tool.id === required.id && tool.version === required.version
          )
        )
        return (
          <label key={`${skill.id}@${skill.version}`} className="settings-row">
            <input
              type="checkbox"
              checked={checked}
              disabled={
                !checked &&
                (!supported ||
                  busy ||
                  (selected.length >= 8 && !selected.some((item) => item.id === skill.id)))
              }
              onChange={(event) => {
                setError('')
                save({
                  maxSteps,
                  skills: event.target.checked
                    ? [...selected.filter((item) => item.id !== skill.id), skill]
                    : selected.filter((item) => item.id !== skill.id)
                })
              }}
            />
            <span title={skill.description}>
              {skill.name} · {skill.version}
              {BUILTIN_SKILL_IDS.has(skill.id) && <span className="skill-builtin-badge">内置</span>}
              {!supported ? '（缺少必需工具）' : ''}
            </span>
          </label>
        )
      })}
      {!entries.length && (
        <p className="contract-settings-hint">
          上传 SKILL.md、JSON 技能包或包含 SKILL.md 的技能目录（至多 16 个 .md
          参考），然后勾选启用。
        </p>
      )}
      <label className="settings-row">
        最多执行步数
        <NumberStepper
          ariaLabel="最多执行步数"
          min={1}
          max={12}
          step={1}
          value={String(maxSteps)}
          onChange={(next) => {
            const parsed = Number(next)
            // 空串沿用原来的默认上限 6，不把清空折算成 1。
            const steps = next.trim() ? parsed : 6
            if (!Number.isFinite(steps)) return
            save({ skills: selected, maxSteps: Math.min(12, Math.max(1, steps)) })
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  )
}
