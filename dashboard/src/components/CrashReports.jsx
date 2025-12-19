import React, { useState, useEffect } from 'react'
import { getCrashes, deleteCrash, getAdminKey } from '../api'

const styles = {
  container: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px'
  },
  title: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#e7e9ea'
  },
  refreshBtn: {
    background: '#2f3336',
    border: 'none',
    color: '#e7e9ea',
    padding: '6px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px'
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
    fontSize: '14px',
    verticalAlign: 'top'
  },
  clickableRow: {
    cursor: 'pointer'
  },
  expandedRow: {
    background: '#1a1d21'
  },
  detailsCell: {
    padding: '16px',
    background: '#1a1d21'
  },
  detailsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '12px'
  },
  detailItem: {
    background: '#2f3336',
    padding: '8px 12px',
    borderRadius: '6px'
  },
  detailLabel: {
    fontSize: '11px',
    color: '#71767b',
    marginBottom: '2px'
  },
  detailValue: {
    fontSize: '13px',
    color: '#e7e9ea',
    wordBreak: 'break-all'
  },
  actionBtn: {
    background: '#1d9bf0',
    border: 'none',
    color: '#fff',
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    marginRight: '6px'
  },
  deleteBtn: {
    background: '#dc3545',
    border: 'none',
    color: '#fff',
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px'
  },
  emptyState: {
    textAlign: 'center',
    padding: '40px',
    color: '#71767b'
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: '500'
  },
  platformBadge: {
    background: '#2f3336',
    color: '#e7e9ea'
  },
  sizeBadge: {
    background: '#1d4ed8',
    color: '#fff'
  },
  gpuBadge: {
    background: '#059669',
    color: '#fff'
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    color: '#71767b'
  },
  error: {
    background: '#67000d',
    color: '#ff6b6b',
    padding: '12px',
    borderRadius: '6px',
    marginBottom: '16px'
  },
  stats: {
    display: 'flex',
    gap: '16px',
    marginBottom: '16px',
    flexWrap: 'wrap'
  },
  stat: {
    background: '#2f3336',
    padding: '8px 16px',
    borderRadius: '6px',
    fontSize: '13px',
    color: '#e7e9ea'
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

function formatDate(dateString) {
  const date = new Date(dateString)
  return date.toLocaleString()
}

function CrashReports() {
  const [crashes, setCrashes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id)
  }

  const fetchCrashes = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await getCrashes()
      setCrashes(data.crashes || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchCrashes()
  }, [])

  const handleDownload = (crashId, filename) => {
    // Create download link with admin key
    const adminKey = getAdminKey()
    const url = `/api/crashes/${crashId}/download`

    // Use fetch to download with auth header
    fetch(url, {
      headers: { 'x-admin-key': adminKey }
    })
      .then(response => response.blob())
      .then(blob => {
        const downloadUrl = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = downloadUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.URL.revokeObjectURL(downloadUrl)
      })
      .catch(err => {
        alert('Download failed: ' + err.message)
      })
  }

  const handleDelete = async (crashId) => {
    if (!confirm('Are you sure you want to delete this crash report?')) {
      return
    }

    try {
      await deleteCrash(crashId)
      setCrashes(crashes.filter(c => c.id !== crashId))
    } catch (err) {
      alert('Delete failed: ' + err.message)
    }
  }

  if (loading) {
    return <div style={styles.loading}>Loading crash reports...</div>
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.title}>Crash Reports</h3>
        <button style={styles.refreshBtn} onClick={fetchCrashes}>
          Refresh
        </button>
      </div>

      {error && (
        <div style={styles.error}>Error: {error}</div>
      )}

      <div style={styles.stats}>
        <span style={styles.stat}>
          Total: {crashes.length} crash{crashes.length !== 1 ? 'es' : ''}
        </span>
        <span style={styles.stat}>
          Total Size: {formatFileSize(crashes.reduce((sum, c) => sum + (c.file_size || 0), 0))}
        </span>
      </div>

      {crashes.length === 0 ? (
        <div style={styles.emptyState}>
          No crash reports yet
        </div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Date</th>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>Platform</th>
              <th style={styles.th}>GPU</th>
              <th style={styles.th}>Size</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {crashes.map(crash => (
              <React.Fragment key={crash.id}>
                <tr
                  style={expandedId === crash.id ? styles.expandedRow : styles.clickableRow}
                  onClick={() => toggleExpand(crash.id)}
                >
                  <td style={styles.td}>
                    {formatDate(crash.upload_date)}
                  </td>
                  <td style={styles.td}>
                    <span style={{...styles.badge, ...styles.platformBadge}}>
                      {crash.version || crash.client_version || 'unknown'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{...styles.badge, ...styles.platformBadge}}>
                      {crash.platform}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{...styles.badge, ...styles.gpuBadge}}>
                      {crash.gpu || 'unknown'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={{...styles.badge, ...styles.sizeBadge}}>
                      {formatFileSize(crash.file_size)}
                    </span>
                  </td>
                  <td style={styles.td} onClick={e => e.stopPropagation()}>
                    <button
                      style={styles.actionBtn}
                      onClick={() => handleDownload(crash.id, crash.filename)}
                    >
                      Download
                    </button>
                    <button
                      style={styles.deleteBtn}
                      onClick={() => handleDelete(crash.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {expandedId === crash.id && (
                  <tr>
                    <td colSpan="6" style={styles.detailsCell}>
                      <div style={styles.detailsGrid}>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>Filename</div>
                          <div style={styles.detailValue}>{crash.filename}</div>
                        </div>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>RHI</div>
                          <div style={styles.detailValue}>{crash.rhi || '-'}</div>
                        </div>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>Driver</div>
                          <div style={styles.detailValue}>{crash.driver || '-'}</div>
                        </div>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>Build ID</div>
                          <div style={styles.detailValue}>{crash.build_id || '-'}</div>
                        </div>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>Steam App ID</div>
                          <div style={styles.detailValue}>{crash.steam_appid || '-'}</div>
                        </div>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>Session ID</div>
                          <div style={styles.detailValue}>{crash.session_id || '-'}</div>
                        </div>
                        <div style={styles.detailItem}>
                          <div style={styles.detailLabel}>Crash Timestamp</div>
                          <div style={styles.detailValue}>{crash.timestamp_utc || '-'}</div>
                        </div>
                        {crash.error_message && (
                          <div style={{...styles.detailItem, gridColumn: '1 / -1'}}>
                            <div style={styles.detailLabel}>Error Message</div>
                            <div style={{...styles.detailValue, color: '#ff6b6b'}}>{crash.error_message}</div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default CrashReports
