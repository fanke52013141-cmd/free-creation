/** Remove common credential forms before diagnostic text is persisted or exported. */
export function redactDiagnosticText(
  value: unknown,
  maxLength = 500,
  privateValues: readonly string[] = []
): string {
  let text = String(value ?? '')
  for (const privateValue of privateValues) {
    if (privateValue.length >= 3) text = text.split(privateValue).join('[REDACTED_INPUT]')
  }
  return text
    .replace(/(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*[^\s,;"']+/gi, '$1=[REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]')
    .slice(0, maxLength)
}
