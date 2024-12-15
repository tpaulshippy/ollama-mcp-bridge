import { MCPClient } from './mcp-client';
import { LLMClient } from './llm-client';
import { logger } from './logger';
import { BridgeConfig, Tool } from './types';

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

  constructor(private bridgeConfig: BridgeConfig) {
    this.config = bridgeConfig;
    this.mcpClient = new MCPClient(bridgeConfig.mcpServer);
    this.llmClient = new LLMClient(bridgeConfig.llmConfig);
  }

  private detectToolFromPrompt(prompt: string): string | null {
    const emailKeywords = ['email', 'send', 'mail', 'message'];
    const driveKeywords = ['drive', 'folder', 'file', 'upload'];
    const searchKeywords = ['find', 'search', 'locate', 'list'];

    prompt = prompt.toLowerCase();

    if (emailKeywords.some(keyword => prompt.includes(keyword)) && 
        prompt.includes('@')) {
      return 'send_email';
    }

    if (searchKeywords.some(keyword => prompt.includes(keyword))) {
      if (emailKeywords.some(keyword => prompt.includes(keyword))) {
        return 'search_email';
      }
      if (driveKeywords.some(keyword => prompt.includes(keyword))) {
        return 'search_drive';
      }
    }

    if (driveKeywords.some(keyword => prompt.includes(keyword))) {
      if (prompt.includes('folder') || prompt.includes('directory')) {
        return 'create_folder';
      }
      if (prompt.includes('upload') || prompt.includes('create file')) {
        return 'upload_file';
      }
      return 'search_drive';
    }

    return null;
  }

  private getToolInstructions(detectedTool: string): string {
    const baseInstructions = `You are a helpful assistant that can interact with Gmail and Google Drive.
Always respond with ONLY a JSON object in the correct format for the tool being used.
Do not add any other text outside the JSON.

`;

    const toolFormats = {
      search_email: `When searching emails, format:
{
  "name": "search_email",
  "arguments": {
    "query": "search query"
  }
}`,
      
      search_drive: `When searching Drive files, format:
{
  "name": "search_drive",
  "arguments": {
    "query": "search query"
  }
}`,
      
      create_folder: `When creating folders in Drive, format:
{
  "name": "create_folder",
  "arguments": {
    "name": "folder name"
  }
}`,
      
      send_email: `When sending emails, format:
{
  "name": "send_email",
  "arguments": {
    "to": "recipient@example.com",
    "subject": "email subject",
    "body": "email content"
  }
}`,
      
      upload_file: `When uploading files to Drive, format:
{
  "name": "upload_file",
  "arguments": {
    "name": "filename",
    "content": "file content",
    "mimeType": "text/plain"
  }
}`
    };

    return baseInstructions + toolFormats[detectedTool as keyof typeof toolFormats];
  }

  async initialize(): Promise<boolean> {
    try {
      logger.info('Connecting to MCP server...');
      await this.mcpClient.connect();
      logger.info('MCP server connected. Getting available tools...');
      
      const mcpTools = await this.mcpClient.getAvailableTools();
      logger.info(`Received ${mcpTools.length} tools from MCP server`);
      
      const convertedTools = this.convertMCPToolsToOpenAIFormat(mcpTools);
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
        description: tool.description || `Use the ${tool.name} tool`,
        parameters: {
          type: "object",
          properties: tool.inputSchema?.properties || {},
          required: tool.inputSchema?.required || []
        }
      }
    }));
  }

  async processMessage(message: string): Promise<string> {
    try {
      const detectedTool = this.detectToolFromPrompt(message);
      logger.info(`Detected tool: ${detectedTool}`);

      if (detectedTool) {
        this.llmClient.systemPrompt = this.getToolInstructions(detectedTool);
      } else {
        this.llmClient.systemPrompt = this.config.systemPrompt || null;
      }

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
    this.tools = tools;
    this.llmClient.tools = tools;
    logger.debug('Updated tools:', tools.map(t => t.function.name));
  }

  async close(): Promise<void> {
    await this.mcpClient.close();
  }
}