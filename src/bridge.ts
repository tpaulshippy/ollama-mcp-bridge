import { BridgeConfig, Tool } from './types';
import { MCPClient } from './mcp-client';
import { LLMClient } from './llm-client';
import { MCPRegistry } from './mcp-registry';
import { logger } from './logger';

export class MCPLLMBridge {
  private config: BridgeConfig;
  private mcpClient: MCPClient;
  private llmClient: LLMClient;
  private registry: MCPRegistry;
  private toolNameMapping: Map<string, string> = new Map();

  constructor(config: BridgeConfig) {
    this.config = config;
    this.registry = new MCPRegistry();
    this.mcpClient = new MCPClient(config.mcpServer);
    this.llmClient = new LLMClient(config.llmConfig);
  }

  async initialize(): Promise<boolean> {
    try {
      logger.info('Connecting to MCP server...');
      await this.mcpClient.connect();
      logger.info('MCP server connected. Getting available tools...');
      
      const mcpTools = await this.mcpClient.getAvailableTools();
      logger.info(`Received ${mcpTools.length} tools from MCP server`);
      
      const convertedTools = mcpTools.map(tool => {
        const converted = this.registry.convertToolToOpenAI(tool);
        this.toolNameMapping.set(converted.function.name, tool.name);
        return converted;
      });

      logger.info('Converted MCP tools to OpenAI format');
      this.llmClient.tools = convertedTools;
      logger.info('Tools registered with LLM client');
      
      return true;
    } catch (error: any) {
      logger.error(`Bridge initialization failed: ${error?.message || String(error)}`);
      return false;
    }
  }

  async processMessage(message: string): Promise<string> {
    try {
      logger.info('Sending message to LLM...');
      let response = await this.llmClient.invokeWithPrompt(message);
      logger.info(`LLM response received, isToolCall: ${response.isToolCall}`);

      while (response.isToolCall && response.toolCalls?.length) {
        logger.info(`Processing ${response.toolCalls.length} tool calls`);
        const toolResponses = await this.handleToolCalls(response.toolCalls);
        logger.info('Tool calls completed, sending results back to LLM');
        response = await this.llmClient.invoke(toolResponses);
      }

      logger.info('Final response ready');
      return response.content;
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      logger.error(`Error processing message: ${errorMsg}`);
      return `Error processing message: ${errorMsg}`;
    }
  }

  private async handleToolCalls(toolCalls: any[]): Promise<any[]> {
    const toolResponses = [];

    for (const toolCall of toolCalls) {
      try {
        const openaiName = toolCall.function.name;
        const mcpName = this.toolNameMapping.get(openaiName);

        if (!mcpName) {
          throw new Error(`Unknown tool: ${openaiName}`);
        }

        logger.info(`Calling MCP tool: ${mcpName}`);
        let toolArgs = JSON.parse(toolCall.function.arguments);

        // Validate and add default parameters
        toolArgs = this.registry.validateToolParams(mcpName, toolArgs);
        logger.info(`Tool arguments: ${JSON.stringify(toolArgs)}`);

        const result = await this.mcpClient.callTool(mcpName, toolArgs);
        const convertedResponse = this.registry.convertResponseToOpenAI(result);
        
        toolResponses.push({
          tool_call_id: toolCall.id,
          output: convertedResponse.content
        });

        logger.info(`Tool ${mcpName} call completed`);
      } catch (error: any) {
        logger.error(`Tool execution failed: ${error?.message || String(error)}`);
        toolResponses.push({
          tool_call_id: toolCall.id,
          output: `Error: ${error?.message || String(error)}`
        });
      }
    }

    return toolResponses;
  }

  async close() {
    await this.mcpClient.close();
  }
}