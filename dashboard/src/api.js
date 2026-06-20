export async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export const getState = () => request('/api/state');
export const getGitState = () => request('/api/git');
export const getFile = path => request(`/api/file?path=${encodeURIComponent(path)}`);
export const startTask = payload => request('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
export const cancelTask = () => request('/api/tasks/cancel', { method: 'POST' });
export const undoRun = () => request('/api/undo', { method: 'POST' });
export const resetContext = () => request('/api/session/reset', { method: 'POST' });
export const selectProject = path => request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
export const commitChanges = (message, confirmed) => request('/api/git/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, confirmed }) });
export const pushChanges = confirmed => request('/api/git/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed }) });
