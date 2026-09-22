/**
 * 目录目前没有“是否支持思考”的独立能力字段；在补齐该字段前，只对命名明确的
 * 推理模型提交 reasoning_effort，避免普通模型因未知参数被供应商拒绝。
 */
export function isReasoningModelId(modelId: string): boolean {
  return /(?:^|[-_/])(o[1-9]|r1|reasoner|thinking)(?:$|[-_/])|deepseek-r1|qwen.*(?:thinking|qwq)|glm.*(?:thinking|reasoner)/i.test(
    modelId
  )
}
