#!/usr/bin/env node
// Reads claude --output-format stream-json from stdin, prints human-readable logs to stdout.
// Exits with the code from the final "result" event (0 = success, 1 = error/cancelled).

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function summarizeInput(toolName, input) {
  if (!input || typeof input !== 'object') return '';
  const s = (str, max = 120) => String(str ?? '').slice(0, max) + (String(str ?? '').length > max ? '…' : '');
  switch (toolName) {
    case 'Bash':          return s(input.command);
    case 'Read':          return s(input.file_path);
    case 'Write':         return s(input.file_path);
    case 'Edit':          return s(input.file_path);
    case 'Glob':          return s(input.pattern);
    case 'Grep':          return s(input.pattern);
    case 'WebFetch':      return s(input.url);
    case 'WebSearch':     return s(input.query);
    case 'Agent':         return s(input.description || input.prompt);
    case 'TodoWrite':     return `(${(input.todos || []).length} items)`;
    default:              return s(JSON.stringify(input));
  }
}

function summarizeContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.slice(0, 300) + (content.length > 300 ? '…' : '');
  if (Array.isArray(content)) {
    const text = content.map(c => {
      if (typeof c === 'string') return c;
      if (c.type === 'text') return c.text;
      if (c.type === 'image') return '[image]';
      return JSON.stringify(c);
    }).join(' ');
    return text.slice(0, 300) + (text.length > 300 ? '…' : '');
  }
  return JSON.stringify(content).slice(0, 300);
}

let exitCode = 0;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Non-JSON line (e.g. startup messages) — print as-is
    console.log(line);
    return;
  }

  switch (event.type) {
    case 'assistant': {
      const contents = event.message?.content ?? [];
      for (const block of contents) {
        if (block.type === 'text' && block.text?.trim()) {
          const preview = block.text.trim().replace(/\n+/g, ' ').slice(0, 200);
          console.log(`[text]       ${preview}${block.text.length > 200 ? '…' : ''}`);
        } else if (block.type === 'tool_use') {
          const summary = summarizeInput(block.name, block.input);
          console.log(`[tool_use]   ${block.name}${summary ? ': ' + summary : ''}`);
        } else if (block.type === 'thinking' && block.thinking?.trim()) {
          const preview = block.thinking.trim().replace(/\n+/g, ' ').slice(0, 120);
          console.log(`[thinking]   ${preview}…`);
        }
      }
      break;
    }
    case 'tool_result': {
      const summary = summarizeContent(event.content);
      if (summary) {
        console.log(`[tool_result] ${summary.replace(/\n+/g, ' ')}`);
      }
      break;
    }
    case 'result': {
      if (event.subtype === 'success') {
        console.log(`[result]     success`);
        exitCode = 0;
      } else {
        console.log(`[result]     ${event.subtype ?? 'error'}${event.error ? ': ' + event.error : ''}`);
        exitCode = 1;
      }
      const usage = event.usage;
      const cost = event.total_cost_usd;
      if (usage || cost != null) {
        const parts = [];
        if (usage?.input_tokens != null) parts.push(`in: ${usage.input_tokens.toLocaleString()}`);
        if (usage?.output_tokens != null) parts.push(`out: ${usage.output_tokens.toLocaleString()}`);
        if (cost != null) parts.push(`cost: $${cost.toFixed(4)}`);
        if (parts.length) console.log(`[cost]       ${parts.join(' | ')}`);
      }
      break;
    }
    case 'system':
      // Ignore system init events
      break;
    default:
      // Unknown event type — ignore silently
      break;
  }
});

rl.on('close', () => {
  process.exit(exitCode);
});
