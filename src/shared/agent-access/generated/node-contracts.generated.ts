// 本文件由 test/node-contracts-export.test.ts 生成，请勿手改。
// 重新生成：$env:CANVAS_NODE_CONTRACTS_WRITE=1; node scripts/run-vitest.cjs run test/node-contracts-export.test.ts
import type { NodeContractRecord } from '../node-contracts'

export const GENERATED_NODE_CONTRACTS: NodeContractRecord[] = [
  {
    "typeId": "text",
    "contractVersion": 3,
    "label": "文本",
    "description": "可编辑的原始文本。上游文本在运行时并入正文，再经 out-text 输出。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "document",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本",
          "description": "一个或多个上游文本，执行时与节点内文本合并。"
        }
      ],
      "out": [
        {
          "id": "out-text",
          "dir": "out",
          "type": "text",
          "required": true,
          "cardinality": "one",
          "name": "文本",
          "description": "节点最终保存的纯文本内容。"
        }
      ]
    }
  },
  {
    "typeId": "image",
    "contractVersion": 3,
    "label": "图片",
    "description": "图片资产节点，只负责保存和输出一张已导入的图片，不承担生成逻辑。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "document",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [],
      "out": [
        {
          "id": "out-image",
          "dir": "out",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "图片",
          "description": "已导入并落盘的图片资产引用。"
        }
      ]
    }
  },
  {
    "typeId": "image-crop",
    "contractVersion": 2,
    "label": "裁剪",
    "description": "对上游图片做矩形或透视裁剪；每次运行产出新图片，原图不变。",
    "category": "image",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-image",
          "dir": "in",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "原图",
          "description": "必须连接的一张源图片；裁剪参数按其原始比例解释。"
        }
      ],
      "out": [
        {
          "id": "out-image",
          "dir": "out",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "裁剪图",
          "description": "本地裁剪完成并落盘的新图片资产。"
        }
      ]
    }
  },
  {
    "typeId": "image-split",
    "contractVersion": 3,
    "label": "拆分",
    "description": "把一张上游图片按行列拆成多张；输出当前图与图片集合。",
    "category": "image",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-image",
          "dir": "in",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "原图",
          "description": "必须连接的一张源图片；按行列从左到右、从上到下拆分。"
        }
      ],
      "out": [
        {
          "id": "out-image",
          "dir": "out",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "当前图片",
          "description": "从图片集合中选中的一格，可直接连接图片类下游。"
        },
        {
          "id": "out-images",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "图片集合",
          "description": "所有格子对应的真实图片资产引用列表，可连接循环节点批处理。",
          "schema": "list.items@1"
        }
      ]
    }
  },
  {
    "typeId": "image-gen",
    "contractVersion": 3,
    "label": "生图",
    "description": "根据提示词和有序参考图片生成图片；所有参考图统一连入一个多值图片端口。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-images",
          "dir": "in",
          "type": "image",
          "required": false,
          "cardinality": "many",
          "name": "参考图",
          "description": "唯一的图片输入；可连接 1～4 张图片，按真实连线顺序作为图片 1～4 提交给模型。"
        },
        {
          "id": "in-prompt",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "提示词包",
          "description": "可选的 prompt.bundle@1；读取其中的 prompt 与 style。",
          "schema": "prompt.bundle@1"
        },
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "提示词",
          "description": "生成图片使用的提示文本，可由多个文本上游合并。"
        }
      ],
      "out": [
        {
          "id": "out-image",
          "dir": "out",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "图片",
          "description": "模型生成并落盘后的图片资产引用。"
        }
      ]
    }
  },
  {
    "typeId": "image-edit",
    "contractVersion": 2,
    "label": "P图",
    "description": "以一张上游图片为原图，结合标注与文字说明生成新的图片；原图保持不变。",
    "category": "image",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-image",
          "dir": "in",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "原图",
          "description": "必须连接的一张待修改图片。"
        },
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "修改说明",
          "description": "可选的文本修改说明，可由多个文本上游合并。"
        }
      ],
      "out": [
        {
          "id": "out-image",
          "dir": "out",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "修改图",
          "description": "模型修改并落盘后的新图片资产。"
        }
      ]
    }
  },
  {
    "typeId": "website",
    "contractVersion": 1,
    "label": "网址节点",
    "description": "保存网页名称与链接；点击打开，也可连接输出。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "document",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [],
      "out": [
        {
          "id": "out-website",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "网址",
          "description": "已配置的网页名称和标准化 HTTP(S) 链接。",
          "schema": "website.link@1"
        }
      ]
    }
  },
  {
    "typeId": "video",
    "contractVersion": 7,
    "label": "视频生成",
    "description": "由文本与参考素材生成视频；所有参考必须经端口连入。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": "{\"modelKey\":\"\",\"mode\":\"reference\",\"params\":{}}",
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-images",
          "dir": "in",
          "type": "image",
          "required": false,
          "cardinality": "many",
          "name": "图片",
          "description": "可选的多张图片。按连线顺序读取：第 1 张作为主图/首帧，其余作为有序参考图；全部都连接到同一个绿色端口。"
        },
        {
          "id": "in-reference-video",
          "dir": "in",
          "type": "video",
          "required": false,
          "cardinality": "many",
          "name": "运动参考",
          "description": "可选的真实参考视频。预演台白模视频可在此传入，模型是否接受由供应商实际响应决定。"
        },
        {
          "id": "in-reference-audio",
          "dir": "in",
          "type": "audio",
          "required": false,
          "cardinality": "many",
          "name": "参考音频",
          "description": "可选的参考音频；仅在当前模型支持时按真实输入提交，不能替代生成音频设置。"
        },
        {
          "id": "in-prompt",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "提示词包",
          "description": "可选的 prompt.bundle@1；读取其中的 prompt 与 style。",
          "schema": "prompt.bundle@1"
        },
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "提示词",
          "description": "描述视频内容和运动方式的提示文本。"
        }
      ],
      "out": [
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "视频",
          "description": "生成并落盘后的视频资产引用。"
        }
      ]
    }
  },
  {
    "typeId": "video-asset",
    "contractVersion": 2,
    "label": "视频素材",
    "description": "视频资产节点：导入本地视频，只负责预览、替换和向下游输出。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "document",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [],
      "out": [
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "视频",
          "description": "不可变的视频资产引用。"
        }
      ]
    }
  },
  {
    "typeId": "video-frame",
    "contractVersion": 4,
    "label": "抽帧",
    "description": "提取上游视频首帧/尾帧/指定时刻画面为新图片。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "源视频",
          "description": "必须连接的一段源视频。"
        }
      ],
      "out": [
        {
          "id": "out-image",
          "dir": "out",
          "type": "image",
          "required": true,
          "cardinality": "one",
          "name": "视频帧",
          "description": "指定时间点解码得到的新图片资产。"
        }
      ]
    }
  },
  {
    "typeId": "video-clip",
    "contractVersion": 5,
    "label": "视频截取",
    "description": "按起止毫秒截取视频，可选择画面或音频；提取音频时可在同次操作中提取人声。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "源视频",
          "description": "必须连接的一段源视频。"
        }
      ],
      "out": [
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": false,
          "cardinality": "one",
          "name": "视频片段",
          "description": "精确重编码后的 MP4 视频片段。"
        },
        {
          "id": "out-audio",
          "dir": "out",
          "type": "audio",
          "required": false,
          "cardinality": "one",
          "name": "音频片段",
          "description": "同一时间范围提取并转码的新音频资产。"
        }
      ]
    }
  },
  {
    "typeId": "video-depth",
    "contractVersion": 1,
    "label": "深度视频",
    "description": "使用本地 CUDA 推理将视频转换为灰度深度视频；源音频可选保留。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "源视频",
          "description": "需要转换的输入视频。"
        }
      ],
      "out": [
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "深度视频",
          "description": "逐帧深度估计生成的灰度视频资产。"
        }
      ]
    }
  },
  {
    "typeId": "video-clay",
    "contractVersion": 1,
    "label": "白模视频",
    "description": "以连续深度生成哑光白模视频，支持光照预设、质量选择和时间稳定处理。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": "{\"version\":2,\"maxResolution\":768,\"reliefStrength\":1.5,\"lightAzimuth\":315,\"lightElevation\":45,\"ambientLight\":0.42,\"preserveAudio\":true,\"preset\":\"soft\",\"quality\":\"standard\",\"shadowStrength\":0.35,\"temporalStability\":0.6,\"fieldOfView\":50}",
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "源视频",
          "description": "需要转换的输入视频。"
        }
      ],
      "out": [
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": true,
          "cardinality": "one",
          "name": "白模视频",
          "description": "由估计深度和可调材质光照合成的视频资产。"
        }
      ]
    }
  },
  {
    "typeId": "timeline",
    "contractVersion": 1,
    "label": "轨道线",
    "description": "把图片、视频、音频铺到多条轨道上，分割拖动后合成成片。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 880,
      "h": 291
    },
    "sizePolicy": "free",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": false,
          "cardinality": "many",
          "name": "视频素材",
          "description": "按连线顺序追加到视频轨。"
        },
        {
          "id": "in-audio",
          "dir": "in",
          "type": "audio",
          "required": false,
          "cardinality": "many",
          "name": "音频素材",
          "description": "按连线顺序追加到音频轨。"
        },
        {
          "id": "in-image",
          "dir": "in",
          "type": "image",
          "required": false,
          "cardinality": "many",
          "name": "图片素材",
          "description": "按连线顺序追加到视频轨末端。"
        }
      ],
      "out": [
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": false,
          "cardinality": "one",
          "name": "合成视频",
          "description": "按时间线合成出的成片。"
        }
      ]
    }
  },
  {
    "typeId": "audio",
    "contractVersion": 3,
    "label": "音频",
    "description": "音频资产节点：导入本地音频，只负责保存、预览和输出资产。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "document",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [],
      "out": [
        {
          "id": "out-audio",
          "dir": "out",
          "type": "audio",
          "required": true,
          "cardinality": "one",
          "name": "音频",
          "description": "已导入并落盘的音频资产引用。"
        }
      ]
    }
  },
  {
    "typeId": "sound-adjust",
    "contractVersion": 1,
    "label": "声音调整",
    "description": "按倍率或目标时长调整音频/视频速度与声量。",
    "category": "audio",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-audio",
          "dir": "in",
          "type": "audio",
          "required": false,
          "cardinality": "one",
          "name": "源音频",
          "description": "连接一段音频，与源视频二选一。"
        },
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": false,
          "cardinality": "one",
          "name": "源视频",
          "description": "连接一段视频，与源音频二选一。"
        }
      ],
      "out": [
        {
          "id": "out-audio",
          "dir": "out",
          "type": "audio",
          "required": false,
          "cardinality": "one",
          "name": "调整后音频",
          "description": "源为音频时生成的新音频资产。"
        },
        {
          "id": "out-video",
          "dir": "out",
          "type": "video",
          "required": false,
          "cardinality": "one",
          "name": "调整后视频",
          "description": "源为视频时生成的新视频资产。"
        }
      ]
    }
  },
  {
    "typeId": "file",
    "contractVersion": 2,
    "label": "文件",
    "description": "文件资产节点：导入 Excel / Word / PDF 等文档并输出。",
    "category": "input",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "document",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [],
      "out": [
        {
          "id": "out-file",
          "dir": "out",
          "type": "file",
          "required": true,
          "cardinality": "one",
          "name": "文件",
          "description": "已导入并落盘的原始文件资产引用。"
        },
        {
          "id": "out-text",
          "dir": "out",
          "type": "text",
          "required": false,
          "cardinality": "one",
          "name": "文本",
          "description": "抽取出的文档正文（文本/CSV/Word/Excel/PPT/PDF）。"
        }
      ]
    }
  },
  {
    "typeId": "speech",
    "contractVersion": 4,
    "label": "语音合成",
    "description": "按所选供应商和语音参数，把文本合成为音频。供应商相关输入输出规则见“输入输出”。",
    "category": "audio",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": true,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "朗读文本",
          "description": "节点正文与上游文本合并后朗读。MiniMax 支持语气词标签和读音纠正；读音纠正格式为“词/(拼音)(拼音)”，例如“重庆/(chong2)(qing4)”，示例已预填在节点配置中。"
        },
        {
          "id": "in-voice",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "音色档案",
          "description": "连接上游 MiniMax 音色设计或语音克隆节点的音色档案；以连线传入的 voice_id 为准。未连接时使用节点内音色 ID，留空时使用系统音色 male-qn-qingse。",
          "schema": "voice.profile@1"
        }
      ],
      "out": [
        {
          "id": "out-audio",
          "dir": "out",
          "type": "audio",
          "required": true,
          "cardinality": "one",
          "name": "语音",
          "description": "MiniMax 异步语音合成（t2a_async_v2，默认通道）；支持语气词标签、音色 ID、情绪、语速、音量和音调。"
        }
      ]
    }
  },
  {
    "typeId": "tts",
    "contractVersion": 4,
    "label": "语音克隆",
    "description": "根据参考语音登记可复用音色 ID，连接语音合成节点使用。",
    "category": "audio",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-audio",
          "dir": "in",
          "type": "audio",
          "required": false,
          "cardinality": "one",
          "name": "参考语音",
          "description": "上游参考音频；也可在节点内上传。"
        }
      ],
      "out": [
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "音色档案",
          "description": "MiniMax 复刻登记出的可复用 voice_id。",
          "schema": "voice.profile@1"
        }
      ]
    }
  },
  {
    "typeId": "voice-design",
    "contractVersion": 1,
    "label": "音色设计",
    "description": "用文字描述设计音色，产出试听音频与可复用的音色 ID。",
    "category": "audio",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "音色描述",
          "description": "音色特征描述；与节点内描述合并后提交。"
        }
      ],
      "out": [
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "音色档案",
          "description": "设计出的 voice_id 与来源，可直接连接语音合成节点的音色档案输入。",
          "schema": "voice.profile@1"
        },
        {
          "id": "out-audio",
          "dir": "out",
          "type": "audio",
          "required": true,
          "cardinality": "one",
          "name": "试听音频",
          "description": "服务端返回的 hex 试听音频解码落盘后的资产。"
        }
      ]
    }
  },
  {
    "typeId": "chat",
    "contractVersion": 1,
    "label": "AI 对话",
    "description": "与文本模型对话。上游文本会成为本轮输入，最后一条助手回复作为文本输出。",
    "category": "audio",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本",
          "description": "作为本轮用户消息或上下文注入的上游文本。"
        }
      ],
      "out": [
        {
          "id": "out-text",
          "dir": "out",
          "type": "text",
          "required": true,
          "cardinality": "one",
          "name": "最后回复（TXT）",
          "description": "当前会话最后一条 AI 回复的原始文本，不包含用户消息或思考过程。"
        },
        {
          "id": "out-markdown",
          "dir": "out",
          "type": "markdown",
          "required": true,
          "cardinality": "one",
          "name": "回复（Markdown）",
          "description": "模型最后一条回复，保留 Markdown 语义以兼容已有连线。"
        }
      ]
    }
  },
  {
    "typeId": "processor",
    "contractVersion": 1,
    "label": "数据处理",
    "description": "单值透传并保持原类型；也可从 JSON 取字段或转成文本模板。",
    "category": "data",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-value",
          "dir": "in",
          "type": "any",
          "required": false,
          "cardinality": "one",
          "name": "输入变量",
          "description": "一个文本、JSON 或媒体资产值；此端口不接收多条连线。"
        }
      ],
      "out": [
        {
          "id": "out-value",
          "dir": "out",
          "type": "any",
          "required": true,
          "cardinality": "one",
          "name": "输出变量",
          "description": "透传时保留原值类型；取字段保留其文本或 JSON 类型；模板模式输出文本。"
        }
      ]
    }
  },
  {
    "typeId": "code",
    "contractVersion": 3,
    "label": "代码",
    "description": "本地运行 JavaScript，支持具名输入和多字段输出。",
    "category": "data",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": true,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本输入",
          "description": "代码运行时 input.text 读取的合并文本。"
        },
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "many",
          "name": "数据输入",
          "description": "代码运行时 input.json 读取的结构化值列表。",
          "schema": "json.any@1"
        }
      ],
      "out": [
        {
          "id": "out-output",
          "dir": "out",
          "type": "any",
          "required": true,
          "cardinality": "one",
          "name": "output",
          "description": "代码 return 对象字段 output（any）。"
        }
      ]
    }
  },
  {
    "typeId": "json",
    "contractVersion": 1,
    "label": "JSON",
    "description": "解析并格式化通用 JSON，支持手工编辑；多条 JSON 连线会汇总成数组。",
    "category": "data",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "many",
          "name": "数据",
          "description": "优先输入：一条保留原值；多条按连线顺序汇总为 JSON 数组。",
          "schema": "json.any@1"
        },
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "one",
          "name": "文本",
          "description": "仅在没有 JSON 数据输入时解析；两类同时连接时使用 JSON 数据。"
        }
      ],
      "out": [
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "数据",
          "description": "校验并格式化后的结构化值。",
          "schema": "json.any@1"
        }
      ]
    }
  },
  {
    "typeId": "structured",
    "contractVersion": 1,
    "label": "结构数据",
    "description": "按 Schema 校验 JSON 正文，运行时可插入连线值占位符。",
    "category": "data",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": true,
    "ports": {
      "in": [
        {
          "id": "in-context",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "many",
          "name": "结构上下文",
          "description": "一个或多个已连接的结构化输入，可在正文中用 {{input[0].field}} 显式引用。",
          "schema": "json.any@1"
        },
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本上下文",
          "description": "可在正文中用 {{text}} 显式引用的上游文本。"
        }
      ],
      "out": [
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "结构数据",
          "description": "经所选 Schema 校验后的结构化数据。",
          "schema": "json.any@1"
        }
      ]
    }
  },
  {
    "typeId": "storyboard",
    "contractVersion": 1,
    "label": "分镜板",
    "description": "按镜头 JSON 字段生成可编辑表格，并输出完整分镜数据与文字摘要。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "content",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "分镜数据",
          "description": "符合分镜 Schema 的镜头列表。",
          "schema": "storyboard.shots@1"
        },
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "one",
          "name": "分镜文本",
          "description": "可解析为分镜 JSON 的兼容文本输入。"
        }
      ],
      "out": [
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "分镜数据",
          "description": "编辑后的完整分镜结构。",
          "schema": "storyboard.shots@1"
        },
        {
          "id": "out-text",
          "dir": "out",
          "type": "text",
          "required": false,
          "cardinality": "one",
          "name": "合成文本",
          "description": "由画面、台词和时长生成的可读摘要。"
        }
      ]
    }
  },
  {
    "typeId": "ai-process",
    "contractVersion": 1,
    "label": "AI 处理",
    "description": "把上游文本/JSON 交给文本模型，产出文本、Markdown 或 JSON。",
    "category": "ai",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本",
          "description": "一个或多个上游文本，作为本次转换的输入。"
        },
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "JSON 上下文",
          "description": "可选的结构化上下文，注入本次转换。",
          "schema": "json.any@1"
        }
      ],
      "out": [
        {
          "id": "out-text",
          "dir": "out",
          "type": "text",
          "required": false,
          "cardinality": "one",
          "name": "文本",
          "description": "模型返回的纯文本结果。"
        },
        {
          "id": "out-markdown",
          "dir": "out",
          "type": "markdown",
          "required": false,
          "cardinality": "one",
          "name": "Markdown",
          "description": "模型返回的 Markdown 结果。"
        },
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "JSON",
          "description": "模型返回并校验后的结构化值（按所选 Schema）。",
          "schema": "json.any@1"
        }
      ]
    }
  },
  {
    "typeId": "iterate",
    "contractVersion": 2,
    "label": "循环",
    "description": "按顺序逐项运行循环体，并汇总结果。",
    "category": "data",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-list",
          "dir": "in",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "列表",
          "description": "列表项按顺序逐个运行连接的循环体。",
          "schema": "list.items@1"
        }
      ],
      "out": [
        {
          "id": "out-item",
          "dir": "out",
          "type": "iteration",
          "required": false,
          "cardinality": "one",
          "name": "当前项",
          "description": "循环体专用的临时作用域。普通列表项进入 JSON 输入；带 kind 与资产引用字段的媒体项可进入同类型媒体输入。"
        },
        {
          "id": "out-items",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "结果列表",
          "description": "每项处理结果的结构化列表（含来源、状态、各节点产物）。",
          "schema": "list.items@1"
        }
      ]
    }
  },
  {
    "typeId": "director",
    "contractVersion": 3,
    "label": "3D 预演台",
    "description": "3D 白模预演台；发布后帧、视频与机位才成为下游输入。",
    "category": "video",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "manual-publish",
    "outputSource": "run",
    "initialConfig": null,
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-storyboard",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "分镜",
          "description": "可选的分镜列表；连线后需在 3D 预演台点「同步连线输入」才会成为镜头。",
          "schema": "storyboard.shots@1"
        },
        {
          "id": "in-reference-images",
          "dir": "in",
          "type": "image",
          "required": false,
          "cardinality": "many",
          "name": "场景参考图",
          "description": "1～3 张参考图建议用于建立白模空间；真实连线输入，不读取其他节点内部状态。"
        },
        {
          "id": "in-camera-preset",
          "dir": "in",
          "type": "camera",
          "required": false,
          "cardinality": "one",
          "name": "机位参数",
          "description": "可选的初始机位参数，仅接受 3D 预演台发布的机位通道。",
          "schema": "previs.camera@1"
        }
      ],
      "out": [
        {
          "id": "out-frame",
          "dir": "out",
          "type": "image",
          "required": false,
          "cardinality": "one",
          "name": "预演帧",
          "description": "用户发布的当前镜头静帧。"
        },
        {
          "id": "out-preview-video",
          "dir": "out",
          "type": "video",
          "required": false,
          "cardinality": "one",
          "name": "预演视频",
          "description": "用户导出的 WebM 预演视频。"
        },
        {
          "id": "out-camera",
          "dir": "out",
          "type": "camera",
          "required": false,
          "cardinality": "one",
          "name": "机位参数",
          "description": "已发布镜头的焦距、画幅、时长和机位参数；使用专用机位通道，不与工程摘要混为同类输出。",
          "schema": "previs.camera@1"
        },
        {
          "id": "out-project",
          "dir": "out",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "工程摘要",
          "description": "导演工程中可交换的镜头和机位摘要，不包含媒体二进制。",
          "schema": "previs.project@2"
        }
      ]
    }
  },
  {
    "typeId": "agent",
    "contractVersion": 1,
    "label": "Agent",
    "description": "按职责和协作方式处理任务，可绑定版本化 Skills 与工具。",
    "category": "ai",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": "{\"schemaVersion\":1,\"role\":\"specialist\",\"interactionMode\":\"collaborative\",\"skills\":[],\"tools\":[],\"allowedNodeIds\":[],\"maxSteps\":12,\"relations\":[]}",
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "many",
          "name": "结构数据",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。",
          "schema": "json.any@1"
        },
        {
          "id": "in-image",
          "dir": "in",
          "type": "image",
          "required": false,
          "cardinality": "many",
          "name": "图片",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": false,
          "cardinality": "many",
          "name": "视频",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-audio",
          "dir": "in",
          "type": "audio",
          "required": false,
          "cardinality": "many",
          "name": "音频",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-file",
          "dir": "in",
          "type": "file",
          "required": false,
          "cardinality": "many",
          "name": "文件",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        }
      ],
      "out": [
        {
          "id": "out-text",
          "dir": "out",
          "type": "text",
          "required": false,
          "cardinality": "one",
          "name": "文本",
          "description": "仅在正式执行成功后输出已验证的结果；未启用的节点不产生输出。"
        },
        {
          "id": "out-json",
          "dir": "out",
          "type": "json",
          "required": false,
          "cardinality": "one",
          "name": "结构数据",
          "description": "仅在正式执行成功后输出已验证的结果；未启用的节点不产生输出。",
          "schema": "json.any@1"
        }
      ]
    }
  },
  {
    "typeId": "state-machine",
    "contractVersion": 1,
    "label": "状态机",
    "description": "声明任务阶段与合法转换；人工提交事件、运行节点推进状态。",
    "category": "ai",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": "{\"schemaVersion\":1,\"initialState\":\"draft\",\"states\":[\"draft\",\"working\",\"reviewing\",\"completed\",\"stopped\"],\"transitions\":[],\"relations\":[]}",
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "many",
          "name": "结构数据",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。",
          "schema": "json.any@1"
        }
      ],
      "out": [
        {
          "id": "out-state",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "结构数据",
          "description": "仅在正式执行成功后输出已验证的结果；未启用的节点不产生输出。",
          "schema": "flow.state@1"
        }
      ]
    }
  },
  {
    "typeId": "ai-review",
    "contractVersion": 1,
    "label": "AI 审核",
    "description": "审核固定版本的资产，给出是/否和反馈。返工通过显式控制关系调度。",
    "category": "ai",
    "creatable": true,
    "defaultSize": {
      "w": 340,
      "h": 300
    },
    "sizePolicy": "standard",
    "executionMode": "auto",
    "outputSource": "run",
    "initialConfig": "{\"schemaVersion\":1,\"rulesVersion\":\"rules-1\",\"rejectPolicy\":\"rework\",\"maxReworks\":3,\"subjectSources\":[],\"gatedNodeIds\":[],\"relations\":[]}",
    "dynamicPorts": false,
    "ports": {
      "in": [
        {
          "id": "in-text",
          "dir": "in",
          "type": "text",
          "required": false,
          "cardinality": "many",
          "name": "文本",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-json",
          "dir": "in",
          "type": "json",
          "required": false,
          "cardinality": "many",
          "name": "结构数据",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。",
          "schema": "json.any@1"
        },
        {
          "id": "in-image",
          "dir": "in",
          "type": "image",
          "required": false,
          "cardinality": "many",
          "name": "图片",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-video",
          "dir": "in",
          "type": "video",
          "required": false,
          "cardinality": "many",
          "name": "视频",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-audio",
          "dir": "in",
          "type": "audio",
          "required": false,
          "cardinality": "many",
          "name": "音频",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        },
        {
          "id": "in-file",
          "dir": "in",
          "type": "file",
          "required": false,
          "cardinality": "many",
          "name": "文件",
          "description": "按明确来源接收已提交的资产；未适配的类型禁止自动执行。"
        }
      ],
      "out": [
        {
          "id": "out-review",
          "dir": "out",
          "type": "json",
          "required": true,
          "cardinality": "one",
          "name": "结构数据",
          "description": "仅在正式执行成功后输出已验证的结果；未启用的节点不产生输出。",
          "schema": "review.decision@1"
        },
        {
          "id": "out-feedback",
          "dir": "out",
          "type": "text",
          "required": true,
          "cardinality": "one",
          "name": "文本",
          "description": "仅在正式执行成功后输出已验证的结果；未启用的节点不产生输出。"
        }
      ]
    }
  }
]
