import React, { useState, useEffect } from 'react'
import { getFeatured, setFeatured } from '../api'

const styles = {
  container: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '24px',
    border: '1px solid #2f3336',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px',
  },
  title: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#e7e9ea',
  },
  count: {
    fontSize: '14px',
    color: '#71767b',
  },
  helpText: {
    fontSize: '13px',
    color: '#71767b',
    marginBottom: '12px',
    lineHeight: '1.5',
  },
  textarea: {
    width: '100%',
    minHeight: '280px',
    background: '#0c0e10',
    color: '#e7e9ea',
    border: '1px solid #2f3336',
    borderRadius: '8px',
    padding: '12px',
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: '13px',
    boxSizing: 'border-box',
    resize: 'vertical',
  },
  actions: {
    display: 'flex',
    gap: '12px',
    marginTop: '16px',
    alignItems: 'center',
  },
  saveBtn: {
    background: '#1d9bf0',
    border: 'none',
    color: '#fff',
    padding: '10px 20px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '600',
  },
  saveBtnDisabled: {
    background: '#2f3336',
    color: '#71767b',
    cursor: 'not-allowed',
  },
  refreshBtn: {
    background: 'transparent',
    border: '1px solid #2f3336',
    color: '#e7e9ea',
    padding: '10px 16px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  status: {
    fontSize: '13px',
    color: '#71767b',
  },
  statusSuccess: { color: '#00ba7c' },
  statusError: { color: '#ff6b6b' },
  error: {
    background: '#67000d',
    color: '#ff6b6b',
    padding: '12px',
    borderRadius: '8px',
    marginBottom: '16px',
    fontSize: '14px',
  },
  loading: {
    color: '#71767b',
    fontSize: '14px',
    padding: '20px 0',
  },
}

// Parse the textarea content into a clean array of IDs:
// - split on any whitespace (newline / space / tab)
// - drop empties
// - drop comment lines starting with #
// - trim each
function parseIds(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}

function FeaturedDesigns() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [text, setText] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // { type: 'success' | 'error', message: string }

  const load = async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await getFeatured()
      const joined = (res.ids || []).join('\n')
      setText(joined)
      setOriginalText(joined)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const ids = parseIds(text)
  const dirty = text !== originalText
  const canSave = dirty && !saving

  const handleSave = async () => {
    try {
      setSaving(true)
      setStatus(null)
      const res = await setFeatured(ids)
      const normalized = ids.join('\n')
      setText(normalized)
      setOriginalText(normalized)
      setStatus({ type: 'success', message: `Saved ${res.count} ID${res.count === 1 ? '' : 's'}` })
    } catch (err) {
      setStatus({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.title}>Featured Designs</h3>
        <span style={styles.count}>{ids.length} ID{ids.length === 1 ? '' : 's'}</span>
      </div>

      <p style={styles.helpText}>
        These design IDs are pulled by the game on startup to populate the Online
        Showcase. One ID per line. Lines starting with <code style={{color:'#e7e9ea'}}>#</code> are
        ignored (use them for notes). Save replaces the entire list.
      </p>

      {error && <div style={styles.error}>Error: {error}</div>}

      {loading ? (
        <div style={styles.loading}>Loading featured list...</div>
      ) : (
        <>
          <textarea
            style={styles.textarea}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={'# One design ID per line\nABCDEF1234567890\n0123456789ABCDEF'}
            spellCheck={false}
          />
          <div style={styles.actions}>
            <button
              style={{ ...styles.saveBtn, ...(canSave ? {} : styles.saveBtnDisabled) }}
              onClick={handleSave}
              disabled={!canSave}
            >
              {saving ? 'Saving…' : dirty ? 'Save Changes' : 'No Changes'}
            </button>
            <button style={styles.refreshBtn} onClick={load} disabled={saving}>
              Reload from server
            </button>
            {status && (
              <span style={{
                ...styles.status,
                ...(status.type === 'success' ? styles.statusSuccess : styles.statusError)
              }}>
                {status.message}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default FeaturedDesigns
