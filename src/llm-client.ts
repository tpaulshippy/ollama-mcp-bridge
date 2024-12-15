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
  tool_name?: string;
  tool_args?: Record<string, unknown>;
  thoughts?: string;
}

export class LLMClient {
  private config: LLMConfig;
  public tools: any[] = [];
  private messages: any[] = [];
  public systemPrompt: string | null = null;
  public format: any = null;
  private connectionAttempts: number = 0;
  private static MAX_RETRIES = 3;
  private static RETRY_DELAY = 2000;
  private static REQUEST_TIMEOUT = 60000; // Reduced to 60 seconds since we're doing simple operations

  constructor(config: LLMConfig) {
    this.config = config;
    this.systemPrompt = config.systemPrompt || null;
    this.config.baseUrl = this.config.baseUrl.replace('localhost', '127.0.0.1');
    logger.debug(`Initializing Ollama client with baseURL: ${this.config.baseUrl}`);
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
      
      // Kill by process name
      try {
        logger.debug('Attempting to kill Ollama by process name...');
        const { stdout: killOutput } = await execAsync('taskkill /F /IM ollama.exe');
        logger.debug('Taskkill output:', killOutput);
      } catch (e) {
        logger.debug('No Ollama process found to kill');
      }
      
      // Find and kill any process using port 11434
      try {
        logger.debug('Checking for processes on port 11434...');
        const { stdout } = await execAsync('netstat -ano | findstr ":11434"');
        const pids = stdout.split('\n')
          .map(line => line.trim().split(/\s+/).pop())
          .filter(pid => pid && /^\d+$/.test(pid));
        
        logger.debug(`Found ${pids.length} processes using port 11434:`, pids);
        
        for (const pid of pids) {
          logger.debug(`Killing process with PID ${pid}...`);
          await execAsync(`taskkill /F /PID ${pid}`);
        }
      } catch (e) {
        logger.debug('No processes found on port 11434');
      }

      // Give time for processes to close
      logger.debug('Waiting for processes to fully close...');
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
    // Force kill and wait before starting new request
    logger.debug('Force killing any existing Ollama processes...');
    await this.forceKillOllama();

    // Start fresh Ollama instance
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

    // Wait for Ollama to start
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

    logger.debug(`Preparing to send prompt: ${prompt}`);
    this.messages = []; // Reset message history
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
          this.messages.push({
            role: 'tool',
            content: String(result.output || ''),
            tool_call_id: result.tool_call_id
          });
        }
      }

      const messages = this.prepareMessages();
      const payload = {
        model: this.config.model,
        messages,
        stream: false,
        options: {
          temperature: this.config.temperature || 0.7,
          num_predict: this.config.maxTokens || 1000
        }
      };

      logger.debug('Preparing Ollama request with payload:', JSON.stringify(payload, null, 2));
      
      // Set up fetch with timeout
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
          headers: Object.fromEntries(response.headers.entries()),
          error: errorText
        });
        throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
      }

      logger.debug('Response received from Ollama, parsing...');
      const completion = await response.json() as OllamaResponse;
      logger.debug('Parsed response:', completion);

      let isToolCall = false;
      let toolCalls: ToolCall[] = [];
      let content = completion.message.content.trim();

      // Strip markdown if present
      content = content.replace(/\`\`\`json\n?/g, '').replace(/\n?\`\`\`/g, '').trim();

      try {
        if (content.startsWith('{')) {
          logger.debug('Attempting to parse response as tool call JSON');
          const parsedContent = JSON.parse(content) as ToolResponse;
          logger.debug('Successfully parsed JSON response:', parsedContent);
          
          if (parsedContent.tool_name) {
            isToolCall = true;
            toolCalls = [{
              id: `call-${Date.now()}`,
              function: {
                name: parsedContent.tool_name,
                arguments: JSON.stringify(parsedContent.tool_args || {})
              }
            }];
            content = parsedContent.thoughts || "Using tool...";
            logger.debug('Identified as tool call:', { toolCalls });
          }
        }
      } catch (e) {
        logger.debug('Response is not a tool call - parsing error:', e);
      }

      const result = {
        content,
        isToolCall,
        toolCalls
      };

      this.messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls
      });

      return result;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        logger.error('Request aborted due to timeout');
        throw new Error(`Request timed out after ${LLMClient.REQUEST_TIMEOUT/1000} seconds`);
      }
      logger.error('LLM invocation failed:', {
        error: error?.message || String(error),
        stack: error?.stack,
        cause: error?.cause
      });
      throw error;
    } finally {
      // Always try to kill Ollama after request
      logger.debug('Cleaning up Ollama process...');
      await this.forceKillOllama();
    }
  }
}