import React, { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { getEventBreakdown, getEventNames } from '../api'

const styles = {
  container: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  header: {
    display: 'flex',
    gap: '12px',
    marginBottom: '20px',
    flexWrap: 'wrap',
    alignItems: 'center'
  },
  select: {
    background: '#2f3336',
    border: '1px solid #3f4347',
    color: '#e7e9ea',
    padding: '8px 12px',
    borderRadius: '6px',
    fontSize: '14px',
    minWidth: '200px'
  },
  propertyTabs: {
    display: 'flex',
    gap: '8px',
    marginBottom: '16px',
    flexWrap: 'wrap'
  },
  propertyTab: {
    background: '#2f3336',
    border: 'none',
    color: '#e7e9ea',
    padding: '6px 12px',
    borderRadius: '16px',
    cursor: 'pointer',
    fontSize: '13px'
  },
  propertyTabActive: {
    background: '#1d9bf0',
    color: '#fff'
  },
  chartContainer: {
    marginTop: '16px'
  },
  totalCount: {
    color: '#71767b',
    fontSize: '14px',
    marginBottom: '16px'
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
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    marginTop: '16px'
  },
  th: {
    textAlign: 'left',
    padding: '10px 8px',
    borderBottom: '1px solid #2f3336',
    color: '#71767b',
    fontSize: '13px'
  },
  td: {
    padding: '10px 8px',
    borderBottom: '1px solid #2f3336',
    color: '#e7e9ea',
    fontSize: '14px'
  },
  valueCell: {
    fontFamily: 'monospace',
    background: '#2f3336',
    padding: '4px 8px',
    borderRadius: '4px',
    fontSize: '13px'
  },
  countBar: {
    height: '20px',
    background: '#1d9bf0',
    borderRadius: '4px',
    minWidth: '4px'
  }
}

const COLORS = ['#1d9bf0', '#00ba7c', '#f91880', '#ffd400', '#7856ff', '#ff7a00', '#00d4ff', '#17bf63']

function EventBreakdown() {
  const [eventNames, setEventNames] = useState([])
  const [selectedEvent, setSelectedEvent] = useState('')
  const [selectedProperty, setSelectedProperty] = useState(null)
  const [breakdown, setBreakdown] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Fetch event names on mount
  useEffect(() => {
    const fetchNames = async () => {
      try {
        const data = await getEventNames()
        setEventNames(data.event_names || [])
        if (data.event_names?.length > 0) {
          setSelectedEvent(data.event_names[0])
        }
      } catch (err) {
        console.error('Failed to fetch event names:', err)
      }
    }
    fetchNames()
  }, [])

  // Fetch breakdown when event changes
  useEffect(() => {
    if (!selectedEvent) return

    const fetchBreakdown = async () => {
      setLoading(true)
      setError(null)
      try {
        console.log('Fetching breakdown for event:', selectedEvent)
        const data = await getEventBreakdown(selectedEvent)
        console.log('Breakdown data:', data)
        setBreakdown(data)
        // Auto-select first property
        if (data.properties?.length > 0 && !selectedProperty) {
          setSelectedProperty(data.properties[0])
        }
      } catch (err) {
        console.error('Failed to fetch breakdown:', err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    fetchBreakdown()
  }, [selectedEvent])

  const handleEventChange = (e) => {
    setSelectedEvent(e.target.value)
    setSelectedProperty(null)
    setBreakdown(null)
  }

  const currentBreakdown = breakdown?.breakdowns?.[selectedProperty] || []
  const maxCount = currentBreakdown.length > 0 ? currentBreakdown[0].count : 1

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <select
          style={styles.select}
          value={selectedEvent}
          onChange={handleEventChange}
        >
          <option value="">Select an event</option>
          {eventNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {breakdown && (
          <span style={styles.totalCount}>
            Total: {breakdown.total_count} events
          </span>
        )}
      </div>

      {error && (
        <div style={{ ...styles.noData, color: '#ff6b6b', background: '#67000d', padding: '20px', borderRadius: '8px' }}>
          Error loading breakdown: {error}
        </div>
      )}

      {loading ? (
        <div style={styles.loading}>Loading breakdown...</div>
      ) : !breakdown || breakdown.total_count === 0 ? (
        <div style={styles.noData}>
          {selectedEvent ? 'No data for this event' : 'Select an event to see breakdown'}
        </div>
      ) : (
        <>
          {breakdown.properties?.length > 0 && (
            <div style={styles.propertyTabs}>
              {breakdown.properties.map(prop => (
                <button
                  key={prop}
                  style={{
                    ...styles.propertyTab,
                    ...(selectedProperty === prop ? styles.propertyTabActive : {})
                  }}
                  onClick={() => setSelectedProperty(prop)}
                >
                  {prop}
                </button>
              ))}
            </div>
          )}

          {selectedProperty && currentBreakdown.length > 0 && (
            <>
              {/* Bar chart for visual */}
              <div style={styles.chartContainer}>
                <ResponsiveContainer width="100%" height={Math.min(currentBreakdown.length * 40 + 40, 400)}>
                  <BarChart
                    data={currentBreakdown.slice(0, 10)}
                    layout="vertical"
                    margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
                  >
                    <XAxis type="number" stroke="#71767b" />
                    <YAxis
                      type="category"
                      dataKey="value"
                      stroke="#71767b"
                      tick={{ fill: '#e7e9ea', fontSize: 12 }}
                      width={90}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#16181c',
                        border: '1px solid #2f3336',
                        borderRadius: '8px',
                        color: '#e7e9ea'
                      }}
                    />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {currentBreakdown.slice(0, 10).map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Full table */}
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Value</th>
                    <th style={{ ...styles.th, width: '100px', textAlign: 'right' }}>Count</th>
                    <th style={{ ...styles.th, width: '30%' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {currentBreakdown.map((item, index) => (
                    <tr key={index}>
                      <td style={styles.td}>
                        <span style={styles.valueCell}>{item.value}</span>
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: '600' }}>
                        {item.count}
                      </td>
                      <td style={styles.td}>
                        <div
                          style={{
                            ...styles.countBar,
                            width: `${(item.count / maxCount) * 100}%`,
                            background: COLORS[index % COLORS.length]
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}

export default EventBreakdown
