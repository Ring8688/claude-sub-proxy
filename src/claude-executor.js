import { query } from '@anthropic-ai/claude-agent-sdk';
import Logger from './logger.js';
import { requestToSDKParams, sdkMessageToAPIResponse, streamEventToSSE } from './format-bridge.js';

/**
 * Execute a non-streaming request via the Agent SDK.
 * Returns a Messages API compatible response object.
 */
function logSDKResult(msg) {
  Logger.debug(`SDK result: subtype=${msg.subtype}, turns=${msg.num_turns}, cost=$${msg.total_cost_usd?.toFixed(4)}`);
}

export async function executeNonStreaming(body, config = {}) {
  const { prompt, options } = requestToSDKParams(body, config);
  options.includePartialMessages = false;
  options.abortController = new AbortController();

  Logger.debug(`SDK query (non-streaming): model=${options.model}, prompt length=${prompt.length}`);

  let lastAssistantMessage = null;
  let resultMessage = null;

  const conversation = query({ prompt, options });
  try {
    for await (const msg of conversation) {
      if (msg.type === 'assistant') {
        lastAssistantMessage = msg;
      } else if (msg.type === 'result') {
        resultMessage = msg;
        logSDKResult(msg);
        if (msg.subtype !== 'success') {
          Logger.warn(`SDK query ended with: ${msg.subtype}`);
        }
      }
    }
  } catch (error) {
    Logger.error('SDK query error:', error.message);
    if (error.stderr) Logger.error('SDK stderr:', error.stderr);
    if (error.stack) Logger.debug('SDK stack:', error.stack);
    throw error;
  }

  if (!lastAssistantMessage) {
    const errorDetail = resultMessage?.subtype || 'unknown';
    throw new Error(`No response from Claude (result: ${errorDetail})`);
  }

  if (lastAssistantMessage.error) {
    throw new Error(`Claude error: ${lastAssistantMessage.error}`);
  }

  return sdkMessageToAPIResponse(lastAssistantMessage);
}

/**
 * Execute a streaming request via the Agent SDK.
 * Writes SSE events directly to the HTTP response.
 */
export async function executeStreaming(body, res, config = {}) {
  const { prompt, options } = requestToSDKParams(body, config);
  options.includePartialMessages = true;
  options.abortController = new AbortController();

  // Abort on client disconnect
  res.on('close', () => {
    if (!options.abortController.signal.aborted) {
      Logger.debug('Client disconnected, aborting SDK query');
      options.abortController.abort();
    }
  });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  Logger.debug(`SDK query (streaming): model=${options.model}, prompt length=${prompt.length}`);

  const conversation = query({ prompt, options });
  try {
    for await (const msg of conversation) {
      if (res.destroyed) break;

      if (msg.type === 'stream_event') {
        const sse = streamEventToSSE(msg);
        if (sse) {
          res.write(sse);
        }
      } else if (msg.type === 'result') {
        logSDKResult(msg);
      }
    }
  } catch (error) {
    if (options.abortController.signal.aborted) {
      Logger.debug('SDK query aborted (client disconnected)');
      return;
    }
    Logger.error('SDK streaming error:', error.message);
    // If headers already sent, write an error event
    if (res.headersSent && !res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: error.message }
      })}\n\n`);
    }
  } finally {
    if (!res.destroyed) {
      res.end();
    }
  }
}
