export async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export const getState = () => request('/api/state');
export const getFile = path => request(`/api/file?path=${encodeURIComponent(path)}`);
export const startTask = payload => request('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
export const undoRun = () => request('/api/undo', { method: 'POST' });
