function createSessionStore(options = {}) {
  const maxHistoryLength = options.maxHistoryLength || 15;
  const maxHistoryChars = options.maxHistoryChars || 10000;
  const sessions = new Map();

  function createSession() {
    return { id: null, parentMessageId: null, createdAt: null, messageCount: 0, accountId: null, history: [] };
  }

  function get(agentId) {
    if (!sessions.has(agentId)) sessions.set(agentId, createSession());
    return sessions.get(agentId);
  }

  function list() {
    return [...sessions].map(([agentId, session]) => ({
      agent: agentId,
      session_id: session.id,
      message_count: session.messageCount,
      account: session.accountId,
      history_size: session.history.length,
      age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
    }));
  }

  function reset(agentId, clearHistory = false) {
    if (agentId === 'all') {
      const count = sessions.size;
      sessions.clear();
      return { all: true, count };
    }
    const session = sessions.get(agentId);
    if (!session) return null;
    const historyCount = session.history.length;
    const historyPreview = session.history.map(exchange => exchange.user.substring(0, 40)).join(' | ');
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    if (clearHistory) session.history = [];
    return { all: false, historyCount, historyPreview };
  }

  function store(agentId, prompt, assistantResponse) {
    const session = get(agentId);
    const shortPrompt = prompt.length > 500 ? `...${prompt.substring(prompt.length - 500)}` : prompt;
    session.history.push({ user: shortPrompt, assistant: assistantResponse });
    while (session.history.length > maxHistoryLength) session.history.shift();
    let chars = session.history.reduce((sum, exchange) => sum + exchange.user.length + exchange.assistant.length, 0);
    while (chars > maxHistoryChars && session.history.length > 1) {
      const removed = session.history.shift();
      chars -= removed.user.length + removed.assistant.length;
    }
  }

  return { sessions, get, list, reset, store };
}

module.exports = { createSessionStore };
