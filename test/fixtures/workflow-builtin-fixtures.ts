// Retired preset graphs kept only as contract fixtures for legacy workflows.
import type { IconName } from '@renderer/components/Icon'

// 历史契约样例；产品界面不再显示预置推荐模板。
export const BUILTIN_TEMPLATES: {
  name: string
  icon: IconName
  desc: string
  nodes: { type: string; title?: string; text?: string; config?: string; dx: number; dy: number }[]
  edges: { from: number; to: number; fromPort: string; toPort: string }[]
}[] = [
  {
    name: '文本→图片生成',
    icon: 'text',
    desc: '文本节点驱动图片生成',
    nodes: [
      { type: 'text', dx: -190, dy: 0 },
      { type: 'image-gen', dx: 190, dy: 0 }
    ],
    edges: [{ from: 0, to: 1, fromPort: 'out-text', toPort: 'in-text' }]
  },
  {
    name: '文本→AI→JSON→分镜',
    icon: 'script',
    desc: '用普通节点组合结构化分镜流程',
    nodes: [
      { type: 'text', dx: -570, dy: 0 },
      { type: 'chat', dx: -190, dy: 0 },
      { type: 'json', dx: 190, dy: 0 },
      { type: 'storyboard', dx: 570, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-text', toPort: 'in-text' },
      { from: 1, to: 2, fromPort: 'out-markdown', toPort: 'in-text' },
      { from: 2, to: 3, fromPort: 'out-json', toPort: 'in-json' }
    ]
  },
  {
    name: '文本→处理→代码',
    icon: 'processor',
    desc: '把上游变量显式映射后交给代码处理',
    nodes: [
      { type: 'text', dx: -380, dy: 0 },
      { type: 'processor', dx: 0, dy: 0 },
      { type: 'code', dx: 380, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-text', toPort: 'in-value' },
      { from: 1, to: 2, fromPort: 'out-value', toPort: 'in-text' }
    ]
  },
  {
    name: '角色→场景→分镜',
    icon: 'json',
    desc: '用可校验结构数据组装一条镜头，并交给分镜板继续编辑',
    nodes: [
      {
        type: 'structured',
        title: '角色设定',
        dx: -800,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'character.profile', version: 1 } }),
        text: JSON.stringify({
          id: 'character-1',
          name: '主角',
          description: '雨夜里坚持追寻真相的人',
          appearance: '深色风衣，短发'
        })
      },
      {
        type: 'structured',
        title: '场景设定',
        dx: -400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'scene.definition', version: 1 } }),
        text: JSON.stringify({
          id: 'scene-1',
          name: '霓虹雨巷',
          description: '{{input[0].name}} 穿行在雨夜的霓虹街头',
          timeOfDay: '夜晚'
        })
      },
      {
        type: 'structured',
        title: '镜头定义',
        dx: 0,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'shot.definition', version: 1 } }),
        text: JSON.stringify({
          id: 'shot-1',
          scene: '{{input[0].description}}',
          dialogue: '',
          sound: '雨声与远处车流',
          camera: '中近景跟拍',
          duration: '5s'
        })
      },
      {
        type: 'structured',
        title: '分镜结构',
        dx: 400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'storyboard.shots', version: 1 } }),
        text: JSON.stringify({ shots: ['{{input[0]}}'] })
      },
      { type: 'storyboard', title: '分镜板', dx: 800, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-json', toPort: 'in-context' },
      { from: 1, to: 2, fromPort: 'out-json', toPort: 'in-context' },
      { from: 2, to: 3, fromPort: 'out-json', toPort: 'in-context' },
      { from: 3, to: 4, fromPort: 'out-json', toPort: 'in-json' }
    ]
  },
  {
    name: '分镜→3D预演',
    icon: 'director',
    desc: '分镜数据直接交给 3D 预演台进行镜头预演与手动发布',
    nodes: [
      {
        type: 'structured',
        title: '分镜结构',
        dx: -400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'storyboard.shots', version: 1 } }),
        text: JSON.stringify({
          shots: [
            {
              id: 'shot-1',
              scene: '雨夜街头，人物在霓虹灯下回头',
              dialogue: '',
              sound: '细雨与车流',
              duration: '5s'
            }
          ]
        })
      },
      { type: 'storyboard', title: '分镜板', dx: 0, dy: 0 },
      { type: 'director', title: '3D 预演台', dx: 400, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-json', toPort: 'in-json' },
      { from: 1, to: 2, fromPort: 'out-json', toPort: 'in-storyboard' }
    ]
  },
  {
    name: '提示词包→生图',
    icon: 'image-gen',
    desc: '以 prompt.bundle@1 明确传递提示词和风格约束',
    nodes: [
      {
        type: 'structured',
        title: '提示词包',
        dx: -200,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'prompt.bundle', version: 1 } }),
        text: JSON.stringify({
          prompt: '电影感雨夜街头，人物在霓虹灯下回头',
          style: '35mm 胶片，浅景深，低饱和青橙色调',
          aspectRatio: '16:9'
        })
      },
      { type: 'image-gen', title: '生图', dx: 200, dy: 0 }
    ],
    edges: [{ from: 0, to: 1, fromPort: 'out-json', toPort: 'in-prompt' }]
  },
  {
    name: 'P图→后续创作',
    icon: 'edit',
    desc: '导入原图后，经 P 图分别连接裁剪、生图参考图和首帧视频',
    nodes: [
      { type: 'image', title: '原图资产', dx: -760, dy: 0 },
      { type: 'image-edit', title: 'P图', dx: -380, dy: 0 },
      { type: 'image-crop', title: '图片裁剪', dx: 0, dy: -240 },
      { type: 'image-gen', title: '继续生图', dx: 0, dy: 0 },
      { type: 'video', title: '视频生成', dx: 0, dy: 240 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-image', toPort: 'in-image' },
      { from: 1, to: 2, fromPort: 'out-image', toPort: 'in-image' },
      { from: 1, to: 3, fromPort: 'out-image', toPort: 'in-images' },
      { from: 1, to: 4, fromPort: 'out-image', toPort: 'in-images' }
    ]
  },
  {
    name: '分镜→批量生图',
    icon: 'workflow',
    desc: '分镜逐项生成提示词包并串行生图；支持暂停、续跑和只重跑失败项',
    nodes: [
      {
        type: 'structured',
        title: '分镜结构',
        dx: -800,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'storyboard.shots', version: 1 } }),
        text: JSON.stringify({
          shots: [
            {
              id: 'shot-1',
              scene: '雨夜的霓虹街头，主角回头望向远处车灯',
              dialogue: '',
              sound: '细雨与车流',
              camera: '中近景跟拍',
              duration: '5s'
            },
            {
              id: 'shot-2',
              scene: '镜头拉远，主角走入潮湿的巷口',
              dialogue: '',
              sound: '脚步声与雨声',
              camera: '广角远景',
              duration: '5s'
            }
          ]
        })
      },
      {
        type: 'structured',
        title: '镜头列表',
        dx: -400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'list.items', version: 1 } }),
        text: '{{input[0].shots}}'
      },
      {
        type: 'iterate',
        title: '逐镜生图',
        dx: 0,
        dy: 0,
        config: JSON.stringify({ onFailure: 'skip', maxRetries: 0, limit: 0, runMode: 'resume' })
      },
      {
        type: 'structured',
        title: '镜头提示词',
        dx: 400,
        dy: 0,
        config: JSON.stringify({ schema: { id: 'prompt.bundle', version: 1 } }),
        text: JSON.stringify({
          prompt: '{{input[0].scene}}。镜头：{{input[0].camera}}。时长：{{input[0].duration}}。',
          style: '电影感分镜，35mm 胶片，浅景深，低饱和青橙色调',
          aspectRatio: '16:9'
        })
      },
      { type: 'image-gen', title: '批量生图', dx: 800, dy: 0 }
    ],
    edges: [
      { from: 0, to: 1, fromPort: 'out-json', toPort: 'in-context' },
      { from: 1, to: 2, fromPort: 'out-json', toPort: 'in-list' },
      { from: 2, to: 3, fromPort: 'out-item', toPort: 'in-context' },
      { from: 3, to: 4, fromPort: 'out-json', toPort: 'in-prompt' }
    ]
  }
]
