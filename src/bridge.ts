import { MCPClient } from './mcp-client';
import { LLMClient } from './llm-client';
import { logger } from './logger';
import { BridgeConfig, Tool } from './types';
import path from 'path';
import fs from 'fs/promises';

export interface MCPLLMBridge {
  tools: any[];
  llmClient: LLMClient;
  initialize(): Promise<boolean>;
  processMessage(message: string): Promise<string>;
  setTools(tools: any[]): Promise<void>;
  close(): Promise<void>;
}

export class MCPLLMBridge implements MCPLLMBridge {
  private config: BridgeConfig;
  private mcpClient: MCPClient;
  public llmClient: LLMClient;
  private toolNameMapping: Map<string, string> = new Map();
  public tools: any[] = [];
  private baseAllowedPath: string;

  constructor(private bridgeConfig: BridgeConfig) {
    this.config = bridgeConfig;
    this.mcpClient = new MCPClient(bridgeConfig.mcpServer);
    this.llmClient = new LLMClient(bridgeConfig.llmConfig);
    this.baseAllowedPath = bridgeConfig.mcpServer.allowedDirectory || 'C:/Users/patru/anthropicFun';
  }

  private getToolInstructions(): string {
    return `You are a helpful assistant that can create files in the ${this.baseAllowedPath} directory.
To create a file, respond with ONLY a JSON object in this format:
{
  "tool_name": "write_file",
  "tool_args": {
    "path": "filename.txt",
    "content": "file content here"
  },
  "thoughts": "Creating the requested file"
}

The path should be just the filename - I will automatically put it in the correct directory.
Do not add any other text outside the JSON.`;
  }

  async initialize(): Promise<boolean> {
    try {
      logger.info('Connecting to MCP server...');
      await this.mcpClient.connect();
      logger.info('MCP server connected. Getting available tools...');
      
      const mcpTools = await this.mcpClient.getAvailableTools();
      logger.info(`Received ${mcpTools.length} tools from MCP server`);
      
      // Filter to only include write_file tool
      const filteredTools = mcpTools.filter(tool => tool.name === 'write_file');
      logger.info(`Filtered to ${filteredTools.length} filesystem tools`);
      
      const convertedTools = this.convertMCPToolsToOpenAIFormat(filteredTools);
      this.tools = convertedTools;
      this.llmClient.tools = convertedTools;
      
      return true;
    } catch (error: any) {
      logger.error(`Bridge initialization failed: ${error?.message || String(error)}`);
      return false;
    }
  }

  private convertMCPToolsToOpenAIFormat(mcpTools: Tool[]): any[] {
    return mcpTools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: `Create a file in ${this.baseAllowedPath}`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Just the filename (e.g. test.txt)"
            },
            content: {
              type: "string",
              description: "Content to write to the file"
            }
          },
          required: ["path", "content"]
        }
      }
    }));
  }

  async processMessage(message: string): Promise<string> {
    try {
      // Override system prompt with minimal instructions
      this.llmClient.systemPrompt = this.getToolInstructions();

      logger.info('Sending message to LLM...');
      let response = await this.llmClient.invokeWithPrompt(message);
      logger.info(`LLM response received, isToolCall: ${response.isToolCall}`);

      while (response.isToolCall && response.toolCalls?.length) {
        logger.info(`Processing ${response.toolCalls.length} tool calls`);
        
        for (const call of response.toolCalls) {
          const args = JSON.parse(call.function.arguments);
          // Ensure path is relative to allowed directory
          args.path = path.join(this.baseAllowedPath, args.path);
          call.function.arguments = JSON.stringify(args);
        }
        
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
        const requestedName = toolCall.function.name;
        logger.debug(`[MCP] Looking up tool name: ${requestedName}`);

        logger.info(`[MCP] About to call MCP tool: ${requestedName}`);
        let toolArgs = JSON.parse(toolCall.function.arguments);

        logger.info(`[MCP] Tool arguments prepared: ${JSON.stringify(toolArgs)}`);
        
        // Add timeout to MCP call
        const mcpCallPromise = this.mcpClient.callTool(requestedName, toolArgs);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('MCP call timed out after 30 seconds')), 30000);
        });

        logger.info(`[MCP] Sending call to MCP...`);
        const result = await Promise.race([mcpCallPromise, timeoutPromise]);
        logger.info(`[MCP] Received response from MCP`);
        
        toolResponses.push({
          tool_call_id: toolCall.id,
          output: typeof result === 'string' ? result : JSON.stringify(result)
        });
        
      } catch (error: any) {
        logger.error(`[MCP] Tool execution failed with error:`, error);
        toolResponses.push({
          tool_call_id: toolCall.id,
          output: `Error: ${error?.message || String(error)}`
        });
      }
    }

    return toolResponses;
  }

  async setTools(tools: any[]): Promise<void> {
    // Only accept write_file tool
    this.tools = tools.filter(t => t.function.name === 'write_file');
    this.llmClient.tools = this.tools;
    logger.debug('Updated tools:', this.tools.map(t => t.function.name));
  }

  async close(): Promise<void> {
    await this.mcpClient.close();
  }
}