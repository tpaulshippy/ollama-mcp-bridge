import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { ServerParameters } from './types';
import { logger } from './logger';

export class MCPClient {
  private process: ChildProcess | null = null;
  private stdin: Writable | null = null;
  private stdout: Readable | null = null;
  private initialized: boolean = false;
  private messageQueue: Array<{ resolve: Function; reject: Function; message: any }> = [];
  private nextMessageId: number = 1;
  private serverCapabilities?: any;
  private serverVersion?: any;

  constructor(private serverParams: ServerParameters) {}

  async connect(): Promise<void> {
    logger.debug("Connecting to MCP server...");
    
    try {
      const spawnOptions: any = {
        stdio: ['pipe', 'pipe', 'pipe']
      };

      if (this.serverParams.allowedDirectory) {
        spawnOptions.cwd = this.serverParams.allowedDirectory;
      }

      if (this.serverParams.env) {
        spawnOptions.env = {
          ...process.env,
          ...this.serverParams.env
        };
      }

      logger.debug(`Spawning MCP process: ${this.serverParams.command} ${this.serverParams.args?.join(' ')}`);
      logger.debug(`Spawn options: ${JSON.stringify(spawnOptions)}`);

      this.process = spawn(
        this.serverParams.command,
        this.serverParams.args || [],
        spawnOptions
      );

      this.stdin = this.process.stdin;
      this.stdout = this.process.stdout;

      if (this.process.stderr) {
        this.process.stderr.on('data', (data: Buffer) => {
          logger.error(`MCP stderr: ${data.toString()}`);
        });
      }

      this.process.on('error', (error: Error) => {
        logger.error(`MCP process error: ${error.message}`);
      });

      this.process.on('exit', (code: number | null) => {
        logger.info(`MCP process exited with code ${code}`);
      });

      if (this.stdout) {
        this.stdout.on('data', (data: Buffer) => this.handleResponse(data));
      }

      await this.initialize();
      logger.debug("Connected to MCP server successfully");
    } catch (error: any) {
      logger.error(`Failed to connect to MCP server: ${error?.message || String(error)}`);
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    if (!this.stdin || !this.stdout) {
      throw new Error("MCP connection not established");
    }

    logger.debug("Initializing MCP session...");

    const clientCapabilities = {
      tools: {
        call: true,
        list: true
      }
    };

    const clientInfo = {
      name: "MCPLLMBridge",
      version: "1.0.0"
    };
    
    const initMessage = {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "0.1.0",
        capabilities: clientCapabilities,
        clientInfo: clientInfo
      },
      id: this.nextMessageId++
    };

    try {
      const response = await this.sendMessage(initMessage);
      
      if (!response || typeof response.protocolVersion !== 'string') {
        throw new Error('Invalid initialization response from server');
      }

      this.serverCapabilities = response.capabilities;
      this.serverVersion = response.serverInfo;
      this.initialized = true;

      await this.sendMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      logger.debug("MCP session initialized successfully");
      logger.debug(`Server version: ${JSON.stringify(this.serverVersion)}`);
      logger.debug(`Server capabilities: ${JSON.stringify(this.serverCapabilities)}`);
    } catch (error: any) {
      logger.error(`Failed to initialize MCP session: ${error?.message || String(error)}`);
      throw error;
    }
  }

  private handleResponse(data: Buffer) {
    const messages = data.toString().split('\n').filter(line => line.trim());
    
    for (const message of messages) {
      try {
        const response = JSON.parse(message);
        logger.debug(`Received MCP response: ${JSON.stringify(response)}`);
        
        const pendingMessage = this.messageQueue.find(m => m.message.id === response.id);
        if (pendingMessage) {
          if (response.error) {
            pendingMessage.reject(new Error(response.error.message));
          } else {
            pendingMessage.resolve(response.result);
          }
          this.messageQueue = this.messageQueue.filter(m => m.message.id !== response.id);
        }
      } catch (error: any) {
        logger.error(`Failed to parse MCP response: ${error?.message || String(error)}`);
      }
    }
  }

  private async sendMessage(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.stdin || !this.stdout) {
        reject(new Error("MCP connection not established"));
        return;
      }

      // Only add to message queue if it's a request (has an id)
      if (message.id !== undefined) {
        this.messageQueue.push({ resolve, reject, message });
      }
      
      const messageStr = JSON.stringify(message) + '\n';
      logger.debug(`Sending MCP message: ${messageStr.trim()}`);
      
      this.stdin.write(messageStr, (error) => {
        if (error) {
          logger.error(`Failed to send message to MCP: ${error.message}`);
          reject(error);
          return;
        }
        
        // If it's a notification (no id), resolve immediately
        if (message.id === undefined) {
          resolve(undefined);
        }
      });
    });
  }

  async getAvailableTools(): Promise<any[]> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized");
    }

    logger.debug("Requesting available tools from MCP server");
    
    try {
      const message = {
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: this.nextMessageId++
      };

      const response = await this.sendMessage(message);
      logger.debug(`Received tools from MCP server: ${JSON.stringify(response)}`);
      return response.tools || [];
    } catch (error: any) {
      logger.error(`Failed to get available tools: ${error?.message || String(error)}`);
      throw error;
    }
  }

  async callTool(toolName: string, toolArgs: any): Promise<any> {
    if (!this.initialized) {
      throw new Error("MCP client not initialized");
    }

    logger.debug(`Calling MCP tool '${toolName}' with arguments: ${JSON.stringify(toolArgs)}`);
    
    try {
      const message = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArgs
        },
        id: this.nextMessageId++
      };

      const response = await this.sendMessage(message);
      logger.debug(`Tool result: ${JSON.stringify(response)}`);
      return response;
    } catch (error: any) {
      logger.error(`Failed to call tool ${toolName}: ${error?.message || String(error)}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    logger.debug("Closing MCP connection...");
    
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    
    this.stdin = null;
    this.stdout = null;
    this.initialized = false;
    
    logger.debug("MCP connection closed");
  }
}