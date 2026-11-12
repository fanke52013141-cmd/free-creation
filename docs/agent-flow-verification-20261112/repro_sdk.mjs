// Agent Flow 主控决策根因隔离 —— 用应用同款 AI SDK 复现（脱敏版）。
//
// 证明：用与应用的 coordinate 端口完全相同的 SDK（ai + @ai-sdk/openai-compatible）、
// 相同的 glmCompatibleFetch 注入（thinking:enabled + reasoning_effort:low）、
// 相同的精确内容（exact_ctx.json）与 dispatch schema，独立运行能稳定产出合法工具调用。
// 若本脚本成功而应用主控失败 → 根因在应用运行时集成，而非端点/内容/SDK 版本。
//
// 运行前：
//   $env:CANVAS_TEST_API_KEY = '<你的智谱 API Key>'
//   node repro_sdk.mjs
// 需在仓库内运行（依赖 ../../node_modules）。会消耗少量额度。
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const KEY = process.env.CANVAS_TEST_API_KEY;
if (!KEY) { console.log('请先设置环境变量 CANVAS_TEST_API_KEY'); process.exit(1); }
const BASE = process.env.CANVAS_TEST_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = process.env.CANVAS_TEST_MODEL || 'glm-5.3';

const here = path.dirname(fileURLToPath(import.meta.url));
const nm = path.resolve(here, '../../node_modules');
const imp = (p) => import(pathToFileURL(path.join(nm, p)).href);
const { createOpenAICompatible } = await imp('@ai-sdk/openai-compatible/dist/index.js');
const { streamText, tool, stepCountIs } = await imp('ai/dist/index.js');
const { z } = await imp('zod/v4/index.js');

const ctx = JSON.parse(readFileSync(path.join(here, 'exact_ctx.json'), 'utf-8'));
const ref = ctx.available[0].inputs[0];
const keys = ['assetId', 'versionId', 'sourceNodeId', 'sourcePortId'];
const exactRef = z.object(Object.fromEntries(keys.map((k) => [k, z.enum([ref[k]])])));
const nodeIds = ctx.available.map((a) => a.nodeId);
const dispatchSchema = z.object({
  nodeId: z.enum(nodeIds), goal: z.string().min(1).max(8192), completion: z.string().min(1).max(4096),
  inputs: z.array(exactRef).min(1).max(32)
});
const system = '你是当前画布的主 Agent，仅协调已授权专业 Agent。每轮必须选择恰好一个工具。available 是目前可派发的真实节点和固定输入，completed 是真实完成记录；不能伪造完成或读取其他会话。按 goal 的要求分派，不要重复已完成任务。dispatch_agent 的 inputs 必须逐字复制所选节点的固定引用，goal 与 completion 明确且符合该节点原职责。所有任务完成后 finish_flow 仅复制已完成记录的输出引用，不再派发。';

// 复刻 src/main/gateway/glm-request.ts 的注入逻辑
const glmFetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    try {
      const b = JSON.parse(init.body);
      if (b?.model === MODEL) { b.thinking = { type: 'enabled' }; b.reasoning_effort = b.reasoning_effort ?? 'low'; init = { ...init, body: JSON.stringify(b) }; }
    } catch {}
  }
  return fetch(input, { ...init, redirect: 'manual' });
};
const provider = createOpenAICompatible({ name: 'zhipu', baseURL: BASE, apiKey: KEY, fetch: glmFetch });
const model = provider.chatModel(MODEL);

let ok = 0, fail = 0;
for (let attempt = 1; attempt <= 3; attempt++) {
  const result = streamText({
    model, maxRetries: 0, timeout: 30000, onError: () => {}, stopWhen: stepCountIs(1), toolChoice: 'required',
    tools: {
      dispatch_agent: tool({ description: '给一个就绪专业 Agent 分派独立任务。', inputSchema: dispatchSchema }),
      finish_flow: tool({ description: '所有任务完成后选择成果。', inputSchema: z.object({ outputs: z.array(exactRef).min(1).max(1) }) })
    },
    system, messages: [{ role: 'user', content: JSON.stringify(ctx) }]
  });
  let err = null;
  for await (const p of result.fullStream) if (p.type === 'error') err = p.error;
  if (err) {
    fail++;
    console.log('attempt', attempt, 'ERROR:', err?.message);
    if (err?.cause) console.log('  cause:', err.cause?.message || err.cause);
    if (err?.responseBody) console.log('  body:', String(err.responseBody).slice(0, 500));
  } else {
    ok++;
    const tc = await result.toolCalls;
    console.log('attempt', attempt, 'OK', JSON.stringify(tc)?.slice(0, 120));
  }
}
console.log(`\n结果: ${ok} 成功 / ${fail} 失败。若全部成功而应用主控失败 → 根因在应用侧集成。`);