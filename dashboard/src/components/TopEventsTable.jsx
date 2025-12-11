import React from 'react'

const styles = {
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
  eventName: {
    fontFamily: 'monospace',
    background: '#2f3336',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '13px'
  },
  count: {
    fontWeight: '600',
    color: '#1d9bf0'
  },
  noData: {
    textAlign: 'center',
    padding: '40px',
    color: '#71767b'
  }
}

function TopEventsTable({ events }) {
  if (!events || events.length === 0) {
    return <div style={styles.noData}>No events recorded yet</div>
  }

  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Event Name</th>
          <th style={{ ...styles.th, textAlign: 'right' }}>Count</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event, index) => (
          <tr key={index}>
            <td style={styles.td}>
              <span style={styles.eventName}>{event.name}</span>
            </td>
            <td style={{ ...styles.td, textAlign: 'right' }}>
              <span style={styles.count}>{event.count.toLocaleString()}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default TopEventsTable
