import React, { useState, useEffect } from 'react'
import { getArtists, setArtists, getArtistClicks } from '../api'
import StatsCard from './StatsCard'
import EventsChart from './EventsChart'

const styles = {
  card: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '24px',
    border: '1px solid #2f3336',
    marginBottom: '24px',
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
  helpText: {
    fontSize: '13px',
    color: '#71767b',
    marginBottom: '16px',
    lineHeight: '1.6',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '16px',
    marginBottom: '24px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '14px',
  },
  th: {
    textAlign: 'left',
    color: '#71767b',
    fontWeight: '500',
    fontSize: '13px',
    padding: '8px 12px 8px 0',
    borderBottom: '1px solid #2f3336',
  },
  td: {
    padding: '12px 12px 12px 0',
    color: '#e7e9ea',
    borderBottom: '1px solid #1c1f23',
    verticalAlign: 'top',
  },
  muted: {
    color: '#71767b',
    fontSize: '13px',
  },
  linkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  code: {
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: '12px',
    background: '#0c0e10',
    border: '1px solid #2f3336',
    borderRadius: '6px',
    padding: '4px 8px',
    color: '#e7e9ea',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '360px',
  },
  copyBtn: {
    background: 'transparent',
    border: '1px solid #2f3336',
    color: '#e7e9ea',
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    flexShrink: 0,
  },
  editorRow: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 0.8fr 1.6fr auto auto',
    gap: '10px',
    alignItems: 'center',
    marginBottom: '10px',
  },
  input: {
    background: '#0c0e10',
    color: '#e7e9ea',
    border: '1px solid #2f3336',
    borderRadius: '8px',
    padding: '9px 12px',
    fontSize: '14px',
    width: '100%',
    boxSizing: 'border-box',
  },
  labelRow: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 0.8fr 1.6fr auto auto',
    gap: '10px',
    marginBottom: '6px',
    fontSize: '12px',
    color: '#71767b',
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    color: '#71767b',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    background: 'transparent',
    border: '1px solid #2f3336',
    color: '#ff6b6b',
    padding: '8px 12px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '13px',
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
  secondaryBtn: {
    background: 'transparent',
    border: '1px solid #2f3336',
    color: '#e7e9ea',
    padding: '10px 16px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  status: { fontSize: '13px', color: '#71767b' },
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
  loading: { color: '#71767b', fontSize: '14px', padding: '20px 0' },
  preview: {
    fontFamily: 'Menlo, Consolas, monospace',
    fontSize: '11px',
    color: '#71767b',
    wordBreak: 'break-all',
    marginBottom: '14px',
    lineHeight: '1.5',
  },
}

const EMPTY_ARTIST = { slug: '', name: '', destination: '', active: true }

// Mirrors buildDestinationUrl() on the server so the row preview shows exactly
// what the artist's Shopify analytics will receive.
function previewUrl(artist) {
  if (!artist.destination) return ''
  try {
    const url = new URL(artist.destination)
    url.searchParams.set('utm_source', 'smallspaces')
    url.searchParams.set('utm_medium', 'game')
    url.searchParams.set('utm_campaign', artist.utm_campaign || 'artist-showcase')
    url.searchParams.set('ss_click', 'a7f3c1d9')
    return url.toString()
  } catch {
    return 'Not a valid URL yet'
  }
}

function gameLink(slug) {
  return `${window.location.origin}/go/${slug || '<slug>'}`
}

function CopyableLink({ value }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div style={styles.linkRow}>
      <span style={styles.code}>{value}</span>
      <button style={styles.copyBtn} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

function ArtistLinks() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [rows, setRows] = useState([])
  const [original, setOriginal] = useState('[]')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null)
  const [stats, setStats] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      setError(null)
      const [artistsRes, clicksRes] = await Promise.all([
        getArtists(),
        getArtistClicks({ days: 30 })
      ])
      const list = artistsRes.artists || []
      setRows(list)
      setOriginal(JSON.stringify(list))
      setStats(clicksRes)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const dirty = JSON.stringify(rows) !== original
  const canSave = dirty && !saving

  const updateRow = (index, field, value) => {
    setRows(rows.map((r, i) => i === index ? { ...r, [field]: value } : r))
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      setStatus(null)
      const res = await setArtists(rows)
      setRows(res.artists)
      setOriginal(JSON.stringify(res.artists))
      setStatus({ type: 'success', message: `Saved ${res.count} artist${res.count === 1 ? '' : 's'}` })
      const clicksRes = await getArtistClicks({ days: 30 })
      setStats(clicksRes)
    } catch (err) {
      setStatus({ type: 'error', message: err.message })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div style={styles.card}><div style={styles.loading}>Loading artist links...</div></div>
  }

  return (
    <div>
      {error && <div style={styles.error}>Error: {error}</div>}

      {stats && (
        <>
          <div style={styles.statsGrid}>
            <StatsCard
              title="Clicks Today"
              value={stats.totals.today}
              subtitle={`${stats.totals.last_7_days} in the last 7 days`}
            />
            <StatsCard
              title="Last 30 Days"
              value={stats.totals.last_30_days}
              subtitle={`${stats.totals.total} all time`}
            />
            <StatsCard
              title="Unique Visitors"
              value={stats.totals.unique_total}
              subtitle="repeat clicks within 30 min not counted"
            />
            <StatsCard
              title="Bots Filtered"
              value={stats.totals.bots_filtered}
              subtitle="link previews, crawlers — excluded above"
            />
          </div>

          <div style={styles.card}>
            <h3 style={styles.title}>Clicks (Last 30 Days)</h3>
            <EventsChart data={stats.per_day} />
          </div>

          <div style={styles.card}>
            <h3 style={{ ...styles.title, marginBottom: '16px' }}>Per Artist</h3>
            {stats.per_artist.length === 0 ? (
              <p style={styles.muted}>No artists configured yet — add one below.</p>
            ) : (
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Artist</th>
                    <th style={styles.th}>Link in the game</th>
                    <th style={styles.th}>Clicks</th>
                    <th style={styles.th}>7 days</th>
                    <th style={styles.th}>Unique</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.per_artist.map(a => (
                    <tr key={a.slug}>
                      <td style={styles.td}>
                        {a.name}
                        {!a.active && <span style={styles.muted}> — inactive</span>}
                        <div style={styles.muted}>{a.destination}</div>
                      </td>
                      <td style={styles.td}><CopyableLink value={gameLink(a.slug)} /></td>
                      <td style={styles.td}>{a.total}</td>
                      <td style={styles.td}>{a.last_7_days}</td>
                      <td style={styles.td}>{a.unique}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Only worth showing once links actually carry a placement label.
              With one showcase reachable from anywhere there is nothing to
              split, and a lone "unknown" row is just noise. */}
          {stats.per_placement.some(p => p.placement && p.placement !== 'unknown') && (
            <div style={styles.card}>
              <h3 style={{ ...styles.title, marginBottom: '8px' }}>Per Placement</h3>
              <p style={styles.helpText}>
                Optional. If a link carries a <code>?p=</code> label it shows up here, split by
                where in the game it was clicked — and as <code>utm_content</code> in the artist's
                Shopify report. Plain <code>/go/&lt;slug&gt;</code> links simply don't appear.
              </p>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Artist</th>
                    <th style={styles.th}>Placement</th>
                    <th style={styles.th}>Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.per_placement.map(p => (
                    <tr key={`${p.slug}-${p.placement}`}>
                      <td style={styles.td}>{p.slug}</td>
                      <td style={styles.td}>{p.placement}</td>
                      <td style={styles.td}>{p.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div style={styles.card}>
        <div style={styles.header}>
          <h3 style={styles.title}>Artists</h3>
          <span style={styles.muted}>{rows.length} configured</span>
        </div>

        <p style={styles.helpText}>
          The game only ever ships <code>/go/&lt;slug&gt;</code>. Change the destination here and every
          link already out in the wild follows it — no game patch needed. Turning an artist off
          shows a friendly "link no longer available" page instead.
        </p>

        {rows.length > 0 && (
          <div style={styles.labelRow}>
            <span>Name</span>
            <span>Slug (used in the link)</span>
            <span>Destination</span>
            <span>Active</span>
            <span></span>
          </div>
        )}

        {rows.map((row, i) => (
          <div key={i}>
            <div style={styles.editorRow}>
              <input
                style={styles.input}
                value={row.name || ''}
                placeholder="Leah Gardner"
                onChange={e => updateRow(i, 'name', e.target.value)}
              />
              <input
                style={styles.input}
                value={row.slug || ''}
                placeholder="leah"
                onChange={e => updateRow(i, 'slug', e.target.value.toLowerCase())}
              />
              <input
                style={styles.input}
                value={row.destination || ''}
                placeholder="https://leahgardner.art"
                onChange={e => updateRow(i, 'destination', e.target.value)}
              />
              <label style={styles.toggle}>
                <input
                  type="checkbox"
                  checked={row.active !== false}
                  onChange={e => updateRow(i, 'active', e.target.checked)}
                />
                On
              </label>
              <button
                style={styles.removeBtn}
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
              >
                Remove
              </button>
            </div>
            <div style={styles.preview}>
              Player is sent to: {previewUrl(row) || '—'}
            </div>
          </div>
        ))}

        <div style={styles.actions}>
          <button
            style={styles.secondaryBtn}
            onClick={() => setRows([...rows, { ...EMPTY_ARTIST }])}
          >
            + Add artist
          </button>
          <button
            style={{ ...styles.saveBtn, ...(canSave ? {} : styles.saveBtnDisabled) }}
            onClick={handleSave}
            disabled={!canSave}
          >
            {saving ? 'Saving…' : dirty ? 'Save Changes' : 'No Changes'}
          </button>
          <button style={styles.secondaryBtn} onClick={load} disabled={saving}>
            Reload
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
      </div>
    </div>
  )
}

export default ArtistLinks
