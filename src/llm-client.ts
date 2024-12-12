import { OpenAI } from 'openai';
import { LLMConfig } from './types';
import { logger } from './logger';

export class LLMClient {
  private config: LLMConfig;
  private client: OpenAI;
  public tools: any[] = [];
  private messages: any[] = [];
  public systemPrompt: string | null = null;

  constructor(config: LLMConfig) {
    this.config = config;
    logger.debug(`Initializing OpenAI client with baseURL: ${config.baseUrl}`);
    this.client = new OpenAI({
      apiKey: config.apiKey || 'dummy-key',
      baseURL: config.baseUrl
    });
    this.systemPrompt = config.systemPrompt || null;
  }

  private prepareMessages(): any[] {
    const formattedMessages = [];

    if (this.systemPrompt) {
      formattedMessages.push({
        role: 'system',
        content: this.systemPrompt
      });
    }

    formattedMessages.push(...this.messages);
    return formattedMessages;
  }

  async invokeWithPrompt(prompt: string) {
    logger.debug(`Preparing to send prompt to LLM: ${prompt}`);
    this.messages.push({
      role: 'user',
      content: prompt
    });

    return this.invoke([]);
  }

  async invoke(toolResults: any[] = []) {
    try {
      if (toolResults.length > 0) {
        logger.debug(`Processing ${toolResults.length} tool results`);
        for (const result of toolResults) {
          this.messages.push({
            role: 'tool',
            content: String(result.output || ''),
            tool_call_id: result.tool_call_id
          });
        }
      }

      const messages = this.prepareMessages();
      logger.debug('Prepared messages for LLM');
      logger.debug(`Available tools: ${JSON.stringify(this.tools)}`);

      try {
        logger.debug('Sending request to OpenAI...');
        const completion = await this.client.chat.completions.create({
          model: this.config.model,
          messages: messages,
          tools: this.tools.length > 0 ? this.tools : undefined,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens
        });
        logger.debug('Received response from OpenAI');

        const response = {
          content: completion.choices[0].message.content || '',
          isToolCall: completion.choices[0].finish_reason === 'tool_calls',
          toolCalls: completion.choices[0].message.tool_calls || []
        };

        this.messages.push({
          role: 'assistant',
          content: response.content,
          tool_calls: response.toolCalls
        });

        logger.debug(`LLM response processed, isToolCall: ${response.isToolCall}`);
        return response;
      } catch (openaiError: any) {
        // Log detailed error information
        logger.error('OpenAI API error:');
        logger.error(`Status: ${openaiError.status}`);
        logger.error(`Message: ${openaiError.message}`);
        logger.error(`Type: ${openaiError.type}`);
        if (openaiError.response) {
          logger.error(`Response data: ${JSON.stringify(openaiError.response.data)}`);
        }
        throw openaiError;
      }
    } catch (error: any) {
      logger.error(`LLM invocation failed: ${error?.message || String(error)}`);
      throw error;
    }
  }
}