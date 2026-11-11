import Anthropic from '@anthropic-ai/sdk'
import type { LlmAdapter, LlmResponse, Message, TextBlock, ToolCallBlock, ToolSpec } from './adapter.js'

export class OpenCodeGoAdapter implements LlmAdapter {
  readonly provider = 'opencode-go'
  private readonly client: Anthropic

  constructor(readonly model: string, private readonly system: string, apiKey: string, timeout: number, fetchImpl?: typeof fetch) {
    this.client = new Anthropic({
      apiKey: null,
      authToken: apiKey,
      baseURL: 'https://opencode.ai/inference/go/anthropic',
      timeout,
      maxRetries: 0,
      defaultHeaders: { 'User-Agent': 'registro-proveedor/1.0' },
      fetch: fetchImpl
    })
  }

  async enviar(messages: Message[], tools: ToolSpec[], maxTokens: number, sessionId: string): Promise<LlmResponse> {
    const result = await this.client.messages.create({
      model: this.model,
      system: this.system,
      max_tokens: maxTokens,
      messages: messages as Anthropic.MessageParam[],
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Tool.InputSchema }))
    }, { headers: { 'x-opencode-session': sessionId } })
    const content: Array<TextBlock | ToolCallBlock> = []
    for (const block of result.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      if (block.type === 'tool_use') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    }
    return {
      content,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens
    }
  }
}
