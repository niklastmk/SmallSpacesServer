import React, { useState, useEffect } from 'react'
import { getSummary, getEvents, getSessions, getEventNames, clearAdminKey } from './api'
import StatsCard from './components/StatsCard'
import EventsChart from './components/EventsChart'
import TopEventsTable from './components/TopEventsTable'
import EventsExplorer from './components/EventsExplorer'
import SessionsList from './components/SessionsList'
import EventBreakdown from './components/EventBreakdown'
import CrashReports from './components/CrashReports'

const styles = {
  container: {
    maxWidth: '1400px',
    margin: '0 auto',
    padding: '24px'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
    paddingBottom: '16px',
    borderBottom: '1px solid #2f3336'
  },
  title: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#e7e9ea'
  },
  subtitle: {
    fontSize: '14px',
    color: '#71767b',
    marginTop: '4px'
  },
  logoutBtn: {
    background: '#2f3336',
    border: 'none',
    color: '#e7e9ea',
    padding: '8px 16px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px'
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '16px',
    marginBottom: '32px'
  },
  section: {
    marginBottom: '32px'
  },
  sectionTitle: {
    fontSize: '18px',
    fontWeight: '600',
    marginBottom: '16px',
    color: '#e7e9ea'
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
    gap: '24px'
  },
  card: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  tabs: {
    display: 'flex',
    gap: '8px',
    marginBottom: '24px',
    borderBottom: '1px solid #2f3336',
    paddingBottom: '8px'
  },
  tab: {
    background: 'transparent',
    border: 'none',
    color: '#71767b',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500',
    borderRadius: '6px'
  },
  tabActive: {
    background: '#1d9bf0',
    color: '#fff'
  },
  error: {
    background: '#67000d',
    color: '#ff6b6b',
    padding: '16px',
    borderRadius: '8px',
    marginBottom: '16px'
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '200px',
    color: '#71767b'
  },
  sectionSwitcher: {
    display: 'flex',
    gap: '0',
    marginBottom: '20px',
  },
  sectionBtn: {
    background: 'transparent',
    border: '1px solid #2f3336',
    color: '#71767b',
    padding: '10px 24px',
    cursor: 'pointer',
    fontSize: '15px',
    fontWeight: '600',
    transition: 'all 0.15s',
  },
  sectionBtnActive: {
    background: '#e7e9ea',
    color: '#16181c',
    borderColor: '#e7e9ea',
  },
}

const ANALYTICS_TABS = ['overview', 'breakdown', 'events', 'sessions']

function App() {
  const [section, setSection] = useState('crashes')
  const [activeTab, setActiveTab] = useState('overview')
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  const fetchData = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await getSummary()
      setSummary(data)
      setLastRefresh(new Date())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (section === 'analytics') {
      fetchData()
      const interval = setInterval(fetchData, 30000)
      return () => clearInterval(interval)
    }
  }, [section])

  const handleLogout = () => {
    clearAdminKey()
    const newKey = prompt('Enter new admin key:')
    if (newKey) {
      localStorage.setItem('adminKey', newKey)
    }
    window.location.reload()
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Small Spaces Dashboard</h1>
          <p style={styles.subtitle}>
            {section === 'analytics' && lastRefresh && `Last updated: ${lastRefresh.toLocaleTimeString()}`}
          </p>
        </div>
        <button style={styles.logoutBtn} onClick={handleLogout}>
          Change Admin Key
        </button>
      </header>

      <div style={styles.sectionSwitcher}>
        <button
          style={{ ...styles.sectionBtn, borderRadius: '8px 0 0 8px', ...(section === 'crashes' ? styles.sectionBtnActive : {}) }}
          onClick={() => setSection('crashes')}>
          Crash Reports
        </button>
        <button
          style={{ ...styles.sectionBtn, borderRadius: '0 8px 8px 0', borderLeft: 'none', ...(section === 'analytics' ? styles.sectionBtnActive : {}) }}
          onClick={() => setSection('analytics')}>
          Analytics
        </button>
      </div>

      {error && section === 'analytics' && (
        <div style={styles.error}>
          Error: {error}
          <button
            onClick={fetchData}
            style={{ marginLeft: '16px', padding: '4px 12px', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {section === 'crashes' && <CrashReports />}

      {section === 'analytics' && (
        <>
          {loading && !summary ? (
            <div style={styles.loading}>Loading analytics data...</div>
          ) : (
            <>
              <div style={styles.tabs}>
                {ANALYTICS_TABS.map(tab => (
                  <button
                    key={tab}
                    style={{
                      ...styles.tab,
                      ...(activeTab === tab ? styles.tabActive : {})
                    }}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {activeTab === 'overview' && summary && (
                <>
                  <div style={styles.statsGrid}>
                    <StatsCard
                      title="Events Today"
                      value={summary.events.today}
                      subtitle={`${summary.events.this_week} this week`}
                    />
                    <StatsCard
                      title="Total Events"
                      value={summary.events.total}
                      subtitle={`${summary.events.this_month} this month`}
                    />
                    <StatsCard
                      title="Sessions Today"
                      value={summary.sessions.today}
                      subtitle={`${summary.sessions.active} active`}
                    />
                    <StatsCard
                      title="Total Sessions"
                      value={summary.sessions.total}
                      subtitle={`${summary.sessions.this_week} this week`}
                    />
                  </div>

                  <div style={styles.grid2}>
                    <div style={styles.card}>
                      <h3 style={styles.sectionTitle}>Events (Last 7 Days)</h3>
                      <EventsChart data={summary.events_per_day} />
                    </div>
                    <div style={styles.card}>
                      <h3 style={styles.sectionTitle}>Top Events</h3>
                      <TopEventsTable events={summary.top_events} />
                    </div>
                  </div>
                </>
              )}

              {activeTab === 'breakdown' && <EventBreakdown />}
              {activeTab === 'events' && <EventsExplorer />}
              {activeTab === 'sessions' && <SessionsList />}
            </>
          )}
        </>
      )}
    </div>
  )
}

export default App
