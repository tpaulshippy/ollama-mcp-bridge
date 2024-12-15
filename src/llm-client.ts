import { type LLMConfig } from './types';
import { logger } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
  };
}

interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolResponse {
  name?: string;
  arguments?: Record<string, unknown>;
  thoughts?: string;
}

export class LLMClient {
  private config: LLMConfig;
  private currentTool: string | null = null;
  public tools: any[] = [];
  private messages: any[] = [];
  public systemPrompt: string | null = null;
  private static REQUEST_TIMEOUT = 300000; // 5 minutes

  constructor(config: LLMConfig) {
    this.config = config;
    this.systemPrompt = config.systemPrompt || null;
    this.config.baseUrl = this.config.baseUrl.replace('localhost', '127.0.0.1');
    logger.debug(`Initializing Ollama client with baseURL: ${this.config.baseUrl}`);
  }

  private getToolFormat(toolName: string) {
    return {
      type: "object",
      properties: {
        name: { type: "string", enum: [toolName] },
        arguments: {
          type: "object",
          properties: {
            ...(toolName === "search_email" && {
              query: { type: "string", description: "Search query for emails" }
            }),
            ...(toolName === "search_drive" && {
              query: { type: "string", description: "Search query for files" }
            }),
            ...(toolName === "create_folder" && {
              name: { type: "string", description: "Name of the folder" }
            }),
            ...(toolName === "send_email" && {
              to: { type: "string", description: "Email address of recipient" },
              subject: { type: "string", description: "Email subject" },
              body: { type: "string", description: "Email content" }
            }),
            ...(toolName === "upload_file" && {
              name: { type: "string", description: "Name of the file" },
              content: { type: "string", description: "File content" },
              mimeType: { type: "string", description: "MIME type of file" }
            })
          },
          required: toolName === "send_email" ? ["to", "subject", "body"] :
                   toolName === "upload_file" ? ["name", "content", "mimeType"] :
                   toolName === "create_folder" ? ["name"] :
                   ["query"]
        }
      },
      required: ["name", "arguments"]
    };
  }

  public async listTools(): Promise<void> {
    logger.info('===== Available Tools =====');
    if (this.tools.length === 0) {
      logger.info('No tools available');
      return;
    }

    for (const tool of this.tools) {
      logger.info('\nTool Details:');
      logger.info(`Name: ${tool.function.name}`);
      logger.info(`Description: ${tool.function.description}`);
      if (tool.function.parameters) {
        logger.info('Parameters:');
        logger.info(JSON.stringify(tool.function.parameters, null, 2));
      }
      logger.info('------------------------');
    }
    logger.info(`Total tools available: ${this.tools.length}`);
  }

  private async testConnection(): Promise<boolean> {
    try {
      logger.debug('Testing connection to Ollama...');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        logger.debug('Ollama connection test successful:', data);
        return true;
      } else {
        logger.error('Ollama connection test failed with status:', response.status);
        return false;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.error('Ollama connection test timed out after 5 seconds');
        } else {
          logger.error('Ollama connection test failed with error:', error.message);
        }
      }
      return false;
    }
  }

  private async forceKillOllama(): Promise<void> {
    try {
      logger.debug('Starting Ollama cleanup process...');
      
      try {
        logger.debug('Attempting to kill Ollama by process name...');
        const { stdout: killOutput } = await execAsync('taskkill /F /IM ollama.exe');
        logger.debug('Taskkill output:', killOutput);
      } catch (e) {
        logger.debug('No Ollama process found to kill');
      }
      
      try {
        logger.debug('Checking for processes on port 11434...');
        const { stdout } = await execAsync('netstat -ano | findstr ":11434"');
        const pids = stdout.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(pid => pid && /^\d+$/.test(pid));
        
        for (const pid of pids) {
          logger.debug(`Killing process with PID ${pid}...`);
          await execAsync(`taskkill /F /PID ${pid}`);
        }
      } catch (e) {
        logger.debug('No processes found on port 11434');
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
      logger.debug('Ollama cleanup process completed');
    } catch (error) {
      logger.error('Error during Ollama force kill:', error);
    }
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
    logger.debug('Force killing any existing Ollama processes...');
    await this.forceKillOllama();

    logger.debug('Starting new Ollama instance...');
    const ollamaProcess = exec('ollama serve', { windowsHide: true });
    
    ollamaProcess.stdout?.on('data', (data) => {
      logger.debug('Ollama stdout:', data.toString());
    });
    
    ollamaProcess.stderr?.on('data', (data) => {
      logger.debug('Ollama stderr:', data.toString());
    });
    
    ollamaProcess.on('error', (error) => {
      logger.error('Error starting Ollama:', error);
    });
    
    ollamaProcess.unref();

    let connected = false;
    for (let i = 0; i < 10; i++) {
      logger.debug(`Waiting for Ollama to start (attempt ${i + 1}/10)...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (await this.testConnection()) {
        logger.debug('Ollama is ready and responding');
        connected = true;
        break;
      }
    }
    
    if (!connected) {
      throw new Error('Failed to start Ollama after 10 attempts');
    }

    // Extract likely tool name from prompt
    const toolNames = ["search_email", "search_drive", "create_folder", "send_email", "upload_file"];
    this.currentTool = toolNames.find(tool => 
      prompt.toLowerCase().includes(tool.replace("_", " ")) ||
      prompt.toLowerCase().includes(tool.replace("_", ""))
    ) || null;

    logger.debug(`Preparing to send prompt: ${prompt}, detected tool: ${this.currentTool}`);
    this.messages = [];
    this.messages.push({
      role: 'user',
      content: prompt
    });

    return this.invoke([]);
  }

  async invoke(toolResults: any[] = []) {
    try {
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          // Convert MCP response to proper Ollama tool call format
          const toolOutput = result.output;
          try {
            const parsedOutput = JSON.parse(toolOutput);
            if (parsedOutput.content && Array.isArray(parsedOutput.content)) {
              // Extract text content from MCP response
              const content = parsedOutput.content
                .filter((item: any) => item.type === 'text')
                .map((item: any) => item.text)
                .join('\n');
              this.messages.push({
                role: 'tool',
                content,
                tool_call_id: result.tool_call_id
              });
            } else {
              this.messages.push({
                role: 'tool',
                content: String(toolOutput),
                tool_call_id: result.tool_call_id
              });
            }
          } catch (e) {
            // If not JSON, use as-is
            this.messages.push({
              role: 'tool',
              content: String(toolOutput),
              tool_call_id: result.tool_call_id
            });
          }
        }
      }

      const messages = this.prepareMessages();
      const payload: any = {
        model: this.config.model,
        messages,
        stream: false,
        options: {
          temperature: this.config.temperature || 0,
          num_predict: this.config.maxTokens || 1000
        }
      };

      // Add format schema if a tool is detected
      if (this.currentTool) {
        payload.format = this.getToolFormat(this.currentTool);
      }

      logger.debug('Preparing Ollama request with payload:', JSON.stringify(payload, null, 2));
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        logger.error(`Request timed out after ${LLMClient.REQUEST_TIMEOUT/1000} seconds`);
      }, LLMClient.REQUEST_TIMEOUT);

      logger.debug('Sending request to Ollama...');
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Ollama request failed:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
      }

      logger.debug('Response received from Ollama, parsing...');
      const completion = await response.json() as OllamaResponse;
      logger.debug('Parsed response:', completion);

      let isToolCall = false;
      let toolCalls: ToolCall[] = [];
      let content = completion.message.content;

      try {
        // If we got an object back (from format parameter), extract tool call
        if (typeof content === 'object') {
          const parsedContent = content as ToolResponse;
          if (parsedContent.name && parsedContent.arguments) {
            isToolCall = true;
            toolCalls = [{
              id: `call-${Date.now()}`,
              function: {
                name: parsedContent.name,
                arguments: JSON.stringify(parsedContent.arguments)
              }
            }];
            content = parsedContent.thoughts || "Using tool...";
            logger.debug('Using formatted response:', { toolCalls });
          }
        } 
        // Otherwise try to parse JSON from string
        else if (typeof content === 'string' && content.trim().startsWith('{')) {
          const parsedContent = JSON.parse(content.trim()) as ToolResponse;
          if (parsedContent.name && parsedContent.arguments) {
            isToolCall = true;
            toolCalls = [{
              id: `call-${Date.now()}`,
              function: {
                name: parsedContent.name,
                arguments: JSON.stringify(parsedContent.arguments)
              }
            }];
            content = parsedContent.thoughts || "Using tool...";
            logger.debug('Parsed JSON response:', { toolCalls });
          }
        }
      } catch (e) {
        logger.debug('Response is not a tool call:', e);
      }

      const result = {
        content: typeof content === 'string' ? content : JSON.stringify(content),
        isToolCall,
        toolCalls
      };

      if (result.isToolCall) {
        this.messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls?.map(call => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.function.name,
              arguments: call.function.arguments
            }
          }))
        });
      } else {
        this.messages.push({
          role: 'assistant',
          content: result.content
        });
      }

      return result;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.error('Request aborted due to timeout');
        throw new Error(`Request timed out after ${LLMClient.REQUEST_TIMEOUT/1000} seconds`);
      }
      logger.error('LLM invocation failed:', error);
      throw error;
    } finally {
      logger.debug('Cleaning up Ollama process...');
      await this.forceKillOllama();
    }
  }
}