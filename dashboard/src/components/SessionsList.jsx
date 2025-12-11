import React, { useState, useEffect } from 'react'
import { getSessions, getEvents } from '../api'

const styles = {
  container: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse'
  },
  th: {
    textAlign: 'left',
    padding: '12px 8px',
    borderBottom: '1px solid #2f3336',
    color: '#71767b',
    fontSize: '13px',
    fontWeight: '500'
  },
  td: {
    padding: '12px 8px',
    borderBottom: '1px solid #2f3336',
    color: '#e7e9ea',
    fontSize: '14px'
  },
  sessionId: {
    fontFamily: 'monospace',
    background: '#2f3336',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '13px'
  },
  badge: {
    display: 'inline-block',
    padding: '4px 8px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: '500'
  },
  badgeActive: {
    background: '#1d4ed8',
    color: '#93c5fd'
  },
  badgeEnded: {
    background: '#374151',
    color: '#9ca3af'
  },
  pagination: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '20px',
    padding: '12px 0',
    borderTop: '1px solid #2f3336'
  },
  button: {
    background: '#1d9bf0',
    border: 'none',
    color: '#fff',
    padding: '8px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  noData: {
    textAlign: 'center',
    padding: '40px',
    color: '#71767b'
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    color: '#71767b'
  },
  expandedRow: {
    background: '#1a1d21',
    padding: '16px',
    borderBottom: '1px solid #2f3336'
  },
  expandBtn: {
    background: 'transparent',
    border: 'none',
    color: '#1d9bf0',
    cursor: 'pointer',
    fontSize: '12px',
    padding: '4px 8px'
  }
}

function SessionsList() {
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [expandedSession, setExpandedSession] = useState(null)
  const [sessionEvents, setSessionEvents] = useState([])
  const limit = 25

  const fetchSessions = async () => {
    try {
      setLoading(true)
      const data = await getSessions({ limit, offset })
      setSessions(data.sessions)
      setTotal(data.total)
    } catch (err) {
      console.error('Failed to fetch sessions:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSessions()
  }, [offset])

  const formatDate = (dateStr) => {
    if (!dateStr) return '-'
    const date = new Date(dateStr)
    return date.toLocaleString()
  }

  const calculateDuration = (start, end) => {
    if (!start) return '-'
    const startDate = new Date(start)
    const endDate = end ? new Date(end) : new Date()
    const diffMs = endDate - startDate
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)

    if (diffHours > 0) {
      return `${diffHours}h ${diffMins % 60}m`
    }
    return `${diffMins}m`
  }

  const toggleExpand = async (sessionId) => {
    if (expandedSession === sessionId) {
      setExpandedSession(null)
      setSessionEvents([])
      return
    }

    setExpandedSession(sessionId)
    try {
      const data = await getEvents({ sessionId, limit: 20 })
      setSessionEvents(data.events)
    } catch (err) {
      console.error('Failed to fetch session events:', err)
    }
  }

  if (loading && sessions.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading sessions...</div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {sessions.length === 0 ? (
        <div style={styles.noData}>No sessions recorded yet</div>
      ) : (
        <>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}></th>
                <th style={styles.th}>Session ID</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Platform</th>
                <th style={styles.th}>Duration</th>
                <th style={styles.th}>Events</th>
                <th style={styles.th}>Started</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <React.Fragment key={session.id}>
                  <tr>
                    <td style={styles.td}>
                      <button
                        style={styles.expandBtn}
                        onClick={() => toggleExpand(session.id)}
                      >
                        {expandedSession === session.id ? '▼' : '▶'}
                      </button>
                    </td>
                    <td style={styles.td}>
                      <span style={styles.sessionId}>
                        {session.id.substring(0, 12)}...
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.badge,
                          ...(session.end_time ? styles.badgeEnded : styles.badgeActive)
                        }}
                      >
                        {session.end_time ? 'Ended' : 'Active'}
                      </span>
                    </td>
                    <td style={styles.td}>{session.platform}</td>
                    <td style={styles.td}>
                      {calculateDuration(session.start_time, session.end_time)}
                    </td>
                    <td style={styles.td}>{session.event_count || 0}</td>
                    <td style={styles.td}>
                      <span style={{ color: '#71767b', fontSize: '12px' }}>
                        {formatDate(session.start_time)}
                      </span>
                    </td>
                  </tr>
                  {expandedSession === session.id && (
                    <tr>
                      <td colSpan="7" style={{ padding: 0 }}>
                        <div style={styles.expandedRow}>
                          <strong style={{ color: '#71767b', fontSize: '12px' }}>
                            Recent Events:
                          </strong>
                          {sessionEvents.length === 0 ? (
                            <p style={{ color: '#71767b', margin: '8px 0' }}>
                              No events for this session
                            </p>
                          ) : (
                            <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
                              {sessionEvents.slice(0, 10).map((event) => (
                                <li
                                  key={event.id}
                                  style={{ color: '#9ca3af', fontSize: '13px', marginBottom: '4px' }}
                                >
                                  <span style={styles.sessionId}>{event.event_name}</span>
                                  {' '}
                                  <span style={{ color: '#71767b' }}>
                                    {formatDate(event.timestamp)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>

          <div style={styles.pagination}>
            <span style={{ color: '#71767b', fontSize: '14px' }}>
              Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                style={{ ...styles.button, opacity: offset === 0 ? 0.5 : 1 }}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Previous
              </button>
              <button
                style={{ ...styles.button, opacity: offset + limit >= total ? 0.5 : 1 }}
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default SessionsList
