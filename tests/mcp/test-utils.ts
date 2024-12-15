import fetch from 'node-fetch';
import { exec, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const MODEL_NAME = 'qwen2.5-coder:7b-instruct';  // Back to 7B model
export const TEST_TIMEOUT = 300000; // 5 minutes
export const HOOK_TIMEOUT = 30000;  // 30 seconds for hooks
export const REQUEST_TIMEOUT = 180000; // 3 minutes per request

export async function killOllama() {
  try {
    console.log('Killing Ollama processes...');
    // Kill any existing Ollama processes
    await execAsync('taskkill /F /IM ollama.exe').catch(() => {});
    // Kill any processes using port 11434
    const { stdout } = await execAsync('netstat -ano | findstr ":11434"').catch(() => ({ stdout: '' }));
    const pids = stdout.split('\n')
      .map(line => line.trim().split(/\s+/).pop())
      .filter(pid => pid && /^\d+$/.test(pid));
    
    for (const pid of pids) {
      await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
    }
    
    await new Promise(resolve => setTimeout(resolve, 5000)); // Longer wait
    console.log('Ollama processes killed');
  } catch (e) {
    console.log('No Ollama processes found to kill');
  }
}

export async function startOllama(): Promise<ChildProcess> {
  console.log('Starting Ollama server...');
  const ollamaProcess = exec('ollama serve', { windowsHide: true });
  
  // Add event listeners for better process management
  ollamaProcess.on('error', (error) => {
    console.error('Error starting Ollama:', error);
  });

  ollamaProcess.stdout?.on('data', (data) => {
    console.log('Ollama stdout:', data.toString());
  });

  ollamaProcess.stderr?.on('data', (data) => {
    console.log('Ollama stderr:', data.toString());
  });

  // Wait longer for server to start
  await new Promise(resolve => setTimeout(resolve, 10000));
  console.log('Ollama server started');
  return ollamaProcess;
}

export async function makeOllamaRequest(payload: any) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    console.log('Making request to Ollama with payload:', JSON.stringify(payload, null, 2));
    const startTime = Date.now();
    
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const endTime = Date.now();
    console.log(`Request took ${endTime - startTime}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
    }

    const result = await response.json();
    console.log('Received response:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT/1000} seconds`);
      }
      throw error;
    }
    throw new Error('Unknown error occurred');
  } finally {
    clearTimeout(timeoutId);
  }
}

export function parseToolResponse(result: any) {
  try {
    const content = result.message.content.trim();
    console.log('Parsing content:', content);
    
    // Handle common formatting issues
    let jsonStr = content
      .replace(/\`\`\`json\n?/g, '')
      .replace(/\n?\`\`\`/g, '')
      .trim();

    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse response as JSON:', result.message.content);
    throw e;
  }
}

export async function cleanupProcess(process: ChildProcess | null) {
  if (process) {
    console.log('Cleaning up process...');
    try {
      process.kill();
      if (process.pid) {
        await execAsync(`taskkill /F /PID ${process.pid}`).catch(() => {});
      }
      // Also clean up any remaining port usage
      const { stdout } = await execAsync('netstat -ano | findstr ":11434"').catch(() => ({ stdout: '' }));
      const pids = stdout.split('\n')
        .map(line => line.trim().split(/\s+/).pop())
        .filter(pid => pid && /^\d+$/.test(pid));
      
      for (const pid of pids) {
        await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
      }
    } catch (e) {
      console.error('Error during process cleanup:', e);
    }
  }
}