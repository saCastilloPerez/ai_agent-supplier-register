export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }
export type TextBlock = { type: 'text'; text: string }
export type ToolCallBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type Message = { role: 'user' | 'assistant'; content: string | Array<TextBlock | ToolCallBlock | ToolResultBlock> }
export type LlmResponse = { content: Array<TextBlock | ToolCallBlock>; inputTokens: number; outputTokens: number }

export interface LlmAdapter {
  provider: string
  model: string
  enviar(messages: Message[], tools: ToolSpec[], maxTokens: number, sessionId: string): Promise<LlmResponse>
}
