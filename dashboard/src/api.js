// API client for analytics dashboard

const API_BASE = '/api/analytics';

// Get admin key from localStorage or prompt
export function getAdminKey() {
  let key = localStorage.getItem('adminKey');
  if (!key) {
    key = prompt('Enter admin key:');
    if (key) {
      localStorage.setItem('adminKey', key);
    }
  }
  return key;
}

export function clearAdminKey() {
  localStorage.removeItem('adminKey');
}

// Fetch with admin key header
async function fetchWithAuth(url, options = {}) {
  const adminKey = getAdminKey();
  if (!adminKey) {
    throw new Error('Admin key required');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'x-admin-key': adminKey,
      'Content-Type': 'application/json'
    }
  });

  if (response.status === 403) {
    clearAdminKey();
    throw new Error('Invalid admin key');
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Get dashboard summary
export async function getSummary() {
  return fetchWithAuth(`${API_BASE}/summary`);
}

// Get events with filters
export async function getEvents({ eventName, sessionId, startDate, endDate, limit = 100, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (eventName) params.set('event_name', eventName);
  if (sessionId) params.set('session_id', sessionId);
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  params.set('limit', limit);
  params.set('offset', offset);

  return fetchWithAuth(`${API_BASE}/events?${params}`);
}

// Get sessions
export async function getSessions({ limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  params.set('limit', limit);
  params.set('offset', offset);

  return fetchWithAuth(`${API_BASE}/sessions?${params}`);
}

// Get unique event names
export async function getEventNames() {
  return fetchWithAuth(`${API_BASE}/event-names`);
}

// Clear all analytics data
export async function clearAnalytics() {
  return fetchWithAuth(`${API_BASE}/clear`, { method: 'DELETE' });
}

// Get event breakdown by property values
export async function getEventBreakdown(eventName, propertyName = null) {
  const params = new URLSearchParams();
  params.set('event_name', eventName);
  if (propertyName) params.set('property', propertyName);

  return fetchWithAuth(`${API_BASE}/event-breakdown?${params}`);
}

// ============================================
// CRASH REPORTS API
// ============================================

// Get all crash reports
export async function getCrashes() {
  return fetchWithAuth('/api/crashes');
}

// Delete a crash report
export async function deleteCrash(crashId) {
  return fetchWithAuth(`/api/crashes/${crashId}`, { method: 'DELETE' });
}

// Get crash download URL (returns the URL, doesn't download directly)
export function getCrashDownloadUrl(crashId) {
  return `/api/crashes/${crashId}/download`;
}
