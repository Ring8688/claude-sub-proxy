import Logger from './logger.js';

/**
 * Extract text from a message content field.
 * Content can be a string or an array of content blocks.
 */
export function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return String(content);
}

/**
 * Convert Messages API request body to Agent SDK query() parameters.
 *
 * Input:  { model, max_tokens, messages, system, stream, thinking, ... }
 * Output: { prompt: string, options: SDKOptions }
 */
export function requestToSDKParams(body, config = {}) {
  const messages = body.messages || [];
  if (messages.length === 0) {
    throw new Error('messages array is required and must not be empty');
  }

  // --- Build prompt from messages ---
  const lastMessage = messages[messages.length - 1];

  let prompt;
  if (messages.length === 1) {
    prompt = extractTextContent(lastMessage.content);
  } else {
    // Multi-turn: format prior messages as context, last message as prompt
    const history = messages.slice(0, -1).map(msg => {
      const role = msg.role === 'user' ? 'Human' : 'Assistant';
      return `${role}: ${extractTextContent(msg.content)}`;
    }).join('\n\n');

    prompt = `<conversation_history>\n${history}\n</conversation_history>\n\n${extractTextContent(lastMessage.content)}`;
  }

  // --- Build system prompt ---
  let systemPrompt;
  if (body.system) {
    if (typeof body.system === 'string') {
      systemPrompt = body.system;
    } else if (Array.isArray(body.system)) {
      systemPrompt = body.system
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
  }

  // --- SDK options ---
  const options = {
    model: body.model || config.model_default || 'claude-sonnet-4-6',
    tools: [],                    // No built-in tools
    maxTurns: 1,                  // Single turn
    includePartialMessages: !!body.stream,
    persistSession: false,        // Ephemeral — don't write session files
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };

  // System prompt: custom string overrides Claude Code default
  if (systemPrompt) {
    options.systemPrompt = systemPrompt;
  }
  // else: SDK uses its default Claude Code system prompt

  // Config-level system prompt (request-level takes priority)
  if (!systemPrompt && config.system_prompt) {
    options.systemPrompt = config.system_prompt;
  }

  // Tools toggle — when enabled, remove empty tools array to let SDK use defaults
  if (config.tools_enabled === 'true') {
    delete options.tools;
  }

  // Thinking / budget tokens (request-level takes priority)
  if (body.thinking?.type === 'enabled' && body.thinking.budget_tokens) {
    options.maxThinkingTokens = body.thinking.budget_tokens;
  } else if (config.max_thinking_tokens) {
    options.maxThinkingTokens = parseInt(config.max_thinking_tokens);
  }

  return { prompt, options };
}

/**
 * Extract the BetaMessage from an SDKAssistantMessage.
 * The message field is already in Messages API response format.
 */
export function sdkMessageToAPIResponse(sdkMsg) {
  const msg = sdkMsg.message;
  if (!msg) return null;

  return {
    id: msg.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: msg.content || [],
    model: msg.model || '',
    stop_reason: msg.stop_reason || null,
    stop_sequence: msg.stop_sequence || null,
    usage: msg.usage || { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Convert an SDK stream_event to an SSE line.
 * event.event is a BetaRawMessageStreamEvent — same as Anthropic SSE format.
 */
export function streamEventToSSE(sdkMsg) {
  const event = sdkMsg.event;
  if (!event) return null;
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
