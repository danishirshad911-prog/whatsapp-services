export function buildContextPrompt({ contact, messages, memory, tags, notes, conversation, settings, knowledgeChunks }) {
  const lines = [];
  const basePrompt = settings?.system_prompt || 'You are a professional, friendly CRM assistant. Respond concisely and helpfully in the same language the customer uses. Never mention being an AI unless directly asked.';
  lines.push(`SYSTEM: ${basePrompt}`, '');

  if (knowledgeChunks?.length > 0) {
    lines.push('=== KNOWLEDGE BASE (HIGHEST PRIORITY) ===');
    lines.push('Use this information first when answering.', '');
    knowledgeChunks.forEach((chunk, i) => {
      lines.push(`[Source ${i + 1}: "${chunk.document_title}" — ${Math.round((chunk._score || 0) * 100)}% relevance]`);
      lines.push(chunk.content_chunk, '');
    });
    lines.push('');
  }

  lines.push('=== CONTACT PROFILE ===');
  lines.push(`Name: ${contact?.name || 'Unknown'}`);
  lines.push(`Phone: +${contact?.phone_number || 'N/A'}`);
  if (conversation?.assigned_agent_name) lines.push(`Assigned Agent: ${conversation.assigned_agent_name}`);
  if (tags?.length > 0) lines.push(`Tags: ${tags.map(t => t.tag_name).join(', ')}`);

  if (memory?.summary) {
    lines.push('', '=== LONG-TERM MEMORY ===', memory.summary);
    if (memory.key_facts?.length > 0) lines.push(`Key Facts: ${memory.key_facts.join(' | ')}`);
  }

  if (notes?.length > 0) {
    lines.push('', '=== AGENT NOTES ===');
    notes.slice(0, 5).forEach(n => lines.push(`[${n.agent_name || 'Agent'}]: ${n.note}`));
  }

  lines.push('', '=== RECENT CONVERSATION ===');
  if (!messages?.length) {
    lines.push('[No previous messages]');
  } else {
    messages.slice(-20).forEach(m => {
      const role = m.direction === 'inbound' ? `Customer (${contact?.name || 'Customer'})` : 'Agent/Assistant';
      const ts = m.timestamp_wa ? new Date(m.timestamp_wa).toLocaleTimeString() : '';
      lines.push(`[${ts}] ${role}: ${m.body || '[media]'}`);
    });
  }

  lines.push('', '=== TASK ===', 'Write a helpful, concise reply to the customer's latest message. Reply directly — no preamble.');
  return lines.join('\n');
}

export function buildMemorySummarizationPrompt(contact, recentMessages) {
  const msgText = recentMessages.slice(-30).map(m => `${m.direction === 'inbound' ? 'Customer' : 'Agent'}: ${m.body || '[media]'}`).join('\n');
  return `Analyze this conversation with "${contact?.name || 'Unknown'}" (+${contact?.phone_number}) and respond ONLY with valid JSON:
{"summary": "2-3 sentence summary", "key_facts": ["fact1","fact2"], "detected_intent": "lead|support|inquiry|complaint|order|other", "sentiment": "positive|neutral|negative", "is_lead": true/false}

Conversation:
${msgText}`;
}
