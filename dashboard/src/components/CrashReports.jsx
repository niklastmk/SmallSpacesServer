import React, { useState, useEffect } from 'react'
import { getCrashes, deleteCrash, getAdminKey, reclassifyCrashes, getCrashGroups, getCrashGroup, getCrashSummary } from '../api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, Cell, PieChart, Pie } from 'recharts'

// ============================================
// STYLES
// ============================================
const s = {
  container: { display: 'flex', flexDirection: 'column', gap: '20px' },
  card: { background: '#16181c', borderRadius: '12px', padding: '20px', border: '1px solid #2f3336' },
  subTabs: { display: 'flex', gap: '4px', background: '#16181c', borderRadius: '10px', padding: '4px', border: '1px solid #2f3336' },
  subTab: { background: 'transparent', border: 'none', color: '#71767b', padding: '8px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: '500', borderRadius: '8px' },
  subTabActive: { background: '#1d9bf0', color: '#fff' },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' },
  statCard: { background: '#1a1d21', borderRadius: '10px', padding: '16px', border: '1px solid #2f3336' },
  statValue: { fontSize: '28px', fontWeight: '700', color: '#e7e9ea' },
  statLabel: { fontSize: '12px', color: '#71767b', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' },
  chartsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '16px', marginBottom: '20px' },
  chartCard: { background: '#16181c', borderRadius: '12px', padding: '20px', border: '1px solid #2f3336' },
  chartTitle: { fontSize: '14px', fontWeight: '600', color: '#e7e9ea', marginBottom: '16px' },
  groupCard: { background: '#16181c', borderRadius: '12px', border: '1px solid #2f3336', overflow: 'hidden', marginBottom: '12px' },
  groupHeader: { padding: '16px 20px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' },
  groupTitle: { fontSize: '14px', fontWeight: '600', color: '#e7e9ea', marginBottom: '4px', fontFamily: 'monospace' },
  groupDetail: { padding: '0 20px 20px', borderTop: '1px solid #2f3336' },
  detailLabel: { fontSize: '11px', color: '#71767b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px', marginTop: '16px' },
  detailText: { fontSize: '13px', color: '#e7e9ea', lineHeight: '1.5', background: '#1a1d21', padding: '10px 14px', borderRadius: '8px' },
  tag: { display: 'inline-block', padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: '500', background: '#2f3336', color: '#e7e9ea' },
  tagList: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  countBadge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '28px', height: '28px', borderRadius: '14px', fontSize: '13px', fontWeight: '700', background: '#2f3336', color: '#e7e9ea' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '12px 8px', borderBottom: '1px solid #2f3336', color: '#71767b', fontSize: '12px', fontWeight: '500' },
  td: { padding: '12px 8px', borderBottom: '1px solid #2f3336', color: '#e7e9ea', fontSize: '13px', verticalAlign: 'top' },
  clickableRow: { cursor: 'pointer' },
  expandedRow: { background: '#1a1d21' },
  detailsCell: { padding: '16px', background: '#1a1d21' },
  detailsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' },
  detailItem: { background: '#2f3336', padding: '8px 12px', borderRadius: '6px' },
  detailItemLabel: { fontSize: '11px', color: '#71767b', marginBottom: '2px' },
  detailItemValue: { fontSize: '13px', color: '#e7e9ea', wordBreak: 'break-all' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '500' },
  actionBtn: { background: '#1d9bf0', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '6px' },
  deleteBtn: { background: '#dc3545', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' },
  refreshBtn: { background: '#2f3336', border: 'none', color: '#e7e9ea', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' },
  emptyState: { textAlign: 'center', padding: '48px 24px', color: '#71767b' },
  emptyTitle: { fontSize: '16px', fontWeight: '600', color: '#e7e9ea', marginBottom: '8px' },
  loading: { textAlign: 'center', padding: '40px', color: '#71767b' },
  error: { background: '#67000d', color: '#ff6b6b', padding: '12px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px' },
  miniTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  miniTh: { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #2f3336', color: '#71767b', fontSize: '11px', fontWeight: '500' },
  miniTd: { padding: '8px 6px', borderBottom: '1px solid #2f3336', color: '#e7e9ea', fontSize: '12px' },
  topGroupCard: { background: '#1a1d21', borderRadius: '8px', padding: '12px 16px', border: '1px solid #2f3336', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
}

const CRASH_TYPE_COLORS = {
  'Shader Compilation': '#f59e0b', 'Out of VRAM': '#ef4444', 'Out of RAM': '#dc2626',
  'Out of Memory': '#ef4444', 'GPU Crash': '#3b82f6', 'Render Hang': '#ea580c',
  'Thread Hang': '#f97316', 'Config Error': '#8b5cf6', 'Access Violation': '#ec4899',
  'Shader Mismatch': '#eab308', 'Material Error': '#a855f7', 'Threading Error': '#f472b6',
  'Intentional Crash': '#6b7280', 'Fatal Error': '#e11d48', 'Assertion': '#a78bfa',
  'Hang': '#ea580c', 'Crash': '#ec4899', 'Unknown': '#374151'
}
const SEVERITY_COLORS = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#2563eb' }
const PIE_COLORS = ['#ef4444', '#f59e0b', '#8b5cf6', '#ea580c', '#3b82f6', '#ec4899', '#10b981', '#6b7280']
const TOOLTIP_STYLE = { background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', fontSize: '12px' }

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}
function formatDate(d) { return new Date(d).toLocaleString() }
function formatShortDate(d) { return new Date(d).toLocaleDateString() }

function formatSessionTime(seconds) {
  if (seconds == null) return '-'
  if (seconds < 60) return seconds + 's'
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm'
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '-'
  const now = new Date()
  const d = new Date(dateStr)
  const diffMs = now - d
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return diffMin + 'm ago'
  if (diffHr < 24) return diffHr + 'h ago'
  if (diffDays < 30) return diffDays + 'd ago'
  if (diffDays < 365) return Math.floor(diffDays / 30) + 'mo ago'
  return Math.floor(diffDays / 365) + 'y ago'
}

function CrashTypeTooltip({ active, payload }) {
  if (!active || !payload || !payload[0]) return null
  const d = payload[0].payload
  return (
    <div style={{ background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', padding: '10px 14px', fontSize: '12px' }}>
      <div style={{ fontWeight: '600', color: '#e7e9ea', marginBottom: '6px' }}>{d.name} — {d.count} crash{d.count !== 1 ? 'es' : ''}</div>
      {d.top_gpu && <div style={{ color: '#71767b' }}>Top GPU: <span style={{ color: '#e7e9ea' }}>{d.top_gpu}</span></div>}
      {d.top_ram && <div style={{ color: '#71767b' }}>Top RAM: <span style={{ color: '#e7e9ea' }}>{d.top_ram}</span></div>}
      {d.median_session_time != null && <div style={{ color: '#71767b' }}>Median session time: <span style={{ color: '#e7e9ea' }}>{formatSessionTime(d.median_session_time)}</span></div>}
    </div>
  )
}

function HardwareTooltip({ active, payload }) {
  if (!active || !payload || !payload[0]) return null
  const d = payload[0].payload
  return (
    <div style={{ background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', padding: '10px 14px', fontSize: '12px' }}>
      <div style={{ fontWeight: '600', color: '#e7e9ea', marginBottom: '6px' }}>{d.name} — {d.count} crash{d.count !== 1 ? 'es' : ''}</div>
      {d.top_crash_types?.length > 0 && <div style={{ color: '#71767b', marginTop: '4px' }}>Top issues: <span style={{ color: '#e7e9ea' }}>{d.top_crash_types.join(', ')}</span></div>}
      {d.median_session_time != null && <div style={{ color: '#71767b' }}>Median session: <span style={{ color: '#e7e9ea' }}>{formatSessionTime(d.median_session_time)}</span></div>}
      <div style={{ color: '#71767b', marginTop: '4px', fontSize: '11px', fontStyle: 'italic' }}>Click to filter groups</div>
    </div>
  )
}

function FilterChip({ label, onRemove }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', background: '#1d9bf022', border: '1px solid #1d9bf0', borderRadius: '16px', fontSize: '12px', color: '#1d9bf0' }}>
      {label}
      <span onClick={onRemove} style={{ cursor: 'pointer', fontWeight: '700', fontSize: '14px', lineHeight: 1 }}>&times;</span>
    </span>
  )
}

function CrashTypeBadge({ type }) {
  const color = CRASH_TYPE_COLORS[type] || CRASH_TYPE_COLORS.Other
  return <span style={{ ...s.badge, background: color + '22', color }}>{type}</span>
}
function SeverityBadge({ severity }) {
  return <span style={{ ...s.badge, background: SEVERITY_COLORS[severity] || '#2f3336', color: '#fff' }}>{severity}</span>
}

// ============================================
// OVERVIEW
// ============================================
function CrashOverview({ summary, loading, onNavigateToGroup }) {
  if (loading) return <div style={s.loading}>Loading...</div>
  if (!summary || summary.total_crashes === 0) {
    return <div style={s.emptyState}><div style={s.emptyTitle}>No crash reports yet</div></div>
  }

  return (
    <div>
      <div style={s.statsGrid}>
        <div style={s.statCard}><div style={s.statValue}>{summary.total_crashes}</div><div style={s.statLabel}>Total</div></div>
        <div style={s.statCard}><div style={s.statValue}>{summary.crashes_today}</div><div style={s.statLabel}>Today</div></div>
        <div style={s.statCard}><div style={s.statValue}>{summary.crashes_this_week}</div><div style={s.statLabel}>This Week</div></div>
        <div style={s.statCard}><div style={s.statValue}>{summary.total_groups}</div><div style={s.statLabel}>Unique Issues</div></div>
      </div>

      {/* Top crash groups */}
      {summary.top_groups && summary.top_groups.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={s.chartTitle}>Top Issues</div>
          {summary.top_groups.map((g, i) => {
            const isActive = g.crashes_last_7d > 0
            const recencyColor = isActive ? '#ef4444' : '#3b82f6'
            return (
              <div key={i} style={{ ...s.topGroupCard, cursor: 'pointer', transition: 'background 0.15s', opacity: isActive ? 1 : 0.55 }}
                onClick={() => onNavigateToGroup && onNavigateToGroup(g.id)}
                onMouseEnter={e => { e.currentTarget.style.background = '#22262b'; e.currentTarget.style.opacity = '1' }}
                onMouseLeave={e => { e.currentTarget.style.background = '#1a1d21'; e.currentTarget.style.opacity = isActive ? '1' : '0.55' }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: recencyColor, flexShrink: 0 }} title={isActive ? 'Active this week' : 'No crashes this week'} />
                  <div style={{ fontSize: '13px', color: '#e7e9ea', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                  <CrashTypeBadge type={g.category || g.crash_type} />
                  {g.last_seen && <span style={{ fontSize: '11px', color: '#71767b' }}>{formatRelativeTime(g.last_seen)}</span>}
                  <span style={{ fontSize: '13px', color: '#71767b', minWidth: '70px', textAlign: 'right' }}>
                    {g.crashes_last_7d > 0 && <span style={{ color: recencyColor, fontWeight: '600' }}>{g.crashes_last_7d} this wk</span>}
                    {g.crashes_last_7d > 0 && g.crashes_last_7d < g.count && <span style={{ color: '#71767b' }}> / </span>}
                    {(g.crashes_last_7d === 0 || g.crashes_last_7d < g.count) && <span>{g.count} total</span>}
                  </span>
                  <span style={{ fontSize: '11px', color: '#71767b' }}>→</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div style={s.chartsGrid}>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes (Last 30 Days)</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={summary.crashes_per_day}>
              <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/><stop offset="95%" stopColor="#ef4444" stopOpacity={0}/></linearGradient></defs>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71767b' }} tickFormatter={v => v.slice(5)} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="count" stroke="#ef4444" fill="url(#cg)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={s.chartCard}>
          <div style={s.chartTitle}>By Crash Type</div>
          {summary.crash_type_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={summary.crash_type_breakdown} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={70}
                  label={({ name, count }) => `${name} (${count})`} labelLine={{ stroke: '#71767b' }} fontSize={10}>
                  {summary.crash_type_breakdown.map((e, i) => <Cell key={e.name} fill={CRASH_TYPE_COLORS[e.name] || PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip content={<CrashTypeTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No data</div>}
        </div>

        <div style={s.chartCard}>
          <div style={s.chartTitle}>Time in Session at Crash</div>
          {summary.time_distribution?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.time_distribution}>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71767b' }} />
                <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No data</div>}
        </div>

        <div style={s.chartCard}>
          <div style={s.chartTitle}>By GPU</div>
          {summary.gpu_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.gpu_breakdown.slice(0, 8)} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={150} tickFormatter={v => v.length > 24 ? v.slice(0, 24) + '...' : v} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No data</div>}
        </div>
      </div>
    </div>
  )
}

// ============================================
// GROUP CRASHES TABLE (expandable + downloadable)
// ============================================
function GroupCrashesTable({ crashes, count, loading: isLoading }) {
  const [expandedCrashId, setExpandedCrashId] = useState(null)
  const handleDownload = (crashId, filename) => {
    const adminKey = getAdminKey()
    fetch(`/api/crashes/${crashId}/download`, { headers: { 'x-admin-key': adminKey } })
      .then(r => r.blob()).then(blob => {
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = filename
        document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url)
      }).catch(err => alert('Download failed: ' + err.message))
  }

  return (
    <div>
      <div style={s.detailLabel}>Crashes ({count})</div>
      {isLoading ? <div style={{ color: '#71767b', fontSize: '12px' }}>Loading...</div> :
        crashes ? (
          <table style={s.miniTable}><thead><tr>
            <th style={s.miniTh}>Date</th><th style={s.miniTh}>GPU</th><th style={s.miniTh}>CPU</th>
            <th style={s.miniTh}>RAM</th><th style={s.miniTh}>OS</th><th style={s.miniTh}>Session</th><th style={s.miniTh}></th>
          </tr></thead><tbody>
            {crashes.map(c => {
              const ctx = c.crash_context || {}
              return (
                <React.Fragment key={c.id}>
                  <tr style={{ cursor: 'pointer', transition: 'background 0.1s', ...(expandedCrashId === c.id ? { background: '#1a1d21' } : {}) }}
                    onClick={() => setExpandedCrashId(expandedCrashId === c.id ? null : c.id)}
                    onMouseEnter={e => { if (expandedCrashId !== c.id) e.currentTarget.style.background = '#1e2126' }}
                    onMouseLeave={e => { if (expandedCrashId !== c.id) e.currentTarget.style.background = '' }}>
                    <td style={s.miniTd}>{formatShortDate(ctx.crash_time || c.upload_date)}</td>
                    <td style={s.miniTd}>{ctx.gpu || c.gpu || '-'}</td>
                    <td style={s.miniTd}>{ctx.cpu || '-'}</td>
                    <td style={s.miniTd}>{ctx.ram_gb ? ctx.ram_gb + ' GB' : '-'}</td>
                    <td style={s.miniTd}>{ctx.os ? ctx.os.split('[')[0].trim() : '-'}</td>
                    <td style={s.miniTd}>{ctx.seconds_since_start != null ? (ctx.seconds_since_start < 60 ? ctx.seconds_since_start + 's' : Math.floor(ctx.seconds_since_start / 60) + 'm') : '-'}</td>
                    <td style={s.miniTd} onClick={e => e.stopPropagation()}>
                      <button onClick={() => handleDownload(c.id, c.filename)} title="Download crash report"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', color: '#71767b', fontSize: '14px', lineHeight: 1 }}
                        onMouseEnter={e => e.currentTarget.style.color = '#1d9bf0'}
                        onMouseLeave={e => e.currentTarget.style.color = '#71767b'}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                      </button>
                    </td>
                  </tr>
                  {expandedCrashId === c.id && (
                    <tr><td colSpan="7" style={{ ...s.detailsCell, padding: '12px' }}><div style={s.detailsGrid}>
                      {(ctx.error_message || c.error_message) && (
                        <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                          <div style={s.detailItemLabel}>Error Message</div>
                          <div style={{ ...s.detailItemValue, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{ctx.error_message || c.error_message}</div>
                        </div>
                      )}
                      <div style={s.detailItem}><div style={s.detailItemLabel}>GPU</div><div style={s.detailItemValue}>{ctx.gpu || c.gpu || '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>CPU</div><div style={s.detailItemValue}>{ctx.cpu || '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>OS</div><div style={s.detailItemValue}>{ctx.os || '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>RAM</div><div style={s.detailItemValue}>{ctx.ram_gb ? ctx.ram_gb + ' GB' : '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>RHI</div><div style={s.detailItemValue}>{c.rhi || '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>Version</div><div style={s.detailItemValue}>{c.version || '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>Callstack Hash</div><div style={{ ...s.detailItemValue, fontFamily: 'monospace', fontSize: '11px' }}>{ctx.callstack_hash || '-'}</div></div>
                      <div style={s.detailItem}><div style={s.detailItemLabel}>Build ID</div><div style={s.detailItemValue}>{c.build_id || '-'}</div></div>
                      {ctx.callstack && (
                        <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                          <div style={s.detailItemLabel}>Callstack</div>
                          <div style={{ ...s.detailItemValue, fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' }}>{ctx.callstack}</div>
                        </div>
                      )}
                    </div></td></tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody></table>
        ) : null}
    </div>
  )
}

// ============================================
// GROUPS
// ============================================
function CrashGroupsView({ groups, loading, crashes, initialExpandedId, hardwareFilter, onHardwareFilter, filters }) {
  const [expandedId, setExpandedId] = useState(initialExpandedId || null)
  const [sortBy, setSortBy] = useState('recent') // 'recent' or 'count'

  // React to external navigation
  useEffect(() => {
    if (initialExpandedId) setExpandedId(initialExpandedId)
  }, [initialExpandedId])
  const [groupCrashes, setGroupCrashes] = useState({})
  const [loadingGroup, setLoadingGroup] = useState(null)

  // Clear cached group crashes when filters actually change
  const filterKey = JSON.stringify(filters)
  useEffect(() => { setGroupCrashes({}) }, [filterKey])

  const toggleGroup = async (groupId) => {
    if (expandedId === groupId) { setExpandedId(null); return }
    setExpandedId(groupId)
    if (!groupCrashes[groupId]) {
      setLoadingGroup(groupId)
      try {
        const data = await getCrashGroup(groupId, filters)
        setGroupCrashes(prev => ({ ...prev, [groupId]: data.crashes }))
      } catch (err) { console.error(err) }
      finally { setLoadingGroup(null) }
    }
  }

  const getHardwareBreakdown = (crashList) => {
    if (!crashList) return null
    const gpus = {}, rams = {}, oss = {}, times = []
    crashList.forEach(c => {
      const ctx = c.crash_context || {}
      const gpu = ctx.gpu || c.gpu || 'unknown'
      const ram = ctx.ram_gb ? ctx.ram_gb + ' GB' : 'unknown'
      const os = ctx.os ? (ctx.os.includes('Windows 11') ? 'Win 11' : ctx.os.includes('Windows 10') ? 'Win 10' : 'Other') : 'unknown'
      gpus[gpu] = (gpus[gpu] || 0) + 1
      rams[ram] = (rams[ram] || 0) + 1
      oss[os] = (oss[os] || 0) + 1
      if (ctx.seconds_since_start != null) times.push(ctx.seconds_since_start)
    })
    times.sort((a, b) => a - b)
    const median = times.length > 0 ? times[Math.floor(times.length / 2)] : null
    const min = times.length > 0 ? times[0] : null
    const max = times.length > 0 ? times[times.length - 1] : null
    return { gpus, rams, oss, sessionTime: { median, min, max, count: times.length } }
  }

  if (loading) return <div style={s.loading}>Loading...</div>
  if (!groups || groups.length === 0) return <div style={s.emptyState}><div style={s.emptyTitle}>No crash groups yet</div></div>

  const sortedGroups = [...groups].sort((a, b) => {
    if (sortBy === 'count') return b.count - a.count
    return new Date(b.last_seen || 0) - new Date(a.last_seen || 0)
  })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '13px', color: '#71767b' }}>
            {groups.length} unique issue{groups.length !== 1 ? 's' : ''} from {crashes.length} crash{crashes.length !== 1 ? 'es' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px', background: '#1a1d21', borderRadius: '6px', padding: '2px', border: '1px solid #2f3336' }}>
          <button style={{ ...s.subTab, fontSize: '11px', padding: '4px 10px', ...(sortBy === 'recent' ? { background: '#2f3336', color: '#e7e9ea' } : {}) }}
            onClick={() => setSortBy('recent')}>Most Recent</button>
          <button style={{ ...s.subTab, fontSize: '11px', padding: '4px 10px', ...(sortBy === 'count' ? { background: '#2f3336', color: '#e7e9ea' } : {}) }}
            onClick={() => setSortBy('count')}>Most Frequent</button>
        </div>
      </div>
      {sortedGroups.map(group => {
        const hw = groupCrashes[group.id] ? getHardwareBreakdown(groupCrashes[group.id]) : null
        const lastSeenMs = group.last_seen ? Date.now() - new Date(group.last_seen).getTime() : Infinity
        const isActive = lastSeenMs < 7 * 86400000
        const isRecent = lastSeenMs < 30 * 86400000
        const isStale = !isRecent
        const dotColor = isActive ? '#ef4444' : isRecent ? '#d97706' : '#3b82f6'
        return (
          <div key={group.id} style={{ ...s.groupCard, opacity: isStale && expandedId !== group.id ? 0.5 : 1, transition: 'opacity 0.2s' }}>
            <div style={{ ...s.groupHeader, ...(expandedId === group.id ? { background: '#1a1d21' } : {}) }} onClick={() => toggleGroup(group.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: dotColor, flexShrink: 0 }}
                    title={isActive ? 'Active (last 7 days)' : isRecent ? 'Recent (last 30 days)' : 'Stale (30+ days)'} />
                  <CrashTypeBadge type={group.category || group.crash_type} />
                  <SeverityBadge severity={group.severity} />
                  {group.last_seen && <span style={{ fontSize: '11px', color: '#71767b' }}>last seen {formatRelativeTime(group.last_seen)}</span>}
                </div>
                <div style={s.groupTitle}>{group.title}</div>
                {group.affected_gpus?.length > 0 && (
                  <div style={{ fontSize: '12px', color: '#71767b', marginTop: '4px' }}>GPUs: {group.affected_gpus.join(', ')}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                <div style={{ textAlign: 'right', lineHeight: '1.3' }}>
                  {group.crashes_last_7d > 0 && <div style={{ fontSize: '12px', color: '#ef4444', fontWeight: '600' }}>{group.crashes_last_7d} this week</div>}
                  <div style={{ fontSize: group.crashes_last_7d > 0 ? '11px' : '13px', color: group.crashes_last_7d > 0 ? '#71767b' : '#e7e9ea', fontWeight: '600' }}>{group.count} total</div>
                </div>
                <span style={{ fontSize: '11px', color: '#71767b', transform: expandedId === group.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
              </div>
            </div>
            {expandedId === group.id && (
              <div style={s.groupDetail}>
                {group.error_message && (
                  <div><div style={s.detailLabel}>Error Message</div>
                    <div style={{ ...s.detailText, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{group.error_message}</div>
                  </div>
                )}
                {(group.ai_root_cause || group.ai_suggested_fix) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    {group.ai_root_cause && <div><div style={s.detailLabel}>AI Root Cause</div><div style={s.detailText}>{group.ai_root_cause}</div></div>}
                    {group.ai_suggested_fix && <div><div style={s.detailLabel}>Suggested Fix</div><div style={s.detailText}>{group.ai_suggested_fix}</div></div>}
                  </div>
                )}
                {hw && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                    <div><div style={s.detailLabel}>GPU Distribution</div><div style={s.tagList}>
                      {Object.entries(hw.gpus).sort((a,b) => b[1]-a[1]).map(([gpu, cnt]) => <span key={gpu} style={{ ...s.tag, background: '#059669', color: '#fff' }}>{gpu} ({cnt})</span>)}
                    </div></div>
                    <div><div style={s.detailLabel}>RAM Distribution</div><div style={s.tagList}>
                      {Object.entries(hw.rams).sort((a,b) => b[1]-a[1]).map(([ram, cnt]) => <span key={ram} style={{ ...s.tag, background: '#3b82f6', color: '#fff' }}>{ram} ({cnt})</span>)}
                    </div></div>
                    <div><div style={s.detailLabel}>OS Distribution</div><div style={s.tagList}>
                      {Object.entries(hw.oss).sort((a,b) => b[1]-a[1]).map(([os, cnt]) => <span key={os} style={{ ...s.tag, background: '#6366f1', color: '#fff' }}>{os} ({cnt})</span>)}
                    </div></div>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                  <div><div style={s.detailLabel}>Session Time at Crash</div>
                    {hw && hw.sessionTime.median != null ? (
                      <div style={{ fontSize: '12px', color: '#e7e9ea' }}>
                        <span style={{ fontWeight: '600' }}>Median: {formatSessionTime(hw.sessionTime.median)}</span>
                        <span style={{ color: '#71767b' }}> (min {formatSessionTime(hw.sessionTime.min)} — max {formatSessionTime(hw.sessionTime.max)})</span>
                      </div>
                    ) : <span style={{ fontSize: '12px', color: '#71767b' }}>-</span>}
                  </div>
                  <div><div style={s.detailLabel}>Affected Versions</div><div style={s.tagList}>
                    {(group.affected_versions || []).map(v => <span key={v} style={s.tag}>{v}</span>)}
                    {(!group.affected_versions || group.affected_versions.length === 0) && <span style={{ fontSize: '12px', color: '#71767b' }}>-</span>}
                  </div></div>
                  <div><div style={s.detailLabel}>Date Range</div>
                    <div style={{ fontSize: '12px', color: '#e7e9ea' }}>
                      {group.first_seen ? `${formatShortDate(group.first_seen)} — ${formatShortDate(group.last_seen)}` : '-'}
                      {group.last_seen && <span style={{ color: '#71767b', marginLeft: '6px' }}>({formatRelativeTime(group.last_seen)})</span>}
                    </div>
                    {group.crashes_last_7d > 0 && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px' }}>{group.crashes_last_7d} in last 7 days</div>}
                    {group.crashes_last_30d > 0 && group.crashes_last_30d !== group.crashes_last_7d && <div style={{ fontSize: '11px', color: '#d97706', marginTop: '2px' }}>{group.crashes_last_30d} in last 30 days</div>}
                  </div>
                </div>
                <GroupCrashesTable crashes={groupCrashes[group.id]} count={group.count} loading={loadingGroup === group.id} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ============================================
// HARDWARE
// ============================================
function HardwareView({ summary, loading, onHardwareFilter }) {
  if (loading) return <div style={s.loading}>Loading...</div>
  if (!summary || summary.total_crashes === 0) return <div style={s.emptyState}><div style={s.emptyTitle}>No data</div></div>

  const gpuCrossRef = summary.crash_type_by_gpu || {}
  const allTypes = [...new Set(Object.values(gpuCrossRef).flatMap(v => Object.keys(v)))]
  const gpuRows = Object.entries(gpuCrossRef)
    .map(([gpu, types]) => ({ gpu, total: Object.values(types).reduce((a, b) => a + b, 0), ...types }))
    .sort((a, b) => b.total - a.total)

  const handleBarClick = (type) => (data) => {
    if (data && data.activePayload?.[0]) {
      onHardwareFilter({ type, value: data.activePayload[0].payload.name })
    }
  }

  return (
    <div>
      <div style={s.chartsGrid}>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by GPU</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={summary.gpu_breakdown?.slice(0, 10)} layout="vertical" onClick={handleBarClick('gpu')} style={{ cursor: 'pointer' }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={160} tickFormatter={v => v.length > 26 ? v.slice(0, 26) + '...' : v} />
              <Tooltip content={<HardwareTooltip />} />
              <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by CPU</div>
          {summary.cpu_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={summary.cpu_breakdown?.slice(0, 10)} layout="vertical" onClick={handleBarClick('cpu')} style={{ cursor: 'pointer' }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={180} tickFormatter={v => v.length > 30 ? v.slice(0, 30) + '...' : v} />
                <Tooltip content={<HardwareTooltip />} />
                <Bar dataKey="count" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No CPU data</div>}
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by RAM</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={summary.ram_breakdown} onClick={handleBarClick('ram')} style={{ cursor: 'pointer' }}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} />
              <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <Tooltip content={<HardwareTooltip />} />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by OS</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={summary.os_breakdown} onClick={handleBarClick('os')} style={{ cursor: 'pointer' }}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} />
              <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <Tooltip content={<HardwareTooltip />} />
              <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Out of Memory — by RAM</div>
          {summary.oom_by_ram?.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={summary.oom_by_ram}>
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} />
                <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <Tooltip content={<HardwareTooltip />} />
                <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No OOM crashes</div>}
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Out of Memory — by GPU</div>
          {summary.oom_by_gpu?.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={summary.oom_by_gpu.slice(0, 8)} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={160} tickFormatter={v => v.length > 26 ? v.slice(0, 26) + '...' : v} />
                <Tooltip content={<HardwareTooltip />} />
                <Bar dataKey="count" fill="#ef4444" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No OOM crashes</div>}
        </div>
      </div>
      <div style={s.card}>
        <div style={s.chartTitle}>Crash Type by GPU</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}><thead><tr>
            <th style={s.th}>GPU</th><th style={{ ...s.th, textAlign: 'right' }}>Total</th>
            {allTypes.map(t => <th key={t} style={{ ...s.th, textAlign: 'right' }}>{t}</th>)}
          </tr></thead><tbody>
            {gpuRows.map(row => (
              <tr key={row.gpu} style={{ cursor: 'pointer' }} onClick={() => onHardwareFilter({ type: 'gpu', value: row.gpu })}
                onMouseEnter={e => e.currentTarget.style.background = '#1a1d21'}
                onMouseLeave={e => e.currentTarget.style.background = ''}>
                <td style={s.td}>{row.gpu}</td>
                <td style={{ ...s.td, textAlign: 'right', fontWeight: '600' }}>{row.total}</td>
                {allTypes.map(t => (
                  <td key={t} style={{ ...s.td, textAlign: 'right', color: row[t] ? CRASH_TYPE_COLORS[t] || '#e7e9ea' : '#2f3336' }}>{row[t] || '-'}</td>
                ))}
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </div>
  )
}

// ============================================
// ALL REPORTS
// ============================================
function AllReports({ crashes, loading, onRefresh, onDelete }) {
  const [expandedId, setExpandedId] = useState(null)
  const handleDownload = (crashId, filename) => {
    const adminKey = getAdminKey()
    fetch(`/api/crashes/${crashId}/download`, { headers: { 'x-admin-key': adminKey } })
      .then(r => r.blob()).then(blob => {
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = filename
        document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url)
      }).catch(err => alert('Download failed: ' + err.message))
  }
  if (loading) return <div style={s.loading}>Loading...</div>
  if (crashes.length === 0) return <div style={s.emptyState}><div style={s.emptyTitle}>No crash reports</div></div>

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: '600', color: '#e7e9ea' }}>All Reports</div>
          <div style={{ fontSize: '13px', color: '#71767b', marginTop: '4px' }}>{crashes.length} reports — {formatFileSize(crashes.reduce((sum, c) => sum + (c.file_size || 0), 0))}</div>
        </div>
        <button style={s.refreshBtn} onClick={onRefresh}>Refresh</button>
      </div>
      <table style={s.table}><thead><tr>
        <th style={s.th}>Date</th><th style={s.th}>Type</th><th style={s.th}>GPU</th>
        <th style={s.th}>RAM</th><th style={s.th}>Session</th><th style={s.th}>Actions</th>
      </tr></thead><tbody>
        {crashes.map(crash => {
          const ctx = crash.crash_context || {}
          return (
            <React.Fragment key={crash.id}>
              <tr style={expandedId === crash.id ? s.expandedRow : s.clickableRow}
                onClick={() => setExpandedId(expandedId === crash.id ? null : crash.id)}>
                <td style={s.td}>{formatDate(crash.crash_context?.crash_time || crash.upload_date)}</td>
                <td style={s.td}><CrashTypeBadge type={crash.category || 'Unknown'} /></td>
                <td style={s.td}><span style={{ fontSize: '12px' }}>{ctx.gpu || crash.gpu || '-'}</span></td>
                <td style={s.td}>{ctx.ram_gb ? ctx.ram_gb + ' GB' : '-'}</td>
                <td style={s.td}>{ctx.seconds_since_start != null ? (ctx.seconds_since_start < 60 ? ctx.seconds_since_start + 's' : Math.floor(ctx.seconds_since_start / 60) + 'm') : '-'}</td>
                <td style={s.td} onClick={e => e.stopPropagation()}>
                  <button style={s.actionBtn} onClick={() => handleDownload(crash.id, crash.filename)}>Download</button>
                  <button style={s.deleteBtn} onClick={() => { if (confirm('Delete?')) onDelete(crash.id) }}>Delete</button>
                </td>
              </tr>
              {expandedId === crash.id && (
                <tr><td colSpan="6" style={s.detailsCell}><div style={s.detailsGrid}>
                  {(ctx.error_message || crash.error_message) && (
                    <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                      <div style={s.detailItemLabel}>Error Message</div>
                      <div style={{ ...s.detailItemValue, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{ctx.error_message || crash.error_message}</div>
                    </div>
                  )}
                  <div style={s.detailItem}><div style={s.detailItemLabel}>GPU</div><div style={s.detailItemValue}>{ctx.gpu || crash.gpu || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>CPU</div><div style={s.detailItemValue}>{ctx.cpu || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>OS</div><div style={s.detailItemValue}>{ctx.os || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>RAM</div><div style={s.detailItemValue}>{ctx.ram_gb ? ctx.ram_gb + ' GB' : '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>RHI</div><div style={s.detailItemValue}>{crash.rhi || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>Build ID</div><div style={s.detailItemValue}>{crash.build_id || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>Callstack Hash</div><div style={{ ...s.detailItemValue, fontFamily: 'monospace', fontSize: '11px' }}>{ctx.callstack_hash || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>Version</div><div style={s.detailItemValue}>{crash.version || '-'}</div></div>
                  {ctx.callstack && (
                    <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                      <div style={s.detailItemLabel}>Callstack</div>
                      <div style={{ ...s.detailItemValue, fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' }}>{ctx.callstack}</div>
                    </div>
                  )}
                </div></td></tr>
              )}
            </React.Fragment>
          )
        })}
      </tbody></table>
    </div>
  )
}

// ============================================
// MAIN
// ============================================
const TIME_RANGES = [
  { id: 'all', label: 'All Time' },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '90d', label: '90 days', ms: 90 * 24 * 60 * 60 * 1000 },
  { id: 'custom', label: 'Custom' },
]

const dateInputStyle = {
  background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '6px',
  color: '#e7e9ea', padding: '4px 8px', fontSize: '12px', fontFamily: 'inherit',
  outline: 'none', cursor: 'pointer', colorScheme: 'dark'
}

function CrashReports() {
  const [tab, setTab] = useState('overview')
  const [timeRange, setTimeRange] = useState('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [hardwareFilter, setHardwareFilter] = useState(null) // { type: 'gpu'|'cpu'|'ram'|'os', value: string }
  const [hwOptions, setHwOptions] = useState(null) // hardware lists for filter dropdown
  const [crashes, setCrashes] = useState([])
  const [groups, setGroups] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reclassifying, setReclassifying] = useState(false)
  const [error, setError] = useState(null)
  const [focusedGroupId, setFocusedGroupId] = useState(null)

  const navigateToGroup = (groupId) => {
    setFocusedGroupId(groupId)
    setTab('groups')
  }

  const handleHardwareFilter = (filter) => {
    setHardwareFilter(filter)
    if (filter) setTab('groups')
  }

  const getFilters = () => {
    const filters = {}
    if (timeRange === 'custom') {
      if (customFrom) filters.from = new Date(customFrom).toISOString()
      if (customTo) filters.to = customTo
    } else {
      const range = TIME_RANGES.find(r => r.id === timeRange)
      if (range && range.ms) filters.from = new Date(Date.now() - range.ms).toISOString()
    }
    if (hardwareFilter) filters[hardwareFilter.type] = hardwareFilter.value
    return filters
  }

  const fetchAll = async () => {
    try {
      setLoading(true); setError(null)
      const filters = getFilters()
      const [cd, gd, sd] = await Promise.all([
        getCrashes(filters), getCrashGroups(filters).catch(() => ({ groups: [] })), getCrashSummary(filters).catch(() => null)
      ])
      setCrashes(cd.crashes || []); setGroups(gd.groups || []); setSummary(sd)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    if (timeRange === 'custom') {
      if (customFrom || customTo) fetchAll()
    } else {
      fetchAll()
    }
  }, [timeRange, hardwareFilter, customFrom, customTo])

  // Fetch hardware options for the filter dropdown (unfiltered by hardware, respects time range)
  useEffect(() => {
    const timeFilters = {}
    if (timeRange === 'custom') {
      if (customFrom) timeFilters.from = new Date(customFrom).toISOString()
      if (customTo) timeFilters.to = customTo
    } else {
      const range = TIME_RANGES.find(r => r.id === timeRange)
      if (range && range.ms) timeFilters.from = new Date(Date.now() - range.ms).toISOString()
    }
    getCrashSummary(timeFilters).then(s => {
      if (s) setHwOptions({
        gpu: (s.gpu_breakdown || []).map(x => x.name),
        cpu: (s.cpu_breakdown || []).map(x => x.name),
        ram: (s.ram_breakdown || []).map(x => x.name),
        os: (s.os_breakdown || []).map(x => x.name),
      })
    }).catch(() => {})
  }, [timeRange, customFrom, customTo])

  const handleReclassify = async () => {
    if (!confirm('Re-extract and re-categorize all crash reports?')) return
    try { setReclassifying(true); setError(null); await reclassifyCrashes(); await fetchAll() }
    catch (err) { setError('Reclassification failed: ' + err.message) }
    finally { setReclassifying(false) }
  }

  const handleDelete = async (crashId) => {
    await deleteCrash(crashId)
    setCrashes(crashes.filter(c => c.id !== crashId))
    getCrashSummary(getFilters()).then(setSummary).catch(() => {})
  }

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'groups', label: 'Groups', count: groups.length },
    { id: 'hardware', label: 'Hardware' },
    { id: 'reports', label: 'All Reports', count: crashes.length }
  ]

  return (
    <div style={s.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={s.subTabs}>
            {tabs.map(t => (
              <button key={t.id} style={{ ...s.subTab, ...(tab === t.id ? s.subTabActive : {}) }} onClick={() => setTab(t.id)}>
                {t.label}
                {t.count > 0 && <span style={{ marginLeft: '6px', background: tab === t.id ? 'rgba(255,255,255,0.2)' : '#2f3336', padding: '1px 6px', borderRadius: '10px', fontSize: '11px' }}>{t.count}</span>}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '2px', background: '#1a1d21', borderRadius: '8px', padding: '3px', border: '1px solid #2f3336', alignItems: 'center' }}>
            {TIME_RANGES.map(r => (
              <button key={r.id} style={{
                background: timeRange === r.id ? '#2f3336' : 'transparent',
                border: 'none', color: timeRange === r.id ? '#e7e9ea' : '#71767b',
                padding: '4px 10px', cursor: 'pointer', fontSize: '12px', fontWeight: '500', borderRadius: '6px'
              }} onClick={() => setTimeRange(r.id)}>{r.label}</button>
            ))}
            {timeRange === 'custom' && (
              <>
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                  style={dateInputStyle} max={customTo || undefined} />
                <span style={{ color: '#71767b', fontSize: '12px', padding: '0 2px' }}>—</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                  style={dateInputStyle} min={customFrom || undefined} />
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button style={s.refreshBtn} onClick={fetchAll}>Refresh</button>
          <button style={{ ...s.refreshBtn, ...(reclassifying ? { opacity: 0.5 } : {}) }} onClick={handleReclassify} disabled={reclassifying}>
            {reclassifying ? 'Processing...' : 'Reclassify All'}
          </button>
        </div>
      </div>
      {(hardwareFilter || hwOptions) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {hardwareFilter ? (
            <FilterChip label={`${hardwareFilter.type.toUpperCase()}: ${hardwareFilter.value}`} onRemove={() => setHardwareFilter(null)} />
          ) : hwOptions && (
            <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: '#71767b' }}>Filter:</span>
              {[
                { type: 'gpu', label: 'GPU', options: hwOptions.gpu },
                { type: 'cpu', label: 'CPU', options: hwOptions.cpu },
                { type: 'ram', label: 'RAM', options: hwOptions.ram },
                { type: 'os', label: 'OS', options: hwOptions.os },
              ].filter(f => f.options?.length > 0).map(f => (
                <select key={f.type} value="" onChange={e => { if (e.target.value) setHardwareFilter({ type: f.type, value: e.target.value }) }}
                  style={{ ...dateInputStyle, padding: '4px 6px', fontSize: '11px', minWidth: 0 }}>
                  <option value="">{f.label}</option>
                  {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <div style={s.error}>{error}</div>}
      {tab === 'overview' && <CrashOverview summary={summary} loading={loading} onNavigateToGroup={navigateToGroup} />}
      {tab === 'groups' && <CrashGroupsView groups={groups} loading={loading} crashes={crashes} initialExpandedId={focusedGroupId}
        hardwareFilter={hardwareFilter} onHardwareFilter={setHardwareFilter} filters={getFilters()} />}
      {tab === 'hardware' && <HardwareView summary={summary} loading={loading} onHardwareFilter={handleHardwareFilter} />}
      {tab === 'reports' && <AllReports crashes={crashes} loading={loading} onRefresh={fetchAll} onDelete={handleDelete} />}
    </div>
  )
}

export default CrashReports
