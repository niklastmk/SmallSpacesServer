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
    fontSize: '14px'
  },
  errorCell: {
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#ff6b6b'
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
    marginBottom: '16px'
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
              <th style={styles.th}>Filename</th>
              <th style={styles.th}>Platform</th>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>Size</th>
              <th style={styles.th}>Error</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {crashes.map(crash => (
              <tr key={crash.id}>
                <td style={styles.td}>{formatDate(crash.upload_date)}</td>
                <td style={styles.td}>{crash.filename}</td>
                <td style={styles.td}>
                  <span style={{...styles.badge, ...styles.platformBadge}}>
                    {crash.platform}
                  </span>
                </td>
                <td style={styles.td}>{crash.client_version}</td>
                <td style={styles.td}>
                  <span style={{...styles.badge, ...styles.sizeBadge}}>
                    {formatFileSize(crash.file_size)}
                  </span>
                </td>
                <td style={{...styles.td, ...styles.errorCell}} title={crash.error_message}>
                  {crash.error_message || '-'}
                </td>
                <td style={styles.td}>
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
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default CrashReports
