export interface NodeIoExample {
  title: string
  input: string
  settings: string
  output: string
  explanation: string
}

export const NODE_IO_EXAMPLES: Record<string, NodeIoExample[]> = {
  storyboard: [
    {
      title: 'JSON 生成分镜表格',
      input: JSON.stringify(
        {
          titles: { scene: '画面', dialogue: '台词', duration: '时长', camera: '机位' },
          shots: [
            {
              id: 'shot-1',
              scene: '人物推门进入书房',
              dialogue: '有人吗？',
              duration: '5s',
              camera: '中景'
            }
          ]
        },
        null,
        2
      ),
      settings:
        '直接编辑 JSON，或把 JSON 节点的 out-json 接到分镜板 in-json。镜头数组可粘贴到本地 JSON 编辑框，或作为 JSON 字符串接入 in-text；in-json 使用包含 shots 的对象。',
      output:
        'out-json：完整的 { titles, shots } 对象；镜头缺少 id 时自动补齐。\nout-text：由画面、台词和时长生成的文字摘要。',
      explanation:
        'titles 是“字段键 → 列标题”的映射；shots 中每个对象是一行，字段是一列，额外字段保留。id 是内部稳定标识，不作为内容列显示。表格编辑后仍输出 JSON。下游循环需要数组：先用数据处理提取 shots，再连接循环。'
    }
  ],
  processor: [
    {
      title: '从 JSON 提取字段',
      input: '{"description":"人物推门进入书房","duration":5}',
      settings: '接入 in-value；数据类型选“任意”，处理方式选“提取字段”，字段路径填写 description。',
      output: 'out-value（文本）：人物推门进入书房',
      explanation:
        '提取字段需要 JSON 对象或数组。嵌套字段使用点号，例如 shots.0.scene。缺失路径会失败；取出对象或数组时仍输出 JSON。'
    },
    {
      title: '套入提示词模板',
      input: '人物推门进入书房',
      settings: '接入 in-value；处理方式选“字符串模板”，模板填写：电影镜头：{{value}}',
      output: 'out-value（文本）：电影镜头：人物推门进入书房',
      explanation:
        '模板模式输出文本，可以接生成图片的提示词输入。输入是对象或数组时，{{value}} 会替换为 JSON 文本。一个输入端口只接一条线。'
    }
  ],
  json: [
    {
      title: '保存或解析一份 JSON',
      input: '{"description":"人物推门进入书房","duration":5}',
      settings: '点击“粘贴 JSON”填写本地内容；也可以把含合法 JSON 的文本接入 in-text 后运行。',
      output: '{\n  "description": "人物推门进入书房",\n  "duration": 5\n}',
      explanation:
        'out-json 输出结构化 JSON，不是普通文本。没有连线才使用本地内容；有 in-json 时优先使用 JSON 输入。多条 in-json 按连线顺序汇总成数组。一份无效 JSON 会失败；它不负责按业务结构校验字段。'
    },
    {
      title: '多个对象合并为数组',
      input: '第一条 in-json：{"id":"a","scene":"书房"}\n第二条 in-json：{"id":"b","scene":"走廊"}',
      settings: '两个 JSON 节点分别接入本节点的 in-json，再运行本节点。',
      output: '[{"id":"a","scene":"书房"},{"id":"b","scene":"走廊"}]',
      explanation:
        '一条输入保留原值，多条输入合并为数组，不会自动展开嵌套数组。对象数组可以接循环的 in-list。'
    }
  ],
  structured: [
    {
      title: '把文本放入结构数据',
      input: '{"description":"{{text}}","duration":5}',
      settings:
        '节点正文填写上述 JSON 模板，结构类型选“通用 JSON”；将文本“人物推门进入书房”连接到 in-text，运行节点。',
      output: '{"description":"人物推门进入书房","duration":5}',
      explanation:
        'out-json 输出替换后的 JSON，原模板保留以便下次运行。{{text}} 引用文本；{{input[0].scene}} 引用第一条 in-context 的 scene 字段。占位符缺少对应输入会失败。选择角色设定、分镜列表或对象列表时还会校验其结构。'
    },
    {
      title: '创建可供循环使用的对象列表',
      input: '[{"id":"a","scene":"书房"},{"id":"b","scene":"走廊"}]',
      settings: '结构类型选“对象列表”，正文填写数组，运行后将 out-json 接循环 in-list。',
      output: '[{"id":"a","scene":"书房"},{"id":"b","scene":"走廊"}]',
      explanation:
        '列表中的每项必须是对象。JSON 节点侧重解析和合并，结构数据节点侧重模板替换和结构校验。'
    }
  ],
  iterate: [
    {
      title: '逐项生成提示词',
      input: '[{"id":"a","scene":"书房"},{"id":"b","scene":"走廊"}]',
      settings:
        '对象数组接 in-list。out-item 接数据处理 in-value，数据处理选“任意 / 提取字段”，路径 scene；它的 out-value 再接生成图片提示词。运行循环节点，循环体逐项执行。',
      output:
        'out-item：每轮的一个 JSON 对象，例如 {"id":"a","scene":"书房"}。\nout-items：全部处理条目的结果数组，每项含 item、status、source，以及成功时的 outputs；失败项含 error。',
      explanation:
        'out-item 用于循环体，不是运行结束后的一份静态结果。out-items 是运行后的汇总，outputs 按节点 ID 和端口 ID 保存输出。最大条数为 0 表示不限；失败策略可选择跳过、停止或重试。需要处理分镜板时，先提取 shots 数组再接入。'
    }
  ]
}
