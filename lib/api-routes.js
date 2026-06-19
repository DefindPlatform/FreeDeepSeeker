function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function handleHealthRoute(req, res, url, context) {
  const {
    watermark, modelConfigs, supportedModelIds,
    sessions, accounts, accountStatus, hasAuthConfig,
    sessionTtlMs, maxMessageDepth,
  } = context;

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    sendJson(res, 200, {
      status: 'ok', service: 'FreeDeepseekAPI', watermark,
      models: supportedModelIds,
      unsupported_models: Object.keys(modelConfigs).filter(id => !modelConfigs[id].supported),
      agents: sessions.size,
      accounts: accounts.map(accountStatus),
      config_ready: hasAuthConfig(),
      session_reuse: {
        strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(sessionTtlMs / 60000),
        max_messages: maxMessageDepth, reset_all: 'POST /reset-session?agent=all',
      },
    });
    return true;
  }
  return false;
}

function handleControlRoutes(req, res, url, context) {
  const {
    watermark, modelConfigs, supportedModelIds, allModelCapabilities,
    sessionStore,
  } = context;

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: supportedModelIds.map(id => ({
        id, object: 'model', created: 1700000000, owned_by: 'deepseek-web',
        real_model: modelConfigs[id].real_model, capabilities: modelConfigs[id].capabilities,
      })),
    });
    return true;
  }

  if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
    sendJson(res, 200, { object: 'model_capabilities', watermark, data: allModelCapabilities });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/v1/sessions') {
    const agents = sessionStore.list();
    sendJson(res, 200, { agents, total: agents.length });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/reset-session') {
    const agentId = url.searchParams.get('agent') || 'default';
    const clearHistory = ['1', 'true', 'yes'].includes(String(url.searchParams.get('clear_history') || '').toLowerCase());
    const reset = sessionStore.reset(agentId, clearHistory);
    if (reset?.all) sendJson(res, 200, { status: 'all_sessions_cleared', count: reset.count });
    else if (!reset) sendJson(res, 404, { error: `No session for agent: ${agentId}` });
    else sendJson(res, 200, {
      status: 'session_reset', agent: agentId,
      history_preserved: clearHistory ? 0 : reset.historyCount,
      history: clearHistory ? '' : reset.historyPreview,
    });
    return true;
  }

  return false;
}

module.exports = { handleHealthRoute, handleControlRoutes, sendJson };
