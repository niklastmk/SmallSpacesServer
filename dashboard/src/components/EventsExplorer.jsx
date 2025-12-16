import React, { useState, useEffect } from 'react'
import { getEvents, getEventNames } from '../api'

const styles = {
  container: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  filters: {
    display: 'flex',
    gap: '12px',
    marginBottom: '20px',
    flexWrap: 'wrap'
  },
  select: {
    background: '#2f3336',
    border: '1px solid #3f4347',
    color: '#e7e9ea',
    padding: '8px 12px',
    borderRadius: '6px',
    fontSize: '14px',
    minWidth: '150px'
  },
  input: {
    background: '#2f3336',
    border: '1px solid #3f4347',
    color: '#e7e9ea',
    padding: '8px 12px',
    borderRadius: '6px',
    fontSize: '14px'
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
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    marginTop: '16px'
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
    fontSize: '14px',
    verticalAlign: 'top'
  },
  eventName: {
    fontFamily: 'monospace',
    background: '#2f3336',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '13px'
  },
  properties: {
    fontFamily: 'monospace',
    fontSize: '12px',
    color: '#71767b',
    maxWidth: '300px',
    wordBreak: 'break-all'
  },
  timestamp: {
    color: '#71767b',
    fontSize: '12px',
    whiteSpace: 'nowrap'
  },
  pagination: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: '20px',
    padding: '12px 0',
    borderTop: '1px solid #2f3336'
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
  }
}

function EventsExplorer() {
  const [events, setEvents] = useState([])
  const [eventNames, setEventNames] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const limit = 50

  // Filters
  const [selectedEvent, setSelectedEvent] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')

  const fetchEvents = async () => {
    try {
      setLoading(true)
      setError(null)
      console.log('Fetching events with params:', { selectedEvent, sessionFilter, limit, offset })
      const data = await getEvents({
        eventName: selectedEvent || undefined,
        sessionId: sessionFilter || undefined,
        limit,
        offset
      })
      console.log('Events fetched:', data)
      setEvents(data.events || [])
      setTotal(data.total || 0)
    } catch (err) {
      console.error('Failed to fetch events:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const fetchEventNames = async () => {
    try {
      const data = await getEventNames()
      setEventNames(data.event_names || [])
    } catch (err) {
      console.error('Failed to fetch event names:', err)
    }
  }

  useEffect(() => {
    fetchEventNames()
  }, [])

  useEffect(() => {
    fetchEvents()
  }, [offset, selectedEvent])

  const handleFilter = () => {
    setOffset(0)
    fetchEvents()
  }

  const formatDate = (dateStr) => {
    const date = new Date(dateStr)
    return date.toLocaleString()
  }

  const formatProperties = (props) => {
    if (!props || Object.keys(props).length === 0) return '-'
    return Object.entries(props)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')
  }

  return (
    <div style={styles.container}>
      <div style={styles.filters}>
        <select
          style={styles.select}
          value={selectedEvent}
          onChange={(e) => setSelectedEvent(e.target.value)}
        >
          <option value="">All Events</option>
          {eventNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <input
          style={styles.input}
          type="text"
          placeholder="Session ID"
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
        />
        <button style={styles.button} onClick={handleFilter}>
          Filter
        </button>
      </div>

      {error && (
        <div style={{ ...styles.noData, color: '#ff6b6b', background: '#67000d', padding: '20px', borderRadius: '8px' }}>
          Error loading events: {error}
        </div>
      )}

      {loading ? (
        <div style={styles.loading}>Loading events...</div>
      ) : events.length === 0 && !error ? (
        <div style={styles.noData}>No events found</div>
      ) : !error && (
        <>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Event</th>
                <th style={styles.th}>Properties</th>
                <th style={styles.th}>Session</th>
                <th style={styles.th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td style={styles.td}>
                    <span style={styles.eventName}>{event.event_name}</span>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.properties}>
                      {formatProperties(event.properties)}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.properties}>
                      {event.session_id?.substring(0, 8) || '-'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.timestamp}>
                      {formatDate(event.timestamp)}
                    </span>
                  </td>
                </tr>
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

export default EventsExplorer
